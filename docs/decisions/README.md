# Decision records

Short documents recording a decision that was not obvious, written when it was
taken. Numbered, immutable, append-only.

**Why bother:** the expensive part of a decision is not the conclusion, it is
the alternatives you considered and rejected. That knowledge has a half-life of
about a week. Six months later someone — quite possibly you — looks at an odd
piece of design, assumes it was an accident, "fixes" it, and rediscovers the
original problem the hard way.

## When to write one

Write a record when the answer to _"why is it like this?"_ is not visible from
the code, and:

- a plausible alternative was rejected, or
- the decision constrains future work, or
- it contradicts the specification, an assumption, or an earlier record, or
- it was made under uncertainty and might need revisiting.

Do **not** write one for a decision the code explains by itself.

## Rules

- **Never edit a record's decision.** If you change your mind, write a new
  record and mark the old one `Superseded by NNNN`. The wrong turn is part of
  the history and is often the most useful part.
- Number sequentially, four digits. Filename `NNNN-short-slug.md`.
- Status is one of `Accepted`, `Superseded by NNNN`, `Reverted`.
- Keep it short. If it needs more than a page, the decision is probably two
  decisions.

## Template

```markdown
# NNNN — <the decision, as a statement>

- **Status:** Accepted
- **Date:** YYYY-MM-DD
- **Phase:** <n>

## Context

What forced a choice. Include the measurement or observation that prompted it,
with its method — not just the conclusion.

## Decision

What we do, in the active voice.

## Alternatives rejected

Each with the reason. This is the part future readers actually need.

## Consequences

What this makes easy, what it makes hard, and what it forecloses.
```

## Index

| #                                                          | Decision                                                                  | Status   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [0001](0001-break-core-client-import-cycle.md)             | Break the `core`↔`client` cycle by moving terrain primitives to `shared/` | Accepted |
| [0002](0002-province-is-the-state-tiles-are-projection.md) | Province ownership is the state; tiles are projected from it              | Accepted |
| [0003](0003-tick-anchored-time.md)                         | Time is tick-anchored; downtime is never re-simulated                     | Accepted |
| [0004](0004-renderer-owns-its-vocabulary.md)               | The renderer owns its own vocabulary                                      | Accepted |
| [0005](0005-resume-at-the-last-durable-record.md)          | A world resumes at its last durable record, not at the tick it died on    | Accepted |
| [0006](0006-the-partition-is-checked-in-map-data.md)       | The province partition is checked-in map data, not a startup computation  | Accepted |
| [0007](0007-events-apply-between-systems.md)               | A system's events are applied before the next system runs                 | Accepted |
| [0008](0008-manpower-is-a-population-cap.md)               | Manpower is a population-scaled cap, not a conscription law               | Accepted |
| [0009](0009-a-factory-is-fed-by-what-it-makes.md)          | A factory is fed by what it makes, and an idle one still eats             | Accepted |
| [0010](0010-research-modifiers-are-read-not-stored.md)     | Research modifiers are read where the rate is read, never stored          | Accepted |
| [0011](0011-an-agreement-is-accumulated-commands.md)       | An agreement is accumulated commands, never a server-side side effect     | Accepted |
| [0012](0012-a-dead-partner-is-measured-in-real-days.md)    | A dead partner is seven real days silent, not fourteen in-game ones       | Accepted |
| [0013](0013-identity-is-a-phase-not-a-deferral.md)         | Identity is a phase of its own, ahead of deployment                       | Accepted |
| [0014](0014-the-border-drift-gives-way-to-a-front.md)      | The border drift gives way to a front; an unattended world is quiet       | Accepted |
