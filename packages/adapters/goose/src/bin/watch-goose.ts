#!/usr/bin/env node
/**
 * `agent-battle-goose` — the long-lived process that runs the goose adapter.
 *
 * Everything a bin used to have to get right is in `@battle-agents/protocol`:
 * the flags, the ingest sender, the HELLO handshake, the signal handling, and
 * the decision of whether `--root` names a file or a directory. What is left
 * here is the three harness-specific facts: which watcher reads its files, what
 * this harness calls its own two shapes of root, and which harness it is.
 *
 * Note what is NOT here: a default path. `GooseWatcher` already has one, and the
 * first generated bins repeated it — the codex one naming CLAUDE's transcript
 * directory, which would have watched the wrong harness's files on every run
 * that did not pass `--root`. Omitting `defaultRoot` passes nothing and lets
 * the watcher decide.
 *
 * That is the whole of plan §28.1 item 3's promise, "a new CLI is one
 * subdirectory", made true.
 */
import { runHarnessBin } from '@battle-agents/harness-runner';

import { GooseWatcher } from '../watcher.js';

await runHarnessBin(process.argv.slice(2), {
  harness: 'goose',
  rootKind: 'directory',
  rootOptions: { file: 'root', directory: 'root' },
  createWatcher: (send, root) => new GooseWatcher({ send, ...root }),
});
