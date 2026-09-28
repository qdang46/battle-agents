#!/usr/bin/env node
/**
 * `agent-battle-aider` — the long-lived process that runs the aider adapter.
 *
 * Everything a bin used to have to get right is in `@battle-agents/protocol`:
 * the flags, the ingest sender, the HELLO handshake, the signal handling, and
 * the decision of whether `--root` names a file or a directory. What is left
 * here is the three harness-specific facts: which watcher reads its files, what
 * this harness calls its own two shapes of root, and which harness it is.
 *
 * Note what is NOT here: a default path. `AiderWatcher` already has one, and the
 * first generated bins repeated it — the codex one naming CLAUDE's transcript
 * directory, which would have watched the wrong harness's files on every run
 * that did not pass `--root`. Omitting `defaultRoot` passes nothing and lets
 * the watcher decide.
 *
 * That is the whole of plan §28.1 item 3's promise, "a new CLI is one
 * subdirectory", made true.
 */
import { runHarnessBin } from '@battle-agents/harness-runner';

import { AiderWatcher } from '../watcher.js';

await runHarnessBin(process.argv.slice(2), {
  harness: 'aider',
  rootKind: 'either',
  rootOptions: { file: 'transcriptPath', directory: 'projectsRoot' },
  createWatcher: (send, root) =>
    new AiderWatcher({
      send,
      // The union demands one of the two, and `--root` supplies neither when it
      // is absent. An empty projects root is this watcher's own "discover"
      // default — it reads that at construction and treats '' as look-everywhere
      // — so naming it here is a restatement rather than a second opinion, and
      // it keeps the bin from having to guess which of the two a bare invocation
      // meant.
      projectsRoot: root['projectsRoot'] ?? '',
    }),
});
