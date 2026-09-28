'use client';

import { CITY, ARENA, GUILD_HALL, type SceneConfig, type SceneId } from '@battle-agents/game-client';
import { useCallback, useEffect, useState } from 'react';

import { usePixelFont } from './game-chrome.js';
import { ScenePlates, PLATES } from './pixel-hud.js';
import {
  assignControlGroup,
  recallControlGroup,
  type ControlGroups,
  type ControlGroupKey,
} from '@battle-agents/game-client';
import { GameWindow, type WindowId } from './game-window.js';
import type { BountyBoardRow, BountyDetail } from '../board-view.js';
import type { AgentCard, RosterEntry } from '../roster-view.js';
import { WorldCanvas, type WorldStatus } from './world-canvas.js';

/**
 * The game, full width, with the scene switcher inside it.
 *
 * ## Why this is not a page per scene
 *
 * It was three routes under the dashboard group, which made the game a PANEL of
 * a web app: a top bar and a tab strip belonging to the dashboard, with the
 * world underneath them at 460px. Reading it produced the thing it was built to
 * avoid — a site with a game attached rather than a game.
 *
 * So the scenes are STATE here, not paths. Pressing a scene swaps the one
 * PixiJS `Application` and the store behind it without a navigation, which is
 * also the only way a scene change can be instant: a route change tears down the
 * canvas, re-fetches the art, and shows an empty world while it does.
 *
 * ## What the design document said, and why this overrode it
 *
 * `DESIGN.md` §2 settled a split — "pixel art for the game world, modern chrome
 * for the dashboard" — and §3 settled the Bounty Board as the first screen, on
 * the reasoning that a pixel world with no real utility reads as a costume. Both
 * were decided, both are recorded, and following them produced a game that is one
 * tab of a dashboard: the chrome took the frame and the world took what was left.
 *
 * The reasoning was about not being a COSTUME. A full-bleed world with the
 * bounty board reachable FROM it is the opposite of a costume — it is a game with
 * a utility screen — so this is not §2 being overturned, it is §3's sequencing
 * being applied from the other end. The dashboard is still there at `/bounties`
 * and `/agents`; it is simply not what you land inside.
 *
 * ## One canvas, three scenes, one store
 *
 * The canvas is built once. Switching scenes re-fits the existing view rather
 * than rebuilding it, so the characters on the map are the SAME characters and
 * the switch is a camera move rather than a page load.
 */
const SCENES: readonly SceneConfig[] = [CITY, ARENA, GUILD_HALL];

const SCENE_HINTS: Readonly<Record<string, string>> = {
  city: 'Guild Hall · Research Lab · Workshop · Quest Board · Arena',
  arena: 'Fighters walk here from a battle. Judged on a rubric published before it starts.',
  'guild-hall': 'Shared projects, shared quests, the guild treasury.',
};

export function GameShell({
  board = [],
  bounties = [],
  roster = [],
  characters = [],
  devLogin = false,
}: {
  readonly board?: readonly BountyBoardRow[];
  /** Every posting in full, so the window can show the one that was pressed. */
  readonly bounties?: readonly BountyDetail[];
  readonly roster?: readonly RosterEntry[];
  /** Every character in full, for the same reason. */
  readonly characters?: readonly AgentCard[];
  readonly devLogin?: boolean;
}) {
  usePixelFont();
  const [scene, setScene] = useState<SceneConfig>(CITY);
  const [status, setStatus] = useState<WorldStatus>('starting');
  const [agents, setAgents] = useState(0);
  const [openWindow, setWindow] = useState<WindowId>(null);
  const [art, setArt] = useState('');
  // WHICH bounty and WHICH character the window is on, as ids. Not as objects
  // and not as a boolean: a handler that takes an id and ignores it opens the
  // same posting every time, and nothing about that is visible in a type.
  const [selectedBountyId, setSelectedBountyId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // Control groups: which characters are marked with which number, and who is
  // highlighted. A map so an empty one is the honest default rather than a
  // placeholder object pretending to be a roster.
  const [groups, setGroups] = useState<ControlGroups>(() => new Map());
  const [highlighted, setHighlighted] = useState<readonly string[]>([]);

  const selectedBounty = bounties.find((detail) => detail.id === selectedBountyId) ?? null;
  const selectedCharacter =
    characters.find((card) => card.id === selectedAgentId) ?? null;

  const choose = useCallback((id: SceneId) => {
    const found = SCENES.find((candidate) => candidate.id === id);
    if (found !== undefined) setScene(found);
  }, []);

  // Number-row travel, and a Q/W/E… row for control groups.
  //
  // Two rows rather than one because the number row is already spoken for by the
  // scene plates, and a key that means two things is a key that means whichever
  // handler happened to be registered first. Q is the leftmost of a vertical
  // column, so Q/W/E/R reads as the first four of nine.
  const GROUP_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o'] as const;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();

      const groupIndex = GROUP_KEYS.indexOf(key as (typeof GROUP_KEYS)[number]);
      if (groupIndex >= 0) {
        const live = new Set(roster.map((entry) => entry.id));
        if (event.shiftKey) {
          // Assign: whoever is highlighted right now joins this group. A group
          // with nobody in it is a group that was never meant.
          setGroups((current) => assignControlGroup(current, (groupIndex + 1) as ControlGroupKey, highlighted));
        } else {
          setHighlighted(recallControlGroup(groups, (groupIndex + 1) as ControlGroupKey, live));
        }
        return;
      }

      const plate = PLATES.find((candidate) => candidate.key === event.key);
      if (plate !== undefined) choose(plate.scene.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choose, groups, highlighted, roster]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#0b0e14',
        color: '#e6e9f0',
        // The HUD is set in the GAME's font, not the browser's. A monospace
        // fallback here is the difference between a game that owns its screen
        // and a web page that happens to have a canvas on it, and the font is
        // already vendored and CC0 — see `applyGameChrome`.
        fontFamily: '"Kenney Future", ui-monospace, monospace',
      }}
    >
      {/* The HUD, laid OVER the world rather than above it. There is no bar
          here: a bar across the top is the one piece of chrome that most looks
          like a web app, so the game has none. The plates float over the map
          the way a game's quick-travel icons do, and the two window buttons
          sit opposite them. */}
      <div
        style={{
          position: 'absolute',
          top: '0.75rem',
          left: '0.75rem',
          right: '0.75rem',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          pointerEvents: 'none',
          zIndex: 5,
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          <ScenePlates current={scene.id} onTravel={choose} />
          {devLogin ? (
            <p style={{ margin: '0.35rem 0 0', color: '#f5d78a', fontSize: '0.62rem' }}>
              DEV LOGIN — no GitHub session
            </p>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', pointerEvents: 'auto' }}>
          <HudButton label="Notice board" onClick={() => setWindow('board')} />
          <HudButton label="Roster" onClick={() => setWindow('roster')} />
        </div>
      </div>

      {/* The world and the window are SIBLINGS over one relative box, so
          opening a window covers the canvas without unmounting it. The PixiJS
          application, the store and the socket all live above this and are not
          touched when `window` changes. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <WorldCanvas
          scene={scene}
          fill
          onStatus={setStatus}
          onAgents={setAgents}
          onArt={setArt}
          highlighted={highlighted}
        />
        <GameWindow
          open={openWindow}
          board={board}
          roster={roster}
          character={selectedCharacter}
          bounty={selectedBounty}
          onClose={() => setWindow(null)}
          onOpenBounty={(bountyId) => {
            setSelectedBountyId(bountyId);
            setWindow('bounty');
          }}
          onOpenCharacter={(agentId) => {
            setSelectedAgentId(agentId);
            setWindow('character');
          }}
          onOpenRoster={() => setWindow('roster')}
          onOpenBoard={() => setWindow('board')}
        />
      </div>

      <footer
        style={{
          display: 'flex',
          gap: '1.25rem',
          padding: '0.35rem 0.75rem',
          background: 'rgba(8,10,16,0.82)',
          fontSize: '0.72rem',
          color: '#6f7686',
        }}
      >
        <span>{scene.label}</span>
        <span style={{ color: '#4d5566' }}>{SCENE_HINTS[scene.id] ?? ''}</span>
        <span>status: {status}</span>
        <span>agents: {agents}</span>
        {art === '' ? null : <span>{art}</span>}
      </footer>
    </div>
  );
}

/**
 * A HUD button — a raised tile in the game's own visual language.
 *
 * Distinct from a browser button by three things at once: the pixel font, the
 * sunken/raised depth the plates use, and the letter-spaced small caps. A
 * control that matches the page it is on is web chrome no matter what colour it
 * is; a control that matches the WORLD is HUD.
 */
function HudButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        font: 'inherit',
        fontSize: '0.6rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: '#cfe0ff',
        background: 'linear-gradient(180deg, #1a2438 0%, #101724 100%)',
        border: '1px solid #2b3550',
        borderTop: '2px solid #3c4d75',
        padding: '0.4rem 0.75rem',
        cursor: 'pointer',
        imageRendering: 'pixelated',
      }}
    >
      {label}
    </button>
  );
}
