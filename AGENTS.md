# AGENTS.md

Everything an agent needs to work in this repository, in the order it needs it.
The root [README.md](README.md) has the vision; this file has the map.

## What this is

**A native pixel RPG that happens to run inside a browser** — not a React
website with a game embedded in it. An agent claims bounties on real GitHub
issues, opens a PR, earns XP, and battles other agents.

## The one rule that overrides everything else below

**The browser is the runtime. The game is the product.** There is no "plain web
plus an embedded game" in this product; the whole application IS the game.

The full doctrine is [docs/design/game-first-doctrine.md](docs/design/game-first-doctrine.md)
and it is binding. The four that break most often:

- **`/` is the game.** Fullscreen, `position: fixed; inset: 0`, no layout above
  it. Not a dashboard, not a redirect into one.
- **Scene, not route.** City / Arena / Guild Hall are state. A scene switch keeps
  the PixiJS application, the world store, the SSE connection, the asset cache and
  the camera. It is `GameClient.rebindView()`, never a navigation.
- **Every feature has a place in the world.** A bounty is a notice board. A
  profile is a character sheet. Settings is the pause menu. If you cannot say
  where in the world a feature lives, it is not finished.
- **No SaaS chrome.** No navbar, no sidebar, no card grid, no table doing the
  work of a game screen. If a screen looks like Linear or Notion it is wrong, no
  matter how clean it is.

`scripts/check-game-first.sh` enforces the first two mechanically and runs in the
M0 gate. **A green suite with a red `check-game-first` is a broken gate, not a
passing build.** When you add a screen, the gate is the place that has to learn
it exists — not the place to be worked around.

Assets from `.tmp` and the vendored packs under `apps/web/public/art/` are the
source of truth. A procedurally drawn shape where art already exists is a bug
with a licence file next to it, and this repository has shipped that bug
through a fully green test suite.

## Before you write code

```bash
pnpm install
docker compose -f compose.yaml -f compose.test.yaml up -d --wait
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/battle_test
pnpm db:migrate && pnpm db:seed
```

`pnpm test:m0` is the whole gate. It is the same command CI runs, in the same
images. Budget several minutes; use the targeted stages while iterating.

## The one rule that is not negotiable

```
presentation  ->  features  ->  core  <-  infrastructure
```

- **features never import each other.** A feature that needs another feature's
  data subscribes to its events or declares `requires` and degrades.
- **adapters import `core` and `protocol` and nothing else.**
- **`core` knows no game vocabulary.** A unit test in
  `tests/unit/scaffold.test.ts` strips comments and literals, then fails on a
  Bounty, Guild, Battle, XP or Quest identifier in `packages/core`. The words
  appear in comments there, because the comments explain the rule; what must not
  exist is the code. This is checked by `pnpm test:unit`, not by
  `pnpm architecture`.

Adding a feature is a new package and a manifest entry. **A change that has to
edit `core/`, `cli/` or `mcp/` is an architecture failure.** That is not a
preference; the plan freezes those three deliberately, and review rejects the PR.

## Where things are

| Path                           | What lives there                                      |
| ------------------------------ | ----------------------------------------------------- |
| `packages/core/src/`           | primitives, the Extension API, the hook-provider seam |
| `packages/protocol/src/`       | the AgentEvent union, tool-name normalization         |
| `packages/features/<concept>/` | one package per game concept                          |
| `packages/adapters/<harness>/` | one package per coding harness                        |
| `packages/api/src/`            | the Application API every surface calls               |
| `packages/db/src/`             | Drizzle schema and repositories                       |
| `apps/web/`                    | Next.js UI, auth mount, HTTP surface                  |
| `docs/design/`                 | decisions that took a while, and why                  |
| `docs/research/`               | other projects, with commit SHAs and caveats          |
| `scripts/stages.manifest`      | the single definition of what the gate runs           |

`packages/core` has **zero dependencies**. That is load-bearing: it is what lets
the layering checker treat a violation as structural rather than as a
convention.

## The contracts

Four things are locked before feature work, because getting them wrong means
every feature written against them is wrong. Read the plan section for each
before touching it.

1. **Extension API**: `GameFeature` and `createRuntime` in `packages/core`.
   `emit()` persists, then runs handlers, then publishes. Adding a domain
   operation to core is the failure this prevents.
2. **Agent identity**: an `agents` row and a credential. A GitHub OAuth token
   is never an agent identity; it identifies a _person_.
3. **Session**: `sessions.agent_id -> agents.id`. Never `sessions.user_id` as
   agent identity. A session is one run; an agent outlives it.
4. **Agent protocol**: the Application API. CLI, MCP and web are three
   consumers of one implementation, not three implementations.

## Things that will bite you

Each of these has already cost time here, so they are written down rather than
rediscovered.

- **Tests run against source, and that is deliberate.** The vitest stages alias
  every `@battle-agents/*` to `src/index.ts`. Without that alias a suite runs
  whatever was last built. If you add a package, add it to the alias; a test
  asserts the alias and the tsconfig paths cover the same set, and will fail
  otherwise.
- **A gate that cannot fail is worse than no gate.** Every check in this repo
  was, at some point, green while checking nothing: an extraction that stopped
  at the first space, a scanner reading a file it never loaded, a self-test
  that called its own parser instead of the real path. When you write a check,
  break the thing it guards and watch it go red before you believe it.
- **Comments are claims.** Several have been wrong here, including one asserting
  a branch was matched by an implementation that was dead code. A comment
  describing behaviour is only true once something tried to break it.
- **`dist` is build output, not source.** Do not read a `.d.ts` to learn what a
  package does. Read its `src`.
- **A migration reporting success is not proof.** drizzle-kit keeps its ledger
  in a separate schema, so dropping the application schema leaves it believing
  everything applied. The `migrations` and `schema-drift` stages check the
  tables and the artifact directly for exactly this reason.
- **A check may not assume every feature is installed.** `removal-test.sh`
  strips each feature in turn and runs the unit suite, so any test that reads
  `packages/features/*/src` at a fixed path fails on the removal it was meant to
  prove clean. Four were written this way before the pattern was named. A feature
  that is absent is not a feature with no behaviour: its event types are neither
  durable nor bus-only, and a style or vocabulary check that cannot tell the
  difference reports a dependency that does not exist. This is the same failure as
  the `any` at a boundary, one layer out — an assertion about the whole system
  reaching past a seam the system is built to have.

## Working a bead

The tracker is the source of truth for what to do next:

```bash
br ready      # what is unblocked
br show <id>  # the full brief, including the reasoning
br close <id> --reason "what actually landed, and what you deliberately did not"
```

A bead is a whole brief. It carries the reason the work exists, the decisions
already made, and the traps. Read it before touching the tree. Most of the
mistakes available here are avoidable by reading two paragraphs.

When you close a bead, the reason is the only record of a decision that went
the other way. Write what you chose _and_ what you did not.

## House style

- Comments explain **why**, not what. If a comment could be deleted without
  losing information about behaviour, delete it.
- Prefer a named constant to a number whose meaning is in the commit history.
- Public interfaces are typed. `any` in a boundary is a bug report you have not
  filed yet.
- The vocabulary in the plan is load-bearing: a session is a run, an agent is
  the character, a capability is a registry entry, an action is a typed
  dispatch. Using the words loosely is how a feature ends up owning a tool.
