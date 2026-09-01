# Running your own world

**Status: twelve of thirteen gates passed, and the thirteenth is waiting on a
clock.** A world ticks, persists to Postgres, and comes back where it was
after a hard kill; every system in CLAUDE.md §6 is built and gated. Phase 12 —
this document's own subject — is deployed and running as a season: identity
armed, backups verified, a watchdog on a two-minute timer, and
`scripts/phase12-gate.mjs` passing every leg but the seven days it has to wait
out. The one piece still missing is TLS, and it is missing because of a DNS
record nobody has been able to create.

```bash
docker compose up -d          # Postgres, and a world on ws://localhost:3000/ws
curl -s localhost:3000/health # tick, lag, snapshot age
npm run start:client          # the map, at http://localhost:9000
```

The client is not in the compose file. In development Vite serves it and
proxies `/ws` to port 3000; in production a reverse proxy puts the built bundle
and this socket on one hostname, which is the part below.

To play a nation rather than watch, open `http://localhost:9000/?nation=1`.
**On a workbench world that is the whole of authentication**, and deliberately
so: every gate depends on being able to be anybody. A real deployment sets
`WORLD_SEASON=open` (see the table below), which arms accounts — a nation then
needs a token, one account holds one nation, and a bare URL gets you a
spectator. That is phase 11, and it is done (decision 0019). A world exposed to
the internet without the flag is the anybody-is-everybody world §8 warns about.

**Verify a deployment the way the gate does:**

```bash
node scripts/phase1-gate.mjs
```

It claims a province, waits for a real snapshot, claims another one _after_
that snapshot, kills the container with SIGKILL, starts it again, and checks
that the world resumes at the right tick and replays into exactly the same
state it was in. It takes a few minutes because it waits for a real snapshot
rather than shortening the interval: a gate that runs against a special
configuration proves something about the special configuration.

## Configuration

| Variable            | Default     | What it is                                                                                                                                                                                                                                                        |
| ------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | _(unset)_   | Postgres. **Unset means the world is not persisted** and says so at startup.                                                                                                                                                                                      |
| `WORLD_ID`          | `world-0`   | Which world this process ticks. Also the advisory-lock key.                                                                                                                                                                                                       |
| `MAP_ID`            | `europe`    | Must be one of the maps built into the image (`WORLD_MAPS`).                                                                                                                                                                                                      |
| `PORT`              | `3000`      | `/ws` and `/health` share it.                                                                                                                                                                                                                                     |
| `WORLD_MAPS`        | `europe`    | Build argument. `resources/maps` is 511 MB across ~120 maps and an image hosts one world; only these are kept.                                                                                                                                                    |
| `POSTGRES_PASSWORD` | `openfront` | Compose only. Change it for anything reachable.                                                                                                                                                                                                                   |
| `WORLD_SEASON`      | _(unset)_   | **Set to `open` on every real deployment.** Arms identity (accounts required, one nation per account, decision 0019) and hands every unclaimed nation to its regent. Unset, the world is a workbench where anybody is everybody — the exact state §8 warns about. |
| `BACKUP_INTERVAL_S` | `86400`     | Backup sidecar: seconds between verified dumps.                                                                                                                                                                                                                   |
| `BACKUP_KEEP`       | `14`        | Backup sidecar: how many verified dumps rotation keeps.                                                                                                                                                                                                           |

## What it needs

- A Linux host with Docker and Docker Compose.
- **Postgres.** One instance for this stack. The world lives in memory and is
  persisted as an append-only command log plus a snapshot every 60 ticks; on
  restart it reloads the newest snapshot and replays the commands after it.
- **A reverse proxy that terminates TLS and forwards a WebSocket.** This is the
  part people get wrong, so it is spelled out below.
- Modest resources. A world of ~800 provinces and a few dozen nations is small:
  the state is kilobytes, and a tick costs single-digit milliseconds. The
  server is a single process — there is no cluster, no shard and no worker
  pool.

## One world, one process

The server takes a Postgres advisory lock on its `WORLD_ID` at startup and
refuses to run if it cannot get it. Two processes ticking one world would both
append to its command log, and afterwards the log would describe a run neither
of them had; there is no repair for that.

The lock is held on a connection of its own, outside the pool, for the life of
the process. If that connection drops the server stops, because from that
moment nothing is keeping a second one out.

Two consequences worth planning for:

- **A rolling deployment does not work.** The new container cannot start while
  the old one holds the lock. Stop, then start.
- **A restart is cheap and safe.** The world reloads its newest snapshot,
  replays the commands after it, and resumes at that tick. It never re-simulates
  the time it was down.

## The client bundle needs one step the build does not do

`vite build` leaves EJS placeholders in `static/index.html` —
`assetManifest`, `cdnBase`, `gameEnv`, `cdnBaseRaw`. Upstream filled them per
request from an Express process, and this fork has no such process: a reverse
proxy serves a static bundle and does not run a template engine.

Unrendered, the module script tag's `src` is the literal string
`<%- locals.cdnBaseRaw || "" %>/assets/index-*.js`. The browser fetches
nothing and the page is blank, with no console error worth the name.

```bash
npm run build-prod
node scripts/render-index.mjs static/index.html
```

The script is idempotent and **refuses to write** if it finds a placeholder it
does not know about, rather than shipping the failure it exists to prevent.

**Ship only the map the world runs on.** `static/` is well over half a
gigabyte across ~120 maps; one world uses one of them, and filtered it is
around 60 MB. Watch the rsync rule order when you do it — the first matching
rule wins, so an `--exclude` placed before its `--include` swallows it:

```bash
rsync -az --exclude='_assets/maps/*' static/ HOST:/srv/world/www/
rsync -az static/_assets/maps/ HOST:/srv/world/www/_assets/maps/ < map > / < map > /
```

## The files a host needs

`deploy/` holds the four artefacts a deployment needs and a checkout does not.
Three are templates with `<PLACEHOLDER>`s, because the concrete values are host
specifics and this repository is public:

| File                                            | Goes to                                             | What it is for                                              |
| ----------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `deploy/docker-compose.override.example.yml`    | the checkout root, as `docker-compose.override.yml` | loopback ports, a restart policy, `WORLD_SEASON=open`       |
| `deploy/nginx/world.conf.example`               | `/etc/nginx/sites-available/`                       | the bundle, `/ws`, `/register`, `/health`                   |
| `deploy/watchdog.sh`                            | `/usr/local/bin/world-watchdog`                     | alerts when the world stops ticking, or a backup goes stale |
| `deploy/systemd/world-watchdog.{service,timer}` | `/etc/systemd/system/`                              | runs the watchdog every two minutes                         |

The sections below say why each is shaped the way it is. Read them before
copying: two of the four have a failure mode that looks like success.

## Bind the containers to loopback

The compose file in this repository publishes Postgres on `0.0.0.0:5432` and
the world on `0.0.0.0:3000`, because tests and `psql` reach them from the host
in development. **On a machine with a public address that is a database on the
internet.** Override both in a `docker-compose.override.yml` on the host, and
note that Compose _merges_ port lists by default — replacing them needs
`!override`:

```yaml
services:
  db:
    ports: !override
      - "127.0.0.1:55434:5432"
    restart: unless-stopped
  world:
    ports: !override
      - "127.0.0.1:3100:3000"
    restart: unless-stopped
```

Then **verify the result rather than the intent** — `docker compose config`
prints the ports that will actually be published. And do not read the firewall
as the list of what is exposed: Docker writes its own iptables rules and a
published port is reachable whether or not ufw ever allowed it.

The shipped file has no restart policy on purpose, because the phase-1 gate is
to kill the world by hand. A host wants the opposite.

## The reverse proxy, in detail

A world connection is a WebSocket that stays open for hours and is mostly
silent. Two things follow.

**The upgrade must actually pass through.** In nginx that means, in `http`
context:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

and in the location that proxies the world server:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout  3600s;
proxy_send_timeout  3600s;
proxy_buffering     off;
```

Verify it with a real handshake rather than a status code — a `200` means the
upgrade was swallowed and the client will wait forever:

```bash
curl -i --max-time 5 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://your.domain/ws | head -1
# want: HTTP/1.1 101 Switching Protocols
```

**Something must keep the connection alive.** Proxies and NAT devices drop idle
connections, and a world socket can be silent for a long time. The server pings
periodically; if you put another timeout in front of it, make sure it is longer
than that interval.

## If port 443 is already taken

On a host where another service already owns 443 — for example an nginx
`stream` block doing SNI passthrough — an HTTP vhost cannot bind it. The pattern
that works is: the vhost listens on a **private loopback port** with
`proxy_protocol`, and the SNI router forwards to it by hostname.

Two traps worth knowing, both of which cost real time to diagnose:

- A `listen 443` in `http` context **passes `nginx -t`** and then fails the
  _reload_ with `still could not bind()`. systemd reports success, the old
  configuration keeps serving, and nothing looks wrong. After any reload, prove
  the socket is there: `ss -tlnp 'sport = :<your port>'` and check the nginx
  journal for `could not bind`.
- If the router sets `proxy_protocol on`, the vhost listener must say
  `proxy_protocol` too, and set `set_real_ip_from` plus `real_ip_header` to
  `proxy_protocol` — otherwise every client appears to come from `127.0.0.1`.

## What a restart costs

The world lives in memory. Two things are written down: every accepted command,
immediately, tagged with the tick it takes effect on; and a full snapshot every
60 ticks — five minutes.

So a hard crash costs **up to five minutes of simulation, and no player
command**. The world comes back at the later of the newest snapshot and the
newest logged command, which is generally a few ticks behind where it died.
That is deliberate, and
[decision 0005](../decisions/0005-resume-at-the-last-durable-record.md) says
why. After a restart the number to check is the **tick**, not the wall clock:
game time and real time are not the same clock and are not meant to be.

## Backups

The world is in memory; the database is the only durable copy. The stack
carries its own sidecar now (`backup` in `docker-compose.yml`,
`docker/backup/backup.sh`): a `pg_dump -Fc` every `BACKUP_INTERVAL_S`
seconds into the `world-backups` volume, `pg_restore --list` as a **hard
abort** — a dump that fails verification is renamed `.bad` and the service
exits non-zero, where the watchdog can see it — and rotation keeping the
newest `BACKUP_KEEP` verified dumps.

Take one on demand:

```bash
docker compose run --rm backup --once
```

**Test a restore once, before you need it** — an untested backup is a
belief, not a backup. This exact sequence was run on 2026-09-01 and came
back with every table intact:

```bash
docker compose run --rm --entrypoint sh backup -c '
  latest=$(ls -1t /backups/world-*.dump | head -1)
  dropdb --if-exists restore_check && createdb restore_check
  pg_restore -d restore_check "$latest"
  psql -d restore_check -tc "select count(*) from commands"
  psql -d restore_check -tc "select count(*) from snapshots"
  dropdb restore_check && echo RESTORE-OK'
```

For a real recovery, restore into a fresh `openfront` database the same way
and start the world against it; it resumes at the newest snapshot in the
dump plus the commands after it (decision 0005).

## Monitoring

A world with no players online still has to be ticking. A status-code check
proves only that the process accepts connections, which is the wrong question —
the interesting failure is a world that is up and _stuck_.

`GET /health` therefore reports the current tick, how far behind schedule it
is, the age of the last snapshot, how many snapshot writes have failed in a
row, and the state hash. It returns **503** when the loop is more than three
ticks behind, when a snapshot write has failed, or when the newest snapshot is
more than three intervals old.

```json
{
  "worldId": "world-0",
  "healthy": true,
  "tick": 1043,
  "lagMs": 0,
  "lastSnapshotTick": 1020,
  "snapshotAgeTicks": 23,
  "snapshotFailures": 0,
  "connections": 3,
  "stateHash": "b7fd6310",
  "provinces": 529
}
```

Check the _content_, not just the code — but the code is now worth something
too, which it was not before.

## Private notes

Deployment details for a specific machine — hostnames, ports, paths, alert
topics — belong in `docs/deploy/HOST.local.md`, which is git-ignored. This
repository is public; nothing host-specific goes in it. See
[`../README.md`](../README.md) for the rule.
