import type { ReactNode } from 'react';

/**
 * The refusal a page renders instead of its content.
 *
 * ## What this file used to be
 *
 * A dashboard shell: a top bar, a tab strip with a path resolver, a dev-login
 * banner, and this `Gate` at the bottom. All of it lived under `app/(app)/`,
 * which is a route group the game-first doctrine removed — the game is `/` now,
 * and its scenes and windows are its own UI, so a second navigation system
 * belonged to nothing.
 *
 * What survived is the one thing the game shell could not take with it: a way
 * to say WHY a screen is not showing, with the next action attached. A refusal
 * that does not name a cause is a wall, and a wall is worse than the error it
 * replaced because it tells nobody anything they can act on.
 *
 * The file keeps its name so the import in `app/page.tsx` reads as it did, but
 * it is the last of a dashboard, and a reader who adds a top bar back here is
 * rebuilding the thing the doctrine exists to prevent.
 */
export function Gate({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <main className="page">
      <section className="state">
        <h1 className="state__title">{title}</h1>
        {children}
      </section>
    </main>
  );
}
