#!/usr/bin/env node
/**
 * `agent-battle-amp` — the long-lived process that runs the Amp adapter.
 *
 * Everything a bin used to have to get right is in `@battle-agents/protocol`:
 * the flags, the ingest sender, the HELLO handshake, the signal handling. What is
 * left here is what is specific to this harness.
 *
 * ## Why this one has more than the other eight
 *
 * Every other adapter derives identity from what it reads: a `sessionId` in a
 * transcript line, and the shared sender opens the platform run for it. Amp's
 * watcher is told who it is instead — `threadId`, `agentId`, `installationId`,
 * `projectId` — because Amp is invoked with those already known rather than
 * discovered, so there is nothing in the file to recover them from.
 *
 * Those four arrive as extra flags rather than as a second bin, because the
 * alternative is a hand-rolled argument parser for exactly one adapter, which is
 * the thing the shared runner exists to remove.
 */
import { runHarnessBin } from '@battle-agents/harness-runner';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AmpWatcher } from '../watcher.js';

const identity: {
  threadId: string | undefined;
  agentId: string | undefined;
  installationId: string | undefined;
  projectId: string | undefined;
} = { threadId: undefined, agentId: undefined, installationId: undefined, projectId: undefined };

const REQUIRED = ['--thread-id', '--agent-id', '--installation-id', '--project-id'] as const;

await runHarnessBin(process.argv.slice(2), {
  harness: 'amp',
  rootKind: 'file',
  rootOptions: { file: 'threadPath', directory: 'threadPath' },
  extraFlags: {
    '--thread-id': (value) => {
      identity.threadId = value;
    },
    '--agent-id': (value) => {
      identity.agentId = value;
    },
    '--installation-id': (value) => {
      identity.installationId = value;
    },
    '--project-id': (value) => {
      identity.projectId = value;
    },
  },
  createWatcher: (send, root) => {
    // Checked here rather than in the shared parser, because these four are
    // this adapter's requirement and the other eight have none. A watcher
    // constructed with an undefined id would emit events that name nobody, and
    // the server would refuse them with a message about a session rather than
    // about the flag that was missing.
    for (const flag of REQUIRED) {
      const field = flag.replace('--', '') as keyof typeof identity;
      if (identity[field] === undefined) {
        throw new Error(`agent-battle-amp: ${flag} is required; see --help`);
      }
    }
    return new AmpWatcher({
      send,
      threadPath: root['threadPath'] ?? join(homedir(), '.amp', 'threads'),
      threadId: identity.threadId as string,
      agentId: identity.agentId as string,
      installationId: identity.installationId as string,
      projectId: identity.projectId as string,
    });
  },
});
