# Running your own world

**Status: not yet possible.** The persistent world server arrives in phase 1.
Today the tree still boots upstream's match server, so there is nothing
world-shaped to deploy. This page records what the deployment will require, so
the constraints are known before the code exists — and so anyone who wants to
host their own world can see early whether their setup fits.

## What it will need

- A Linux host with Docker and Docker Compose.
- **Postgres.** One instance for this stack. The world lives in memory and is
  persisted as an append-only command log plus a snapshot every 60 ticks; on
  restart it reloads the newest snapshot and replays the commands after it.
- **A reverse proxy that terminates TLS and forwards a WebSocket.** This is the
  part people get wrong, so it is spelled out below.
- Modest resources. A world of ~800 provinces and a few dozen nations is small:
  the state is kilobytes, and a tick is expected to cost single-digit
  milliseconds. The server is a single process — there is no cluster, no shard
  and no worker pool.

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

The health endpoint therefore reports the current tick, how far behind schedule
it is, and the age of the last snapshot, and returns a failure status when the
tick stalls or snapshots stop. Check that endpoint's _content_, not just its
code.

## Private notes

Deployment details for a specific machine — hostnames, ports, paths, alert
topics — belong in `docs/deploy/HOST.local.md`, which is git-ignored. This
repository is public; nothing host-specific goes in it. See
[`../README.md`](../README.md) for the rule.
