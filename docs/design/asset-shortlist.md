# Game asset shortlist

Plan §14 and §28.1 item 1. The code in this repository is MIT; **each asset pack keeps its own
licence, stored beside the pack.** Mixing a copyleft art pack into an MIT repository contaminates
it, so the two are tracked separately and never inferred from one another.

Paths are `apps/web/public/art/<pack>/`, per §19 — with a rewrite so the URL
`/assets/<pack>/…` still resolves. §19's path does not work: Next.js reserves
`/assets` for its own build pipeline, so a PNG under `public/assets/` answered
308 to the directory and 404 after following it, while a file beside it answered
200. The art existed, was licensed, was recorded, and was unloadable.

## The shortlist

| Pack            | Source                                                                                              | Licence | Style                                                                    | Role                                       |
| --------------- | --------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| age-of-agents   | [agentsmill/age-of-agents](https://github.com/agentsmill/age-of-agents) `packages/client/public/assets/{fantasy,scifi,emblems}` | MIT | fantasy/scifi pixel, **TexturePacker sheets with `.json` frame manifests** | the characters, buildings and terrain the game actually draws |
| tiny-swords-cc0 | [Pixel Frog, Tiny Swords update 010](https://pixelfrog-assets.itch.io/tiny-swords), via agent-quest | CC0-1.0 | fantasy pixel, 64px tile grid; frames are source-scale sheets, not 16×16 | V0 characters, terrain, buildings, effects |
| kenney-tiny-dungeon | [Kenney — Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon) | CC0-1.0 | 16×16 pixel, dungeon tiles, flat colour | dungeon terrain and props |
| kenney-tiny-town | [Kenney — Tiny Town](https://kenney.nl/assets/tiny-town) | CC0-1.0 | 16×16 pixel, town tiles, flat colour | the city's streets and plots |
| kenney-tiny-ski | [Kenney — Tiny Ski](https://kenney.nl/assets/tiny-ski) | CC0-1.0 | 16×16 pixel, tileset, flat colour | the out-of-town terrain band |
| kenney-pixel-platformer | [Kenney — Pixel Platformer](https://kenney.nl/assets/pixel-platformer) | CC0-1.0 | 16×18 pixel, platformer tiles | raised ground and platforms |
| kenney-pixel-shmup | [Kenney — Pixel Shmup](https://kenney.nl/assets/pixel-shmup) | CC0-1.0 | 16×16 pixel, shooter sprites | projectiles and the arena backdrop |
| kenney-rpg-urban-pack | [Kenney — RPG Urban Pack](https://kenney.nl/assets/rpg-urban-pack) | CC0-1.0 | 16×16 pixel, RPG urban props and tiles | the dev-workstation half of the city |
| kenney-game-icons | [Kenney — Game Icons](https://kenney.nl/assets/game-icons) | CC0-1.0 | **flat vector, 256×256 — not pixel** | HUD icons; the one family boundary in this table |
| kenney-ui-pack | [Kenney — UI Pack](https://kenney.nl/assets/ui-pack) | CC0-1.0 | **flat vector panels — not pixel** | panels, buttons, 9-slice frames |
| kenney-particle-pack | [Kenney — Particle Pack](https://kenney.nl/assets/particle-pack) | CC0-1.0 | **flat vector, 128×128 — not pixel** | hit sparks, build dust, merge flash |

## What this table is and is not

**It is a table because the per-pack licence is the deliverable and prose is where per-pack
licences go missing.** A sentence saying "we use CC0 packs" survives a pack being relicensed
upstream; a row with a licence cell does not.

**The style column was a CLAIM until it was measured, and it was wrong.** The first
row said "16×16 fantasy pixel" because plan §25 says "16×16@3x placeholders" —
but that sentence is about the programmatic sprite FACTORY that stands in until
art exists, not about this pack. Reading the PNG headers: 205 files, none
unparseable, and the sizes are 64×64, 128×128, 192×192 and larger source sheets
(83 tiles at 64×64, 30 icons at 64×64, buildings at 128×192 and 320×256). The row
now says what the pack actually is, with the upstream attributed rather than only
the path it was copied from.

That is the failure this table exists to prevent, committed in the table itself: a
style nobody had looked at, written down as though someone had. §14 makes
style consistency the selection criterion, and the first row did not meet the
standard the file sets for the rows after it.

**The style column is a DECLARATION that has to be looked at, not a finding.** Plan §14 makes style consistency the actual
selection criterion — a perfect set of individually excellent packs in five visual styles reads as
an amateur project instantly — and **no script in this repository can judge whether five packs look
like one game.** Writing a "style lint" would be worse than none, because it would claim to check
something it cannot and would be trusted. What is enforced is that the style is DECLARED per row, so
the claim is explicit and reviewable by a human instead of implied by a selection nobody can
second-guess a year later.

**The count is a target, not a floor to pad.** One pack is here because it is the V0 unblocker
(§28.1 item 1) and it is already CC0-verified in the reference checkout, not because it fills a
quota. If the count check below fails because a careful selection found fewer, **fix the selection,
do not add packs to make a number go green** — and record which packs were rejected for style, which
is the evidence that the judgment was made rather than skipped.

## Skins, and the one thing they must never become

§14 gives tentative skins: Claude → Mage, Codex → Knight, Gemini → Alchemist, OpenCode → Rogue,
Pi → Hacker. **Skins ONLY. Never hardcode class to model.** Class is derived from BEHAVIOUR by
`features/progression` (§10.2), the skin is cosmetic, and it must be swappable — an agent may also
carry its own loadout. A skin that encodes a class contradicts the character model, not just the art.

## Checks

Both are real commands, and both are run on every merge rather than at selection time, because
licences change and packs get relicensed.

- `pnpm license-check` — every directory under `apps/web/public/assets/` ships a `LICENSE.txt`,
  **and** the licence recorded in the table above matches the text actually shipped in that
  directory. The second half is the one that catches the real failure: a pack relicensed upstream
  between selection and merge still carries a stale recorded licence, a LICENSE.txt check passes
  because a file exists, and the table quietly asserts something untrue. **A file merely EXISTING
  is not verification.**
- The row count and the empty-licence-cell rules, in `scripts/check-assets.sh`.

What these cannot prove: that the selected packs look like one game. That is a human review of the
style column, and it is the plan's stated criterion.


## The style claim, stated honestly

**`age-of-agents` is a different family, and it is now the one the game draws.**
Its sheets are 68×68 characters, 192×192 buildings and 32×32 terrain, against
Kenney's 16×16. Two families in one atlas is the same boundary this table already
draws for the vector UI packs, and it is worth being explicit about which side of
it this pack sits on: the Coding City is drawn from `age-of-agents` ALONE —
`SpriteCache` resolves every agent, building and zone from that one pack — so
what the player sees is internally consistent, and the Kenney sets below are
available for chrome and icons rather than mixed into the world.

The alternative was worse: characters from one family standing on ground from
another is the exact mismatch the placeholder factory was built to avoid.

**Rows 2–8 are one family.** 16×16/16×18 flat pixel with no anti-aliasing, and
seven of the ten come from Kenney's own "Tiny"/pixel line, which is internally
consistent by construction.

**Rows 9–11 are a second family, and the client must not mix them into a 16px
sprite atlas.** They are Kenney's flat *vector* UI, icon and particle packs. They
are here because a game needs panels, buttons, icons and particles, and no CC0
pixel set in this selection supplies them at usable quality — but rendering a
vector panel into a 16×16 sprite sheet looks wrong, and this table says so rather
than implying a coherence that is not there.

The honest fix is a pixel UI pack, which is the first thing to look for if this
set is revisited. The wrong fix is to pretend the two families already agree.

**What is NOT claimed:** that any script here can judge whether these look like
one game. No such check exists and none should — the failure is a bad selection,
not a missing lint, and a script cannot see it.

## Rejected, and why the count landed where it did

**`input-prompts` (Kenney)** — downloaded, then rejected: 3,056 font glyph PNGs
at 20 MB. It is a font, not art, and vendoring it tripled the asset tree for no
visual content.

**`tiny-forest`, `tiny-town-castle` (Kenney)** — do not exist on the source and
returned no download.

**CraftPix / GameDevMarket** — commercial, not CC0. Mixing a proprietary art pack
into an MIT repository is the contamination §17.7 warns about.

**OpenGameArt and itch.io CC0 submissions** — not excluded on principle, but
their licence is per-submission and must be read per pack. None was taken here
because none could be verified as quickly and as unambiguously as Kenney's,
whose licence travels *inside* the archive — which is what makes the recorded
licence a fact about the shipped bytes rather than a claim about a web page.
