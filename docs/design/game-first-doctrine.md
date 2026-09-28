# Game-first architecture doctrine

**Mandatory. Binding on every agent. A change that violates this is wrong the
same way a layering violation is wrong — not a matter of taste, and not
appealable to the fact that the offending code works.**

> Build a native pixel RPG that happens to run inside a browser — not a React
> website with a game embedded inside it.

The browser is the **runtime**. The game is the **product**. There is no such
thing as "plain web plus an embedded game" in this product; the whole
application IS the game.

---

## 1. The first principle

**Browser is the runtime. The game is the product.**

The entire viewport is the game (`100vw × 100vh`). HUD, menus, inventory,
settings, the bounty board, an agent's profile — all of it is UI of the game,
drawn by the game, opening over the game. A person using this should never at
any point feel they are looking at a website.

**Wrong — a website that contains a game:**

- an HTML navbar or a React sidebar
- the game as a component inside somebody else's layout, at a height somebody
  else chose
- cards, tables, or a SaaS admin shell doing the work
- a URL per screen, and a page load between them

**Right — a game that contains the functions:**

- one fullscreen game runtime
- every screen is a scene or an in-game window
- the world is behind it and stays behind it
- no navigation ever leaves the game

## 2. Scene, not route

City, Arena, Guild Hall are **scene state**. They are not routes, and changing
one is not a navigation.

A scene switch preserves, always:

- the PixiJS `Application` and its ticker
- the `WorldStore` and every character in it
- the SSE connection and its subscription
- the loaded asset cache
- the camera

Changing scene **never remounts the game**. `GameClient.rebindView()` is the
mechanism: the view is rebuilt because the view is what a scene IS, while the
store, the client and the socket are what the player has spent an hour
investing in.

A route is for leaving the game entirely — signing in, a documentation page,
an operator tool. A scene is for going somewhere inside it.

## 3. Every feature has a reason to exist in the world

A feature that cannot be given a place in the world has not been designed yet.

| Feature | Wrong | Right |
| --- | --- | --- |
| Bounty | a web page listing issues | the Notice Board standing in the city |
| Agent profile | a `/agents/[id]` page | a character sheet window, opened on the character |
| Leaderboard | a sortable table | the Hall of Fame, and the names carved into it |
| Settings | a preferences form | the pause menu |
| Marketplace | a shop page | a merchant stall |
| Notifications | a bell in a navbar | an in-world mailbox you walk to |
| Quest | a list | a poster on the Quest Board |
| Save | an API page | a save-slot screen, from the pause menu |
| History | a profile tab | a logbook |

A reader asking "where in the world does this live?" and getting no answer means
the feature is not finished, whatever its tests say.

## 4. Visual language

**Pixel art.** 9-slice panels, sprite icons, bitmap text, RPG HUD. The UI is
built from the same sheets as the world.

**If a screen looks like Linear, Vercel, Notion or a Material admin panel, it is
wrong** — no matter how clean it is, how accessible it is, or how many tests it
passes.

Do not mix icon systems. A Lucide icon beside a pixel sprite in the same HUD is
two products on one screen.

## 5. Asset policy

**Assets from `.tmp` are the source of truth.** The reference checkouts and the
vendored CC0 packs are the art; a procedurally drawn rectangle is a
placeholder, and a placeholder that ships where art already exists is a bug
with a licence file next to it.

This is not aspirational: the whole of `apps/web/public/art/` existed on disk,
licensed and attributed, referenced only from comments, while the renderer drew
its own shapes. That state passed every test in this repository.

## 6. The gate

`scripts/check-game-first.sh` enforces section 1 and section 2 mechanically. It
runs in the M0 pipeline. A green suite with a red `check-game-first` is a broken
gate, not a passing build.

**Before opening a PR, an agent checks itself against this list:**

- [ ] `/` is fullscreen (`100vw × 100vh`), with no layout above it
- [ ] no HTML navbar, sidebar or shell wraps the game
- [ ] no route is used to change scene
- [ ] the HUD is drawn by the game, in the game's visual language
- [ ] inventory, settings, profile and the board open as in-game windows
- [ ] assets come from the vendored packs; no placeholder where art exists
- [ ] no SaaS card or table is doing the work of a game screen
- [ ] opening a window does not remount the world
- [ ] every new feature can name the place in the world it lives

Any unchecked box means the PR points the wrong way.

## 7. What this replaced, and why

`DESIGN.md` §2 settled a split — "pixel art for the game world, modern chrome
for the dashboard" — and §3 settled the Bounty Board as the first screen, on
the reasoning that a pixel world with no real utility is a gimmick trap.

The reasoning was sound and it was followed: the game became a panel in a
dashboard, at a height the dashboard chose, reachable by pressing a tab in
chrome that belonged to something else. Three separate routes, each perfectly
defensible in review, assembled into a website that contained a game. The
individual pieces are what made the assembly hard to see.

§2's split is not thereby overturned — the reasoning survives, and §5 is where
the "no utility, no costume" concern is actually answered. What is overturned
is §3's sequencing applied from the web side outward instead of the game side
outward. A player standing in a full-bleed world who opens a notice board is
not in a costume. The same board, opened through a dashboard, is.

## 8. The trap for the next agent

The wrong shape does not look wrong in a code review. A route per scene, a
shared layout, a tab strip, a sign-in form — every one of those is a normal,
defensible pattern, and this repository shipped all of them in sequence. The
defect is not visible in any file. It is only visible in the assembled
application, which is why §6 is a gate and not a note, and why the first rule
here is about the shape rather than about any individual choice.
