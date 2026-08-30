# 0006 — The province partition is checked-in map data, not a startup computation

- **Status:** Accepted
- **Date:** 2026-08-30
- **Phase:** 2

## Context

Phase 0 and 1 derived the province partition at startup, on both sides:
`computeProvincePartition` ran over `map4x.bin` in the world server and again in
the browser, and the two were trusted to agree because they ran the same
function over the same bytes. A terrain hash in the opening state caught the
case where they read _different_ bytes.

Nothing caught the case where they ran _different code_. A world runs for six
weeks while we deploy into it, and a player holds a cached bundle. The moment
the partition function changes — a bug fix, a tuning change, a different target
province size — the ids stop meaning the same places. Every province id in the
command log, in every snapshot, and in every ownership delta silently refers to
somewhere else. There is no repair, and no symptom other than a world that
looks plausible and is wrong.

The province attributes phase 2 adds make this worse, not better: terrain,
infrastructure, building slots and resource deposits are now the _geography a
season is played on_. A nation short of steel is short of steel because of a
number this code produced, and that number cannot be allowed to move underneath
a running world.

## Decision

Generate it once, check it in, and load it.

- `npm run gen-provinces` writes two files next to the terrain bytes:
  `resources/maps/<id>/provinces.bin` (a 32-byte header plus one `Uint16` per
  tile, carrying the land partition and the sea zones together) and
  `provinces.json` (the per-province record — neighbours, terrain,
  infrastructure, building slots, deposits, air and sea zone).
- The world server and the client both **load** it. Neither partitions
  anything at startup.
- `partitionHash`, FNV-1a over the whole binary, travels in the opening state.
  The client refuses a map whose artefact does not hash to what the world is
  running, exactly as it already refuses a terrain mismatch.
- The world refuses a snapshot taken on a different `partitionHash`.
- `tests/shared/ProvinceArtifact.test.ts` regenerates Europe and compares it
  byte for byte with what is checked in, so a change to the generator that
  nobody regenerated for goes red rather than silent.

`computeProvincePartition` survives, as the generator's input. It is no longer
on any startup path.

## Alternatives rejected

- **Keep deriving, and version the algorithm.** A version number in the
  handshake would catch the mismatch, but only by refusing to run — and it
  still leaves the running season's ids defined by code rather than by data. A
  world already in progress could then never take a generator fix at all.
- **Store the partition in Postgres with the world.** It is map data, not world
  state: identical for every world on that map, and something a human should be
  able to read, diff and review before a season starts. Putting it in the
  database also means the client cannot have it, and the client needs it to
  paint tiles.
- **Ship only the JSON and derive the tile array from it.** The tile array is
  the expensive half and the one that cannot be derived from anything smaller.

## Consequences

- Europe's artefact is 2.3 MB of binary and 213 kB of JSON in the repository.
  It compresses well — it is made of long runs — and `map.bin` beside it is
  4.9 MB. One artefact per map a world can actually run on, not all 120.
- Startup is faster on both sides: no 368 ms partition pass.
- **Changing the generator is now a two-part commit**: the code and the
  regenerated artefact, or the guard test fails. That is the friction this
  decision is for.
- A world already running on an artefact cannot take a regenerated one. It
  refuses its own snapshots and stops. That is the correct behaviour and it
  means a partition change is a new season, which is what it always was —
  previously without saying so.
- Water is partitioned into sea zones by the same generator, carried in the
  spare bit of the same `Uint16`. Phase 9 will want water _provinces_ as well;
  that is a format version bump, and the format has a version field for it.
