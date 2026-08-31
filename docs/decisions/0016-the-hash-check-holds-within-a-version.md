# 0016 — The state-hash check holds within a hash version, not across one

- **Status:** Accepted
- **Date:** 2026-08-31
- **Phase:** 8→ (decided between phases, before the front work changed the hash)

## Context

The restore refuses a snapshot whose recorded hash does not match what the
code computes for it. That check is what the phase-1 gate stands on: a restore
that produces a _plausible_ world rather than _the_ world is caught by exactly
one line.

But `stateHash()` mixes every field the simulation owns, so most simulation
changes change what every existing snapshot hashes to. Phase 5 added research
to the hash and the running world refused to start with "the stored state is
damaged" — nothing was damaged; the function had changed, and the check cannot
tell the two apart. Locally the answer is `docker compose down -v`. On a live
season there was no answer at all: no change touching the state hash could
ever be deployed without ending the season.

HANDOVER.md carried this as an open question because it changes what
persistence promises. Max decided on 2026-08-31: build the version.

## Decision

`STATE_HASH_VERSION` lives beside `stateHash()` in `World.ts` and is written
into every snapshot (`WorldSnapshot.hashVersion`). The restore compares hashes
only when the snapshot's version equals the code's:

- **Same version, different hash** — still a hard refusal. The function that
  wrote the number is the function checking it, so a mismatch means the stored
  state really did come back different.
- **Different version** — the snapshot is accepted and a loud
  `state-hash check skipped` line says so, including both versions. The next
  snapshot is written under the new version, which re-arms the check.
- **No version field** — read as version 1. The function did not change
  between the last unversioned build and version 1 being written down, so the
  corruption check holds across that boundary instead of lapsing.

The version is in the snapshot JSON, not a database column: the store has no
opinion about hashes, and the comparison happens in `WorldRunner.restore`.

**The contract for changing the hash function is now: bump
`STATE_HASH_VERSION` in the same commit.** A hash change without a bump turns
the next deploy's restore into a false "damaged" refusal — exactly the failure
this decision removes.

## Alternatives rejected

- **Keep `down -v` as the answer.** Ends a season on every simulation deploy.
  The whole point of a persistent world is that it persists.
- **Migrate snapshots on version change.** A migration per hash change is a
  migration per simulation change, and it would have to be proven against a
  live season's data every time. The skip costs one restore's worth of
  corruption blindness — bounded, logged, and re-armed sixty ticks later.
- **Drop the check entirely.** The phase-1 gate is built on it, and within a
  version it still catches real corruption for free.

## Consequences

- A season survives a deploy that touches the state hash. The one load
  immediately after such a deploy is not corruption-checked, and the log says
  so rather than pretending otherwise.
- `tests/server/Restore.test.ts` holds all three rules: same-version mismatch
  refused, cross-version accepted with the warning, missing field checked as
  version 1.
