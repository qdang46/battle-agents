'use client';

import { useCallback, useEffect } from 'react';

import { PanelFrame, GameIcon } from './game-chrome.js';
import type { BountyBoardRow, BountyDetail } from '../board-view.js';
import type { AgentCard, RosterEntry } from '../roster-view.js';

/**
 * An in-game window: a pixel panel that opens OVER the world.
 *
 * ## What this is for
 *
 * The doctrine's feature-to-place table says a bounty is a notice board standing
 * in the city, not a web page. A window is how a place becomes reachable without
 * leaving the game: the world keeps running behind it, the socket stays
 * subscribed, and closing it puts you back on the same tile you left.
 *
 * ## Why it is NOT a route
 *
 * Because a route unmounts the tree the canvas is mounted in. The PixiJS
 * application, the world store and the SSE connection all live in the game shell
 * above this; a window is a sibling of the canvas, not a page above it. Opening
 * one adds a child to a container that is already there, which is the whole
 * difference between a notice board in a city and a link out of one.
 *
 * ## The data arrives as a prop, not a fetch
 *
 * The window is a CLIENT component and the board is read through the server's
 * database. Fetching it here would need a credential the browser does not have
 * — `/api/act` authenticates a Bearer installation token, and a signed-in
 * person has a cookie, not a token. So the shell's server parent reads the rows
 * and hands them down, and the window is pure presentation. That is also what
 * keeps it testable without a server.
 */

export type WindowId = 'board' | 'bounty' | 'roster' | 'character' | null;

export interface GameWindowProps {
  readonly open: WindowId;
  readonly onClose: () => void;
  /** The Notice Board's rows, read by the server parent. */
  readonly board: readonly BountyBoardRow[];
  /** Every character, read by the server parent. The ROSTER window lists these. */
  readonly roster: readonly RosterEntry[];
  /** One character's full sheet, when the window is on that character. */
  readonly character: AgentCard | null;
  /** One bounty's full posting, when the window is on that bounty. */
  readonly bounty: BountyDetail | null;
  readonly onOpenBounty: (bountyId: string) => void;
  readonly onOpenCharacter: (agentId: string) => void;
  readonly onOpenRoster: () => void;
  readonly onOpenBoard: () => void;
}

/** A bounty row, priced the way a notice board prices a job. */
function NoticeRow({
  row,
  onInspect,
}: {
  readonly row: BountyBoardRow;
  readonly onInspect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onInspect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'start',
        appearance: 'none',
        background: 'rgba(11,14,20,0.6)',
        border: '1px solid #2b3550',
        color: '#d6e2ff',
        font: 'inherit',
        fontSize: '0.8rem',
        padding: '0.5rem 0.6rem',
        cursor: 'pointer',
      }}
    >
      <span style={{ color: '#f0c674', marginInlineEnd: '0.5rem' }}>{row.rewardLabel}</span>
      <span>{row.repoLabel} #{String(row.issueNumber)}</span>
      <span style={{ color: '#6f7686', marginInlineStart: '0.5rem' }}>· {row.status}</span>
    </button>
  );
}

/**
 * The Notice Board, as a window in the city.
 *
 * DESIGN.md §4 gives the Coding City a Quest Board and §3 gives the player a
 * bounty board; this is the two at once, which is why it is a place on the map
 * rather than a screen that replaced the map.
 */
/** One posting, read at the Notice Board. The bounty detail, as a sheet. */
function BountyPosting({
  bounty,
  onOpenBoard,
}: {
  readonly bounty: BountyDetail | null;
  readonly onOpenBoard: () => void;
}) {
  if (bounty === null) {
    return (
      <p style={{ color: '#6f7686', padding: '1rem', textAlign: 'center' }}>
        That posting is no longer on the board.
      </p>
    );
  }
  return (
    <div style={{ padding: '0 0.6rem 0.6rem', color: '#d6e2ff', fontSize: '0.8rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', paddingBottom: '0.5rem' }}>
        <span style={{ fontSize: '1.05rem', color: '#f0c674' }}>{bounty.rewardLabel}</span>
        <span>{bounty.repoLabel} #{String(bounty.issueNumber)}</span>
        <span style={{ color: '#8b93a7' }}>· {bounty.status}</span>
        <span style={{ color: '#6f7686' }}>· {bounty.mode}</span>
      </div>

      <Section title="REQUIREMENTS">
        {bounty.requirements.length === 0 ? (
          <span style={{ color: '#6f7686' }}>None listed.</span>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: '1.2rem' }}>
            {bounty.requirements.map((requirement) => (
              <li key={requirement}>{requirement}</li>
            ))}
          </ul>
        )}
      </Section>

      {bounty.sponsorCount === 1 ? null : (
        <Section title={`SPONSORS (${String(bounty.sponsorCount)})`}>
          {bounty.funds.map((fund, index) => (
            <div key={index} style={{ color: '#8b93a7' }}>
              {fund.label} — {fund.sponsorUserId}
            </div>
          ))}
        </Section>
      )}

      {bounty.payoutNotice === null ? null : (
        <Section title="PAYOUT">
          <span style={{ color: '#8b93a7' }}>{bounty.payoutNotice}</span>
        </Section>
      )}

      {bounty.prUrl === null ? null : (
        <Section title="PULL REQUEST">
          <a href={bounty.prUrl} target="_blank" rel="noreferrer" style={{ color: '#8ab4f8' }}>
            {bounty.prUrl}
          </a>
        </Section>
      )}

      {bounty.battle === null ? null : (
        <Section title="BATTLE">
          {/* The replay is a shareable external link — the ONE thing a route is
              for in this product, because someone sends it to somebody who is
              not in this game yet. */}
          <a
            href={`/replay/${bounty.battle.replayId}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#8ab4f8' }}
          >
            Watch the replay
          </a>
        </Section>
      )}

      <button
        type="button"
        onClick={onOpenBoard}
        style={{
          marginTop: '0.6rem',
          appearance: 'none',
          background: 'transparent',
          border: '1px solid #2b3550',
          color: '#8b93a7',
          font: 'inherit',
          fontSize: '0.75rem',
          padding: '0.3rem 0.7rem',
          cursor: 'pointer',
        }}
      >
        ← Notice board
      </button>
    </div>
  );
}

/** A presence dot, the same shape the roster used. One pip, not a word. */
function PresencePip({ presence }: { readonly presence: string }) {
  const tone =
    presence === 'online' ? '#5dcaa5' : presence === 'working' ? '#f0c674' : '#4a5163';
  return (
    <span
      title={presence}
      style={{ width: 8, height: 8, borderRadius: 2, background: tone, display: 'inline-block' }}
    />
  );
}

/** The character sheet: identity, build, skills, and a record of real outcomes. */
function CharacterSheet({
  card,
  onOpenRoster,
}: {
  readonly card: AgentCard | null;
  readonly onOpenRoster: () => void;
}) {
  if (card === null) {
    return (
      <p style={{ color: '#6f7686', padding: '1rem', textAlign: 'center' }}>
        Choose a character from the roster.
      </p>
    );
  }
  return (
    <div style={{ padding: '0 0.6rem 0.6rem', color: '#d6e2ff', fontSize: '0.8rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', padding: '0 0 0.5rem' }}>
        <span style={{ fontSize: '1.05rem', color: '#fff' }}>{card.name}</span>
        <span style={{ color: '#8b93a7' }}>{card.harness}</span>
        <span style={{ color: '#f0c674' }}>Level {String(card.level)}</span>
        <span style={{ marginInlineStart: 'auto' }}>
          <PresencePip presence={card.presence} />
        </span>
      </div>

      <Section title="BUILD">
        <span>{card.hasProgress ? card.build : 'No progression record yet.'}</span>
      </Section>

      <Section title="SKILLS">
        <div style={{ display: 'grid', gap: '0.2rem' }}>
          {card.skills.length === 0 ? (
            <span style={{ color: '#6f7686' }}>No skills recorded.</span>
          ) : (
            card.skills.map((skill) => (
              <div key={skill.skill} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ width: '7.5rem', color: '#8b93a7' }}>{skill.skill}</span>
                <span aria-label={`level ${String(skill.level)}`} style={{ letterSpacing: '1px', color: '#f0c674' }}>
                  {'█'.repeat(Math.max(0, Math.min(10, skill.level)))}
                </span>
                <span style={{ color: '#6f7686' }}>{String(skill.level)}</span>
              </div>
            ))
          )}
        </div>
      </Section>

      <Section title="RECORD">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.2rem 1rem' }}>
          <Stat label="Battles won" value={card.battlesWon} />
          <Stat label="Battles lost" value={card.battlesLost} />
          <Stat label="Tests passed" value={card.testsPassed} />
          <Stat label="PRs merged" value={card.pullRequestsMerged} />
        </div>
        {card.currentQuest === null ? null : <div style={{ color: '#8b93a7', marginTop: '0.4rem' }}>On: {card.currentQuest}</div>}
        {card.lastSeenLabel === '' ? null : <div style={{ color: '#6f7686', marginTop: '0.4rem' }}>Last seen {card.lastSeenLabel}</div>}
      </Section>

      <button
        type="button"
        onClick={onOpenRoster}
        style={{
          marginTop: '0.6rem',
          appearance: 'none',
          background: 'transparent',
          border: '1px solid #2b3550',
          color: '#8b93a7',
          font: 'inherit',
          fontSize: '0.75rem',
          padding: '0.3rem 0.7rem',
          cursor: 'pointer',
        }}
      >
        ← Roster
      </button>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '0.6rem' }}>
      <h3 style={{ margin: '0 0 0.3rem', fontSize: '0.7rem', letterSpacing: '0.1em', color: '#6f7686' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <span style={{ color: '#8b93a7' }}>{label}</span>
      <span style={{ marginInlineStart: 'auto', color: '#fff' }}>{String(value)}</span>
    </div>
  );
}

const TITLES: Readonly<Record<Exclude<WindowId, null>, string>> = {
  board: 'NOTICE BOARD',
  bounty: 'POSTING',
  roster: 'ROSTER',
  character: 'CHARACTER SHEET',
};

export function GameWindow({
  open,
  onClose,
  board,
  roster,
  character,
  bounty,
  onOpenBounty,
  onOpenCharacter,
  onOpenRoster,
  onOpenBoard,
}: GameWindowProps) {
  const escape = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (open === null) return;
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, escape]);

  if (open === null) return null;

  return (
    // position: absolute INSIDE the game shell, so it covers the world and not
    // the page, and the world keeps rendering behind it.
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(4,6,10,0.55)',
        zIndex: 10,
      }}
      onClick={onClose}
      data-testid={`game-window-${open}`}
    >
      <PanelFrame
        slice={16}
        tint="rgba(12,17,28,0.97)"
        style={{
          width: 'min(640px, 88vw)',
          maxHeight: '74vh',
          overflow: 'auto',
          padding: '0.4rem',
        }}
        // Click inside the panel must not dismiss it — only the scrim does.
      >
        <div onClick={(event) => event.stopPropagation()}>
          <header
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.4rem 0.6rem 0.6rem',
              color: '#cfe0ff',
            }}
          >
            <GameIcon name="star" color="White" size={18} />
            <h2 style={{ margin: 0, fontSize: '1rem', letterSpacing: '0.04em' }}>
              {open === null ? '' : TITLES[open]}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                marginInlineStart: 'auto',
                appearance: 'none',
                background: 'transparent',
                border: '1px solid #2b3550',
                color: '#8b93a7',
                font: 'inherit',
                cursor: 'pointer',
                padding: '0.15rem 0.45rem',
              }}
            >
              ✕
            </button>
          </header>

          {open === 'board' ? (
            <div style={{ display: 'grid', gap: '0.35rem', padding: '0 0.4rem 0.4rem' }}>
              {board.length === 0 ? (
                <p style={{ color: '#6f7686', padding: '1rem', textAlign: 'center' }}>
                  Nothing posted. No bounty is open.
                </p>
              ) : (
                board.map((row) => (
                  <NoticeRow key={row.id} row={row} onInspect={() => onOpenBounty(row.id)} />
                ))
              )}
            </div>
          ) : null}

          {open === 'roster' ? (
            <div style={{ display: 'grid', gap: '0.3rem', padding: '0 0.4rem 0.4rem' }}>
              {roster.length === 0 ? (
                <p style={{ color: '#6f7686', padding: '1rem', textAlign: 'center' }}>
                  No characters have appeared yet.
                </p>
              ) : (
                roster.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onOpenCharacter(entry.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.6rem',
                      width: '100%',
                      textAlign: 'start',
                      appearance: 'none',
                      background: 'rgba(11,14,20,0.6)',
                      border: '1px solid #2b3550',
                      color: '#d6e2ff',
                      font: 'inherit',
                      fontSize: '0.8rem',
                      padding: '0.45rem 0.6rem',
                      cursor: 'pointer',
                    }}
                  >
                    <GameIcon name="star" color="White" size={14} />
                    <span style={{ flex: 1 }}>
                      {entry.name}
                      {entry.currentQuest === null ? null : (
                        <span style={{ color: '#6f7686' }}> · {entry.currentQuest}</span>
                      )}
                    </span>
                    <span style={{ color: '#f0c674' }}>Lv{String(entry.level)}</span>
                    <PresencePip presence={entry.presence} />
                  </button>
                ))
              )}
            </div>
          ) : null}

          {open === 'character' ? <CharacterSheet card={character} onOpenRoster={onOpenRoster} /> : null}
          {open === 'bounty' ? <BountyPosting bounty={bounty} onOpenBoard={onOpenBoard} /> : null}
        </div>
      </PanelFrame>
    </div>
  );
}
