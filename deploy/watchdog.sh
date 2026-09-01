#!/bin/sh
# Alert when the world stops ticking (CLAUDE.md §8, phase 12).
#
# The world can be up and dead at the same time: the container runs, the port
# answers, and the tick has not moved in an hour. `/health` is what tells the
# two apart, and nothing on the host reads it. This does, every two minutes,
# from a systemd timer.
#
# It also watches the backup sidecar, because that has a silent failure of its
# own: `docker/backup/backup.sh` aborts with exit 1 when a dump fails its
# integrity check, and `restart: unless-stopped` then starts it again. The
# stack recovers, nobody is told, and the person who finds out is the one who
# needed the restore.
#
#   deploy/watchdog.sh            # one check
#   deploy/watchdog.sh --test     # send a test alert and exit
#
# Configuration comes from the environment, normally
# /etc/world-watchdog.env (mode 600, host-local — the topic is a URL anybody
# who knows it can post to, so it does not belong in this repository):
#
#   WORLD_HEALTH_URL   default http://127.0.0.1:3000/health
#   NTFY_URL           e.g. https://ntfy.sh   (unset: log only, never alert)
#   NTFY_TOPIC         the topic to publish to
#   WATCHDOG_STATE     default /var/lib/world-watchdog/state
#   MAX_LAG_MS         default 30000 — a tick is 5000ms; six late is a problem
#   BACKUP_DIR         optional; if set, the newest dump must be younger than
#                      MAX_BACKUP_AGE_H (default 30, giving a daily dump slack)
#
# **It alerts on a change of state, not on every failed check.** A world that
# is down for a day would otherwise send 720 notifications, and the 720th is
# read as carefully as the second. Recovery is announced once, too, because an
# alert with no all-clear trains you to ignore alerts.
#
# ---------------------------------------------------------------------------
# NOT YET RUN ON A HOST. Written on a machine with no systemd and no nginx.
# `sh -n` is the only check it has passed. Run `--test` on the host first: it
# proves the alert path end to end, which is the half that fails silently.
# ---------------------------------------------------------------------------

set -eu

: "${WORLD_HEALTH_URL:=http://127.0.0.1:3000/health}"
: "${WATCHDOG_STATE:=/var/lib/world-watchdog/state}"
: "${MAX_LAG_MS:=30000}"
: "${MAX_BACKUP_AGE_H:=30}"
: "${NTFY_URL:=}"
: "${NTFY_TOPIC:=}"
: "${BACKUP_DIR:=}"

log() { echo "[watchdog] $*"; }

# ntfy, if configured. Deliberately never fatal: an unreachable notification
# service must not take down the thing that notices problems.
notify() {
    priority="$1"
    title="$2"
    body="$3"

    log "$title — $body"
    if [ -z "$NTFY_URL" ] || [ -z "$NTFY_TOPIC" ]; then
        log "NTFY_URL/NTFY_TOPIC unset — not sending"
        return 0
    fi

    if ! curl -fsS --max-time 10 \
        -H "Title: $title" \
        -H "Priority: $priority" \
        -d "$body" \
        "$NTFY_URL/$NTFY_TOPIC" > /dev/null; then
        log "WARNING: could not reach $NTFY_URL — alert not delivered"
    fi
}

# One field out of the health JSON. No jq: it is not installed everywhere and
# this reads four numbers out of a flat object.
field() {
    printf '%s' "$1" | tr -d ' \n' \
        | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p"
}

if [ "${1:-}" = "--test" ]; then
    notify default "World watchdog test" \
        "If you are reading this, the alert path works. $(date -u +%FT%TZ)"
    exit 0
fi

mkdir -p "$(dirname "$WATCHDOG_STATE")"

# Previous state: "<status> <tick>". Absent on the first run, which counts as
# healthy so a fresh install does not announce itself as a recovery.
prev_status="ok"
prev_tick="-1"
if [ -f "$WATCHDOG_STATE" ]; then
    read -r prev_status prev_tick < "$WATCHDOG_STATE" || true
fi

status="ok"
problem=""

body=$(curl -fsS --max-time 10 "$WORLD_HEALTH_URL" 2> /dev/null) || body=""

if [ -z "$body" ]; then
    status="down"
    problem="No answer from $WORLD_HEALTH_URL."
    tick="$prev_tick"
else
    tick=$(field "$body" tick)
    lag=$(field "$body" lagMs)
    healthy=$(field "$body" healthy)
    snapshot_failures=$(field "$body" snapshotFailures)
    : "${tick:=-1}"
    : "${lag:=0}"
    : "${healthy:=false}"
    : "${snapshot_failures:=0}"

    if [ "$healthy" != "true" ]; then
        status="unhealthy"
        problem="/health reports healthy=$healthy at tick $tick."
    elif [ "$prev_tick" != "-1" ] && [ "$tick" -le "$prev_tick" ]; then
        # The one this exists for. The process is alive and the world is not.
        status="stalled"
        problem="Tick has not moved since the last check: still $tick."
    elif [ "$lag" -gt "$MAX_LAG_MS" ]; then
        status="lagging"
        problem="Tick lag ${lag}ms exceeds ${MAX_LAG_MS}ms at tick $tick."
    elif [ "$snapshot_failures" -gt 0 ]; then
        status="snapshots"
        problem="$snapshot_failures snapshot failure(s) at tick $tick."
    fi
fi

# The backup half. Only when the world itself is fine, so one outage does not
# produce two alerts saying the same thing.
if [ "$status" = "ok" ] && [ -n "$BACKUP_DIR" ]; then
    if [ -n "$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump.bad' -print -quit 2> /dev/null)" ]; then
        status="backup"
        problem="A dump failed its integrity check and was renamed .bad in $BACKUP_DIR."
    elif [ -z "$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' \
        -mmin "-$((MAX_BACKUP_AGE_H * 60))" -print -quit 2> /dev/null)" ]; then
        status="backup"
        problem="No verified dump in $BACKUP_DIR newer than ${MAX_BACKUP_AGE_H}h."
    fi
fi

printf '%s %s\n' "$status" "$tick" > "$WATCHDOG_STATE"

if [ "$status" != "ok" ]; then
    if [ "$status" != "$prev_status" ]; then
        notify high "World: $status" "$problem"
    else
        log "still $status (already alerted) — $problem"
    fi
    exit 1
fi

if [ "$prev_status" != "ok" ]; then
    notify default "World: recovered" "Ticking again at $tick."
else
    log "ok at tick $tick"
fi
