#!/bin/sh
# The world's backup, inside its own stack (CLAUDE.md §8, phase 12).
#
# Whatever backup mechanism a host "already has" may not exist — that is the
# first thing phase 12's notes warn a deployment about — so this stack
# carries its own: a nightly `pg_dump` in custom format, an integrity check
# as a HARD abort, and rotation. A backup that was never verified is a hope,
# not a backup, and a failed verification must be loud rather than quietly
# rotating good dumps away.
#
# Runs in a loop inside the `backup` service (docker-compose.yml). One dump
# every BACKUP_INTERVAL_S seconds (default: a day), keeping BACKUP_KEEP
# verified dumps (default: 14). To restore, see docs/deploy/README.md —
# and test a restore once, before it matters.

set -eu

: "${PGHOST:=db}"
: "${PGUSER:=openfront}"
: "${PGDATABASE:=openfront}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_INTERVAL_S:=86400}"
: "${BACKUP_KEEP:=14}"

mkdir -p "$BACKUP_DIR"

backup_once() {
    stamp=$(date -u +%Y%m%d-%H%M%S)
    file="$BACKUP_DIR/world-$stamp.dump"

    echo "[backup] dumping $PGDATABASE to $file"
    pg_dump -Fc -f "$file" "$PGDATABASE"

    # **The integrity check is the backup.** `pg_restore --list` parses the
    # whole archive's table of contents; a truncated or corrupt dump fails
    # here, the bad file is renamed so nobody restores it by accident, and the
    # service exits non-zero — which is what makes the failure visible to the
    # watchdog instead of to the person who needed the restore.
    if ! pg_restore --list "$file" > /dev/null; then
        mv "$file" "$file.bad"
        echo "[backup] INTEGRITY CHECK FAILED: $file.bad — aborting" >&2
        exit 1
    fi
    echo "[backup] verified $(du -h "$file" | cut -f1) $file"

    # Rotation, verified dumps only: the newest BACKUP_KEEP stay.
    ls -1t "$BACKUP_DIR"/world-*.dump 2> /dev/null \
        | tail -n +"$((BACKUP_KEEP + 1))" \
        | while read -r old; do
            echo "[backup] rotating out $old"
            rm -f "$old"
        done
}

if [ "${1:-}" = "--once" ]; then
    backup_once
    exit 0
fi

while :; do
    backup_once
    sleep "$BACKUP_INTERVAL_S"
done
