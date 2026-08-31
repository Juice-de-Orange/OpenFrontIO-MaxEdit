# Running your own world

**Status: it runs locally.** Phase 1 is done: a world ticks, persists to
Postgres, and comes back where it was after a hard kill.

```bash
docker compose up -d          # Postgres, and a world on ws://localhost:3000/ws
curl -s localhost:3000/health # tick, lag, snapshot age
npm run start:client          # the map, at http://localhost:9000
```

The client is not in the compose file. In development Vite serves it and
proxies `/ws` to port 3000; in production a reverse proxy puts the built bundle
and this socket on one hostname, which is the part below.

To play a nation rather than watch, open `http://localhost:9000/?nation=1`.
**That is the whole of authentication.** Accounts belong with the registration
screen rather than ahead of it, so they are still an open question in
`HANDOVER.md` — and a world exposed to the internet needs them settled first.

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

| Variable            | Default     | What it is                                                                                                     |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | _(unset)_   | Postgres. **Unset means the world is not persisted** and says so at startup.                                   |
| `WORLD_ID`          | `world-0`   | Which world this process ticks. Also the advisory-lock key.                                                    |
| `MAP_ID`            | `europe`    | Must be one of the maps built into the image (`WORLD_MAPS`).                                                   |
| `PORT`              | `3000`      | `/ws` and `/health` share it.                                                                                  |
| `WORLD_MAPS`        | `europe`    | Build argument. `resources/maps` is 511 MB across ~120 maps and an image hosts one world; only these are kept. |
| `POSTGRES_PASSWORD` | `openfront` | Compose only. Change it for anything reachable.                                                                |

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

The world is in memory; the database is the only durable copy. Whatever you
already run is fine, but two things are worth doing regardless:

- Put the backup **inside the stack** as a sidecar rather than as a cron job on
  the host. A stack that carries its own backup keeps working when it moves.
- **Test a restore once**, before you need it. An untested backup is a belief,
  not a backup. Restore into a scratch database, start a world from it, and
  compare its state hash against the source.

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
