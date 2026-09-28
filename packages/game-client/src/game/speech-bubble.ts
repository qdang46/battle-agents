/**
 * The speech bubble, as arithmetic.
 *
 * ## Why this is a module and not a drawing
 *
 * Every reference implementation in `.tmp` draws the bubble first and reads the
 * geometry back off the drawing: agent-move measures a Pixi `Text`, sizes a
 * `Graphics` to fit, and only then knows where the panel is. That works right
 * up until the moment you want to know whether it is right, because the answer
 * only exists once a canvas has been created, laid out and rendered, and a
 * headless context that has lost its drawing buffer reports the same empty
 * frame whether the wrap was correct or not.
 *
 * So the half that can be wrong — which words land on which line, how wide the
 * panel ends up, where the tail points — is here, as a pure function of the
 * text and a measurement callback, and the drawing consumes the result. That is
 * the same split `introBubbleGeometry.ts` makes in pixel-agents, and the reason
 * it can carry a test.
 *
 * ## Provenance
 *
 * The geometry is modelled on agent-world-smallville
 * `environment/frontend_server/static_dirs/viewer.html` (Apache-2.0) and the
 * pixel dimensions on agent-move `packages/client/src/agents/speech-bubble.ts`
 * (MIT); both are in THIRD-PARTY-NOTICES.md. Neither reference wraps text by
 * hand — Smallville hands the job to Phaser's `wordWrap` and agent-move to
 * Pixi's, both of which need a live renderer this module deliberately does not
 * have. The wrap below is therefore written here, not ported, and the comment
 * claiming otherwise would be the kind AGENTS.md warns about.
 */

/** Width in screen pixels of a rendered run of text. */
export type MeasureText = (text: string) => number;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface PixelBox {
  readonly width: number;
  readonly height: number;
}

/** Panel dimensions, all in screen pixels. */
export interface SpeechBubbleGeometry {
  /** Hard cap on panel width. Wrapping happens to this, not to the measured text. */
  readonly maxWidth: number;
  readonly paddingX: number;
  readonly paddingY: number;
  /** Full advance per line, so the panel is `lines * lineHeight` tall. */
  readonly lineHeight: number;
  /** Gap between the panel's bottom edge and the portrait's top edge. */
  readonly tailHeight: number;
  readonly tailHalfWidth: number;
  /**
   * A bubble that grows without bound hides the character saying it. Four lines
   * is agent-move's `maxChars` budget in a shape that can be laid out; past it
   * the rest is dropped and the last line is ellipsized.
   */
  readonly maxLines: number;
}

export const SPEECH_BUBBLE_GEOMETRY: SpeechBubbleGeometry = {
  maxWidth: 300,
  paddingX: 10,
  paddingY: 10,
  lineHeight: 14,
  tailHeight: 6,
  tailHalfWidth: 4,
  maxLines: 4,
};

export const BUBBLE_ELLIPSIS = '…';

export interface SpeechBubbleOptions extends Partial<SpeechBubbleGeometry> {}

export interface SpeechBubbleLayout {
  /** Laid-out lines, each already measured to fit `maxWidth` minus padding. */
  readonly lines: readonly string[];
  readonly panel: PixelBox;
  /** Panel top-left in screen pixels. */
  readonly left: number;
  readonly top: number;
  /** Where the tail tip meets the portrait. */
  readonly tailTip: ScreenPoint;
  /** The line cap dropped lines, so the panel is not showing everything. */
  readonly truncated: boolean;
}

/**
 * Greedy word wrap: fill a line until the next word would overflow it, then
 * start a new one. Explicit newlines in `text` break the line and are the only
 * way to get a blank one.
 *
 * A single word wider than `maxWidth` is split at a character boundary, because
 * the alternative is a panel wider than its own cap — which is the one promise
 * this function makes to everything downstream, and a promise kept by widening
 * is not kept. Real tool output is full of unbreakable tokens (paths, hashes,
 * identifiers) and they are exactly the case that would otherwise break it.
 *
 * Returns no lines at all for text that is empty or only whitespace: a bubble
 * with nothing to say is not a bubble.
 */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  if (maxWidth <= 0) return [];

  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.length > 0) {
        lines.push(line);
        line = '';
      }
      line = spillUnbreakableWord(word, maxWidth, measure, lines);
    }
    lines.push(line);
  }

  // A trailing newline is punctuation, not a second blank line, and a bubble
  // is not a text document. Interior blanks survive: only the tail is trimmed.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Lay out a speech bubble above a portrait.
 *
 * `base` is the character's screen position (its feet) and `portraitHeight` its
 * height in screen pixels, so the panel can clear the head instead of being
 * placed by a guess at where the head is. `measure` is supplied by the caller
 * because measuring a glyph without the font that will draw it is a guess, and
 * this module deliberately does not know what font anything is.
 */
export function layoutSpeechBubble(
  text: string,
  measure: MeasureText,
  base: ScreenPoint,
  portraitHeight: number,
  options: SpeechBubbleOptions = {},
): SpeechBubbleLayout {
  const geometry = { ...SPEECH_BUBBLE_GEOMETRY, ...options };
  const textWidth = Math.max(0, geometry.maxWidth - geometry.paddingX * 2);

  const wrapped = wrapText(text, textWidth, measure);
  const truncated = wrapped.length > geometry.maxLines;
  const lines = truncated ? cappedLines(wrapped, geometry, measure) : wrapped;

  // Padding belongs to text. A message with none has no box to pad, and a
  // padded empty box draws a 20x20 lozenge floating above a silent character.
  const widest = lines.reduce((width, line) => Math.max(width, measure(line)), 0);
  const panel: PixelBox =
    lines.length === 0
      ? { width: 0, height: 0 }
      : {
          width: Math.min(geometry.maxWidth, widest + geometry.paddingX * 2),
          height: lines.length * geometry.lineHeight + geometry.paddingY * 2,
        };

  const tailTip: ScreenPoint = { x: base.x, y: base.y - portraitHeight };
  return {
    lines,
    panel,
    left: base.x - panel.width / 2,
    top: tailTip.y - geometry.tailHeight - panel.height,
    tailTip,
    truncated,
  };
}

/**
 * The first `maxLines` lines, with the last one shortened to make room for the
 * ellipsis. Dropping the line entirely would be a worse lie than an ellipsis:
 * the panel would end mid-sentence with no sign that anything was cut.
 */
function cappedLines(
  wrapped: readonly string[],
  geometry: SpeechBubbleGeometry,
  measure: MeasureText,
): string[] {
  const lines = wrapped.slice(0, geometry.maxLines);
  const last = lines[lines.length - 1];
  if (last === undefined) return lines;

  let shortened = last + BUBBLE_ELLIPSIS;
  while (
    shortened.length > BUBBLE_ELLIPSIS.length &&
    measure(shortened) > geometry.maxWidth - geometry.paddingX * 2
  ) {
    shortened = shortened.slice(0, -BUBBLE_ELLIPSIS.length - 1) + BUBBLE_ELLIPSIS;
  }
  lines[lines.length - 1] = shortened;
  return lines;
}

/**
 * Break a word that cannot fit on any line, pushing the fragments onto `lines`
 * and returning the tail end, which is the part that still fits.
 *
 * The cut point is found by growing one character at a time rather than by
 * binary search, because the loop's termination argument is "the measurement
 * stopped accepting characters" and a binary search over a non-monotonic
 * measure would quietly break that. At least one character always moves, so an
 * over-wide glyph yields a one-character line instead of a hang.
 */
function spillUnbreakableWord(
  word: string,
  maxWidth: number,
  measure: MeasureText,
  lines: string[],
): string {
  let rest = word;
  while (measure(rest) > maxWidth) {
    let cut = 1;
    while (cut < rest.length && measure(rest.slice(0, cut + 1)) <= maxWidth) cut++;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return rest;
}
