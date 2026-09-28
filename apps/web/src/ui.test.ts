import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GameWindow } from './ui/game-window.js';
import type { BountyBoardRow, BountyDetail } from './board-view.js';
import type { AgentCard, RosterEntry } from './roster-view.js';

/**
 * The in-game windows.
 *
 * ## What this replaced
 *
 * This file used to test the dashboard: the board header, the bounty list, the
 * roster, the agent card, and the sign-in gate in front of them. Every one of
 * those components was deleted when the `(app)` route group went, and a test of
 * deleted code is a test that stops testing anything while still going green —
 * which is the failure this repository's own notes are about, in the form that
 * is hardest to see.
 *
 * So the coverage moved to what is now the product: the windows that open OVER
 * the world, which is where every one of those screens actually lives.
 */

function html(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

const ROW: BountyBoardRow = {
  id: 'b-1',
  rewardCents: 200_000,
  rewardLabel: '$2,000',
  currency: 'USD',
  repoLabel: 'verifier/notice-board',
  issueNumber: 4242,
  issueUrl: 'https://github.com/verifier/notice-board/issues/4242',
  status: 'open',
  mode: 'first-valid',
  sponsorCount: 2,
  claimedByAgentId: null,
  expiresLabel: null,
};

const DETAIL: BountyDetail = {
  ...ROW,
  requirements: ['regression test', 'changelog entry'],
  funds: [
    { sponsorUserId: 'u-1', amountCents: 125_000, label: '$1,250' },
    { sponsorUserId: 'u-2', amountCents: 75_000, label: '$750' },
  ],
  prUrl: null,
  mergedBy: null,
  payoutNotice: 'SANDBOX: this reward is a target, not a payment.',
  refundNotice: null,
  battle: null,
};

const CHARACTER: AgentCard = {
  id: 'a-1',
  name: 'CodeKnight',
  harness: 'claude',
  level: 4,
  xp: 820,
  build: 'Debugger',
  presence: 'online',
  lastSeenAt: '2026-09-28T04:00:00.000Z',
  lastSeenLabel: 'just now',
  sessionId: 's-1',
  sessionStatus: 'active',
  currentQuest: 'Fix the offset drift',
  skills: [
    { skill: 'Debugging', level: 8, xp: 900 },
    { skill: 'Testing', level: 6, xp: 400 },
  ],
  hasProgress: true,
  battlesWon: 3,
  battlesLost: 1,
  testsPassed: 142,
  pullRequestsMerged: 11,
};

const ROSTER: readonly RosterEntry[] = [
  {
    id: 'a-1',
    name: 'CodeKnight',
    harness: 'claude',
    level: 4,
    xp: 820,
    build: 'Debugger',
    presence: 'online',
    lastSeenAt: '2026-09-28T04:00:00.000Z',
    lastSeenLabel: 'just now',
    sessionId: 's-1',
    sessionStatus: 'active',
    currentQuest: 'Fix the offset drift',
  },
];

function aWindow(props: Partial<React.ComponentProps<typeof GameWindow>>) {
  return createElement(GameWindow, {
    open: 'board',
    onClose: () => undefined,
    board: [ROW],
    roster: ROSTER,
    character: CHARACTER,
    bounty: DETAIL,
    onOpenBounty: () => undefined,
    onOpenCharacter: () => undefined,
    onOpenRoster: () => undefined,
    onOpenBoard: () => undefined,
    ...props,
  });
}

describe('a window over the world', () => {
  it('renders nothing at all when it is closed', () => {
    // The whole of the point. An open window is a layer over a running game; a
    // closed one must leave the canvas as the only thing on screen, and the way
    // to guarantee that is for the closed case to emit no markup whatsoever.
    expect(html(aWindow({ open: null }))).toBe('');
  });

  it('is titled by what it is, in the game, not by a route', () => {
    for (const [open, title] of [
      ['board', 'NOTICE BOARD'],
      ['roster', 'ROSTER'],
      ['character', 'CHARACTER SHEET'],
      ['bounty', 'POSTING'],
    ] as const) {
      expect(html(aWindow({ open })), title).toContain(title);
    }
  });

  it('shows a bounty as a posting with its reward and its issue', () => {
    const markup = html(aWindow({ open: 'board' }));
    expect(markup).toContain('NOTICE BOARD');
    expect(markup).toContain('$2,000');
    expect(markup).toContain('verifier/notice-board');
    expect(markup).toContain('#4242');
  });

  it('says an empty board is empty rather than rendering a blank panel', () => {
    // The failure this is for: a board with no rows rendered as an empty box,
    // which reads as a bug rather than as a fact about the world.
    const markup = html(aWindow({ open: 'board', board: [] }));
    expect(markup).toContain('Nothing posted');
  });

  it('lists characters with their level and who is online', () => {
    const markup = html(aWindow({ open: 'roster' }));
    expect(markup).toContain('ROSTER');
    expect(markup).toContain('CodeKnight');
    expect(markup).toContain('Lv4');
  });

  it('carries the whole character sheet, not a name and a level', () => {
    // The card this window replaced had every one of these fields and a test
    // per field. They are all here, so the fields are all asserted.
    const markup = html(aWindow({ open: 'character' }));
    expect(markup).toContain('CodeKnight');
    expect(markup).toContain('Level 4');
    expect(markup).toContain('Debugger');
    expect(markup).toContain('Debugging');
    expect(markup).toContain('Tests passed');
    expect(markup).toContain('142');
    expect(markup).toContain('PRs merged');
    expect(markup).toContain('Fix the offset drift');
  });

  it('does not invent progression for a character that has none', () => {
    // The read model answers "no record" rather than zeros, and the window has
    // to say so in words. Printing a level-0 build would be a character sheet
    // asserting a fact the database does not hold.
    const markup = html(
      aWindow({
        open: 'character',
        character: { ...CHARACTER, hasProgress: false, build: 'unrecorded' },
      }),
    );
    expect(markup).toContain('No progression record yet');
    expect(markup).not.toContain('unrecorded');
  });

  it('shows a posting with its requirements and what the payout is', () => {
    const markup = html(aWindow({ open: 'bounty' }));
    expect(markup).toContain('POSTING');
    expect(markup).toContain('regression test');
    // The sandbox notice is the feature's own words and is carried verbatim;
    // paraphrasing it would be a claim the payout feature never made.
    expect(markup).toContain('SANDBOX');
  });

  it('says a posting that is gone rather than rendering an empty sheet', () => {
    expect(html(aWindow({ open: 'bounty', bounty: null }))).toContain('no longer on the board');
  });
});
