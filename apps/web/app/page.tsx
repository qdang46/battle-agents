import { GameShell } from '@/ui/game-shell.js';
import { resolveViewer, viewerMayRead } from '@/viewer-view.js';
import { headers } from 'next/headers.js';
import { Gate } from '@/ui/shell.js';
import { loadBountyBoard, loadBountyDetail } from '@/board-view.js';
import { loadAgentCard, loadRoster } from '@/roster-view.js';

/**
 * The landing, which is the GAME.
 *
 * ## What changed, and why
 *
 * This used to redirect to `/bounties`, and the game lived at `/city` behind the
 * dashboard's tab strip — a web application with a game attached to it, rather
 * than a game that happens to be delivered over HTTP. Three separate routes, a
 * top bar belonging to the dashboard, and a world 460px tall under all of it.
 *
 * The thing that reads as "AI slop web UI" is not the pixel art. It is the shape:
 * chrome first, game second. So the chrome is gone from this route entirely.
 * The world is the page, the scene switcher is inside the game, and the bounty
 * board is a screen the game can send you to rather than a frame around it.
 *
 * ## The design document said otherwise
 *
 * `DESIGN.md` §3 settled the Bounty Board as the first screen and the Coding
 * City as "a second view reached from the board, not as the landing", on the
 * reasoning that a pixel world with no real utility is a gimmick trap (§17.1).
 * That was a considered call and it is recorded, and the thing it produced was a
 * game you reach by leaving the game.
 *
 * The reasoning is not being discarded — the utility is real and still there,
 * one click away and linked from inside the game. What changed is the framing:
 * a full-bleed world that a player is IN is not a costume, which is the failure
 * §2 and §3 were both guarding against. §2's split survives untouched at
 * `/bounties` and `/agents`, which are genuinely a different tool and stay
 * modern and clean.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Home() {
  // The world is a spectator surface, so the gate is the same one every other
  // page uses. A reader with no session is refused here exactly as they are
  // refused on the board — a game that shows its world to nobody is not a game.
  const viewer = await resolveViewer(await headers());
  if (!viewerMayRead(viewer)) {
    return (
      <Gate title="Sign in to play">
        <p className="state__body">
          The world is a spectator surface: every character on it is a coding agent
          doing real work. Sign in to watch it.
        </p>
      </Gate>
    );
  }

  // The board is read HERE, on the server, and handed to the game as a prop.
  //
  // The window that shows it is a client component, and it cannot fetch this
  // itself: `/api/act` authenticates a Bearer installation token and a signed-in
  // person has a cookie, not a token. Reading it at the server boundary is what
  // lets the Notice Board be a place in the city without inventing a credential
  // the browser does not carry. See `ui/game-window.tsx`.
  const [board, roster] = await Promise.all([loadBountyBoard(), loadRoster()]);

  // EVERY bounty and EVERY character, in full.
  //
  // The first version loaded one of each — the lead character and the first
  // posting — and the window took a single `character` and a single `bounty`.
  // The click handlers took an id and ignored it, so every row on the board
  // opened the first posting and every name in the roster opened the lead
  // character. It typechecked the whole way down, which is what made it silent:
  // a callback that accepts an id and does not use it is a wrong answer, not a
  // missing one.
  //
  // So the full sets are read here and the client picks by id. The cost is a
  // read per row rather than one, on a page that is a game and not an API; the
  // alternative was a window that could only ever show one thing.
  const [details, cards] = await Promise.all([
    Promise.all(board.rows.map((row) => loadBountyDetail(row.id))),
    Promise.all(roster.map((entry) => loadAgentCard(entry.id))),
  ]);

  return (
    <GameShell
      board={board.rows}
      bounties={details.filter((detail): detail is NonNullable<typeof detail> => detail !== undefined)}
      roster={roster}
      characters={cards.filter((card): card is NonNullable<typeof card> => card !== undefined)}
      devLogin={viewer.kind === 'dev-login'}
    />
  );
}
