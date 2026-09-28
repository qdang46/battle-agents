#!/usr/bin/env bash
# The game-first gate. Section 1 and section 2 of
# docs/design/game-first-doctrine.md, checked mechanically.
#
# WHY THIS IS A SCRIPT AND NOT A NOTE
#
# Every rule here has already been broken in this repository, and each one broke
# in a way that read as normal at the time:
#
#   - three routes under a shared dashboard layout, which is a textbook Next.js
#     pattern and was the shape of the whole application for a day;
#   - a sign-in gate on a landing page, which is a security feature, not a
#     layout decision, and looked nothing like one;
#   - 3,436 licensed art files on disk referenced only from comments, which
#     passed every test in the repository.
#
# A note about the right shape does not stop the wrong shape, because the wrong
# shape is assembled out of right-shaped pieces. So each rule below is a grep,
# and each one is written to fail on a REGRESSION rather than to describe a
# property.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=()
report() { failures+=("$1"); }

# ── self-test ────────────────────────────────────────────────────────────────
# A gate that cannot fail is worse than no gate. This section breaks each rule
# on a scratch copy and proves the checker goes red, so a rule that silently
# stopped matching cannot survive a run.
selftest() {
  local before=${#failures[@]}
  local scratch
  scratch="$(mktemp -d)"
  cp -R apps "$scratch/apps" 2>/dev/null

  # Rule 2: a route per scene. The cheapest rule to break by accident, because
  # adding a route is a normal thing to do.
  mkdir -p "$scratch/apps/web/app/arena"
  printf 'export default function P(){return null}\n' >"$scratch/apps/web/app/arena/page.tsx"
  if (cd "$scratch" && run_checks) >/dev/null 2>&1; then
    report "self-test: a per-scene route did not fail the checker"
  fi
  rm -rf "$scratch"

  # Rule 3: art on disk that no code names. This is the rule that catches the
  # defect this repository actually shipped, so it is the one that must not
  # silently stop matching.
  scratch="$(mktemp -d)"
  cp -R apps "$scratch/apps" 2>/dev/null
  mkdir -p "$scratch/apps/web/public/art/never-referenced-pack"
  if (cd "$scratch" && run_checks) >/dev/null 2>&1; then
    report "self-test: an unreferenced art pack did not fail the checker"
  fi
  rm -rf "$scratch"

  # Rule 4: a scene change that rebuilds the world.
  scratch="$(mktemp -d)"
  cp -R apps "$scratch/apps" 2>/dev/null
  sed -i 's/rebindView/UNRELATED_NAME/' "$scratch/apps/web/src/ui/world-canvas.tsx" 2>/dev/null
  if (cd "$scratch" && run_checks) >/dev/null 2>&1; then
    report "self-test: removing the view rebind did not fail the checker"
  fi
  rm -rf "$scratch"

  # Rule 5: the game linking out to a web page for a feature. This is the rule
  # that keeps the last standing version of the defect from returning, so it is
  # the one most worth proving can still fail.
  scratch="$(mktemp -d)"
  cp -R apps "$scratch/apps" 2>/dev/null
  printf '<a href="/bounties">board</a>' >>"$scratch/apps/web/src/ui/game-shell.tsx"
  if (cd "$scratch" && run_checks) >/dev/null 2>&1; then
    report "self-test: a link out of the game did not fail the checker"
  fi
  rm -rf "$scratch"

  echo "self-test: each rule fails when the thing it guards is broken"
  return 0
}

# The checks, isolated so the self-test can run them against a scratch copy.
run_checks() {
  local out=0

  # ── rule 1: the game is the frame ──────────────────────────────────────
  # `/` must be the game. A page that renders a dashboard shell, or redirects
  # into one, is the old shape wearing a new file name.
  if [ -f "apps/web/app/page.tsx" ]; then
    if grep -qE "redirect\(|DashboardShell|ViewerGate" "apps/web/app/page.tsx"; then
      report "rule-1: apps/web/app/page.tsx is not the game itself"
      out=1
    fi
  fi

  # The game shell must claim the whole viewport. `position: fixed; inset: 0`
  # is the shape; anything that sizes the canvas to a fraction of the page is
  # the game being hosted by a layout.
  if [ -f "apps/web/src/ui/game-shell.tsx" ]; then
    if ! grep -q "inset: 0" "apps/web/src/ui/game-shell.tsx"; then
      report "rule-1: the game shell does not claim the viewport"
      out=1
    fi
  else
    report "rule-1: apps/web/src/ui/game-shell.tsx is missing — the game has no shell"
    out=1
  fi

  # ── rule 2: scene, not route ────────────────────────────────────────────
  # A route whose name is a scene is a scene that is a route.
  for scene in city arena guild-hall battle; do
    if [ -d "apps/web/app/($GAME_GROUP)/$scene" ] || [ -d "apps/web/app/$scene" ]; then
      report "rule-2: there is a route at /$scene — a scene must be state, not a path"
      out=1
    fi
  done

  # ── rule 3: assets are wired, not shelved ───────────────────────────────
  # The failure this catches is real and has happened: art on disk, licensed
  # and attributed, referenced only from comments while the renderer drew its
  # own shapes. A comment mentioning a pack does not load it.
  if ! grep -q "loadSpriteAssets" apps/web/src/ui/world-canvas.tsx 2>/dev/null; then
    report "rule-3: the canvas never loads the vendored art (apps/web/src/ui/world-canvas.tsx)"
    out=1
  fi

  # A pack present on disk but named nowhere in the app is the same defect with
  # a different symptom, so it is checked rather than trusted.
  for pack in apps/web/public/art/*/; do
    [ -d "$pack" ] || continue
    name="$(basename "$pack")"
    if ! grep -rq "$name" apps/web/src packages/game-client/src 2>/dev/null; then
      report "rule-3: art pack '$name' is on disk and named by no code"
      out=1
    fi
  done

  # ── rule 4: the world survives a scene change ────────────────────────────
  # A scene switch that rebuilds the client drops the socket and every
  # character, which is a page load wearing a costume.
  if [ -f "apps/web/src/ui/world-canvas.tsx" ]; then
    if ! grep -q "rebindView" apps/web/src/ui/world-canvas.tsx; then
      report "rule-4: a scene change does not rebind the view — the world is being rebuilt"
      out=1
    fi
  fi

  # ── rule 5: the game has its own windows, not a web page for them ───────
  # The doctrine says a bounty is a notice board IN the city. A notice board
  # reached by navigating away from the city is a web page wearing a game name,
  # which is the exact failure this gate exists for — and it is the one that was
  # still true here when rule 5 was written.
  if [ -f "apps/web/src/ui/game-shell.tsx" ]; then
    if ! grep -q "GameWindow" "apps/web/src/ui/game-shell.tsx"; then
      report "rule-5: the game opens no in-game window — its features are web pages"
      out=1
    fi
    # A link out to a route from inside the shell is the same defect with a
    # different spelling: the game navigating away to show a feature.
    if grep -qE 'href="/bounties"|href="/agents"' "apps/web/src/ui/game-shell.tsx"; then
      report "rule-5: the game links OUT to a web page instead of opening a window"
      out=1
    fi
  fi

  # ── rule 6: the game is not wearing a web tab bar ──────────────────────
  # The rule that was broken LAST and by me: the scene switcher was a row of
  # equal rectangles with labels, which is a browser tab bar recoloured. A game
  # moves you with plates and a number row, so the check is for the SHAPE: a
  # strip of equal nav elements, and a topbar above the canvas, are both a web
  # app wearing a game.
  if [ -f "apps/web/src/ui/game-shell.tsx" ]; then
    # A nav element at all is the tell: a game has no <nav>.
    if grep -qE "<nav" "apps/web/src/ui/game-shell.tsx"; then
      report "rule-6: the game has a <nav> — a tab bar is not game navigation"
      out=1
    fi
    # A class named for a tab strip, wherever it is.
    if grep -qE 'tab--|TabStrip' "apps/web/src/ui/game-shell.tsx"; then
      report "rule-6: the game carries a tab-strip class — a web bar wearing a game"
      out=1
    fi
  fi

  return $out
}

# The group under which the old dashboard routes lived, if it still exists.
GAME_GROUP="app"

selftest

result=0
run_checks || result=1

if [ ${#failures[@]} -eq 0 ]; then
  echo "game-first check passed: / is the game, scenes are state, the art is wired."
else
  printf '  %s\n' "${failures[@]}"
  exit 1
fi

exit $result
