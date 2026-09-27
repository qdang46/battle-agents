/**
 * Registering this adapter with Amp, with consent.
 *
 * Two rules, and neither is negotiable:
 *
 * 1. **Ask first.** A first write to a settings file is a consent gate, not an
 *    install step. The user sees what will be written, where, and how to undo
 *    it, and says yes before anything is written.
 * 2. **Never touch the user's project.** Global agent config only. An installer
 *    that edits a repository is editing code the user is working in.
 *
 * The shape is the template's, and it is copied rather than reinvented because
 * the ordering it encodes is the whole point: the preference is recorded only
 * AFTER the effect settled and the file agrees. Recording first strands the
 * user when the write fails — the entries are not there, the preference says
 * they are, and the next start skips the gate.
 */

export interface InstallTarget {
  /** Amp's global settings file, e.g. `~/.config/amp/settings.json`. */
  readonly configPath: string;
  /** The executable Amp should run for a hook, as a path. */
  readonly hookCommand: string;
  /** Event names Amp dispatches. */
  readonly eventNames: readonly string[];
}

export interface ConsentDisclosure {
  readonly headline: string;
  /** What is written where, what data moves, how to undo. Paragraphs on blank lines. */
  readonly body: string;
}

export type ConsentChoice = 'granted' | 'declined';

export interface InstallerEffects {
  /** Write the entries. Returns whether the file on disk now agrees. */
  readonly write: (target: InstallTarget) => Promise<boolean>;
  /** Remove our entries and leave everything else alone. */
  readonly remove: (target: InstallTarget) => Promise<boolean>;
  /** Record the answer so the user is not asked twice. */
  readonly record: (choice: ConsentChoice) => Promise<void>;
}

/** What the user is shown before anything is written. */
export const AMP_CONSENT: ConsentDisclosure = {
  headline: 'Let Battle Agents read your Amp activity?',
  body: [
    'This adds one entry to your global Amp settings file, at ~/.config/amp/settings.json.',
    'It makes Amp report each tool it runs — the tool name and its arguments, and whether it succeeded — to your own machine, where the game stores them as the activity log a replay is built from.',
    'Your project files are not modified, and nothing is sent anywhere except the game server you are already running.',
    'To undo it: run the uninstall, which removes this entry and leaves everything else in the file alone.',
  ].join('\n\n'),
};

/**
 * Apply a consent answer.
 *
 * The answer is a state command, not an event: choosing again replaces what the
 * first choice did. That is why the effects are ordered, and why a decline that
 * could not remove the entries leaves the recorded answer alone — a "declined"
 * recorded over hooks that are still firing is a state the user cannot get out
 * of through the UI.
 */
export async function applyConsentChoice(
  choice: ConsentChoice,
  target: InstallTarget,
  effects: InstallerEffects,
): Promise<{ installed: boolean }> {
  if (choice === 'declined') {
    const removed = await effects.remove(target);
    if (!removed) return { installed: false };
    await effects.record(choice);
    return { installed: false };
  }

  const written = await effects.write(target);
  if (!written) return { installed: false };
  await effects.record(choice);
  return { installed: true };
}
