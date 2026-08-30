# Upstream documentation — inherited, not maintained

These files came with the fork. They describe **OpenFront as it is upstream**,
not this project, and they are kept because they are useful for understanding
the code we inherited — not because they are true of MaxEdit.

Several of them describe exactly the architecture this fork is dismantling.
`Architecture.md` opens by explaining that the simulation runs on every client
in deterministic lockstep and the server only relays intents. That is upstream's
design; ours is the opposite. Reading it as if it described this repository
would be actively misleading, which is why it lives here rather than one
directory up.

| File                    | What it describes                                             | Still true here?                                          |
| ----------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `upstream-dev-notes.md` | Upstream's developer notes: commands, architecture, key files | Commands yes, architecture no                             |
| `Architecture.md`       | Client-side lockstep, intents, turn relay                     | **No** — inverted by this fork                            |
| `GameServerRefactor.md` | The match server's lobby/turn lifecycle                       | **No** — that server is being deleted                     |
| `Auth.md`               | JWT flow against the closed-source API worker                 | **No** — replaced by our own accounts                     |
| `API.md`                | Public endpoints of the closed-source API                     | **No** — not part of this fork                            |
| `Maps.md`               | The Go map generator                                          | **Yes** — we keep the generator and the map format        |
| `CONTRIBUTING.md`       | Upstream's workflow, CLA and governance                       | **No** — see our [CONTRIBUTING.md](../../CONTRIBUTING.md) |

Two of them are worth reading before touching the corresponding code:
`Maps.md` (still accurate) and the renderer section of
`upstream-dev-notes.md`. The rest are
historical.

Upstream's developer notes were renamed from `CLAUDE.md` to
`upstream-dev-notes.md` on purpose: a file with that name anywhere in the tree
is loaded automatically as project instructions, and this one states that the
simulation runs on each client — the opposite of what we are building. Leaving
it named `CLAUDE.md` would have fed every future session a contradiction.

Nothing here is updated. When a document becomes wrong _about upstream_ it
simply means upstream moved on; this is a snapshot of the fork point.
