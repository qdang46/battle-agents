# Game-first, stated plainly

This file exists because I got the shape wrong twice before the user corrected
it, and a correction that only lives in a chat transcript is a correction that
gets relitigated by the next agent who touches this code. Written down so it
does not have to be re-explained.

## What the user said, in order

1. "start game k cần auth để tôi xem bạn đã wire asets từ .tmp vào game chưa" —
   show me the game running, no auth required, so I can see the assets.
2. "cái UI game bắt buộc dùng các assets từ .tmp mà hiện tại thấy có dùng đâu
   copy mấy game khác qua" — the vendored art was not actually driving the
   renderer.
3. "thực sự là bạn chưa copy hết các game ở .tmp vào để nối thành 1 game hiện
   tại thấy chưa có gì luôn đó kiểu đơ đơ UI ai slop trong khi cần game full
   width height cả tab sẽ là trong game chứ sao vừa web rồi game nằm trong 1
   thành phần ở web" — the reference repos were not fully mined, the UI read as
   generic AI output, and the game needed to be full width and full height with
   the tabs INSIDE it — not a web page with a game embedded as one component of
   it.
4. "bạn hiểu 1 game ở web là gì k, nó k phải web có game ở trong mà là game có
   các chức năng ở trong" — a game on the web is not a website that contains a
   game; it is a game that contains the website's functions.
5. This message: game = full screen, a world, and every function is a
   component INSIDE that world — not an ordinary website with the game as one
   tab of it.

## What I had built, and why it was the wrong shape

Three routes — `/city`, `/arena`, `/guild-hall` — nested under a dashboard
`(app)` layout that had its own top bar and its own tab strip. Pressing a tab
in that strip navigated to a page containing a 460px-tall canvas. The
dashboard was the outer frame; the game was content inside one of its pages.

That is "a website with a game in it." The tab strip belonged to the
dashboard, was rendered by the dashboard's layout, and the game had no
awareness that it was being displayed — it was handed a `<div>` and a height,
same as a chart or a table would have been.

## What "a game on the web" means instead

The **world is the outer frame**. There is no chrome around it that belongs to
something else. The application's own navigation — switching between the
Coding City, the Arena, and the Guild Hall — happens **inside** the game's own
UI, as scene state, not as page navigation. A `<button>` that changes which
`SceneConfig` is passed to the renderer is inside the game; a `<a href>` that
loads a different Next.js route is not, because it tears the game down and
rebuilds it, which is what a website does between pages and what a game does
not do between screens.

Utility surfaces that are genuinely a different kind of tool — a bounty
board meant to be read and filled in, a sign-in flow — are allowed to be
plain web pages. What they may not do is wrap the game. The game links out to
them; they do not contain it. `/bounties` and `/agents` stay modern,
responsive HTML, reached by a link the game shows; `/` is the game, full
`position: fixed; inset: 0`, and nothing above it decides how big it is
allowed to be.

## The concrete shape this repository now has

- `apps/web/app/page.tsx` — the landing is the game. No redirect to a
  dashboard route.
- `apps/web/src/ui/game-shell.tsx` — full-viewport container; the scene
  switcher (City / Arena / Guild Hall) is buttons inside this component, not
  routes.
- `apps/web/src/ui/world-canvas.tsx` — one PixiJS `Application`, one
  `WorldStore`, one `GameClient` with one SSE connection, kept alive across a
  scene switch. Switching scenes calls `GameClient.rebindView()` rather than
  tearing anything down, because a game does not reload itself to look at a
  different room.
- The dashboard (`apps/web/app/(app)/*`) still exists, for bounties and agent
  profiles, and its tab strip no longer names a scene — it never should have.
  It carries one link back into the game ("Play"), because the game is what
  you return to, not what you occasionally visit.

## The trap worth naming for whoever reads this next

The wrong shape does not look wrong in a code review. A route per scene, a
shared layout, a tab strip — every individual piece is a normal, defensible
Next.js pattern. It is only wrong assembled, because the assembly answers "is
the game the product, or is the product a website that happens to contain a
game" — and the pieces above answer it the second way by construction, no
matter how each one reads in isolation. The fix was not a component; it was
inverting which thing is the frame.
