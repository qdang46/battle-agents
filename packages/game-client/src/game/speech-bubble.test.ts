import { describe, expect, it } from 'vitest';

import {
  BUBBLE_ELLIPSIS,
  layoutSpeechBubble,
  SPEECH_BUBBLE_GEOMETRY,
  wrapText,
  type MeasureText,
} from './speech-bubble.js';

/**
 * The wrap, proven as text rather than as pixels.
 *
 * The assertion that matters is the round trip: wrap a string, join the lines
 * back with single spaces, and the result must be the original with its
 * whitespace collapsed. That one property pins both halves of "breaks at word
 * boundaries" at once — a line that starts or ends mid-word loses characters
 * from the round trip, and a wrap that split on the wrong boundary invents
 * them — and it holds whatever the input is, which is why it is checked over a
 * corpus and not against one hand-picked sentence.
 *
 * The width assertion is the second half, and it is checked over the same
 * corpus, because a wrap that silently exceeds its cap looks fine in every
 * screenshot and produces a panel that overlaps the character it belongs to.
 */

/** Proportional-ish widths, so a uniform-width stub cannot pass by accident. */
const NARROW_GLYPHS = new Set(['i', 'l', 'j', 't', 'f', 'I', '.', ',', "'", ':']);
const WIDE_GLYPHS = new Set(['W', 'M', 'm', 'w', '@']);
const NARROW_PX = 3;
const WIDE_PX = 11;
const SPACE_PX = 5;
const DEFAULT_PX = 7;

const measure: MeasureText = (text) => {
  let width = 0;
  for (const glyph of text) {
    if (glyph === ' ') width += SPACE_PX;
    else if (NARROW_GLYPHS.has(glyph)) width += NARROW_PX;
    else if (WIDE_GLYPHS.has(glyph)) width += WIDE_PX;
    else width += DEFAULT_PX;
  }
  return width;
};

const MAX_WIDTH = 120;

/** Short enough to sit on one line at the default cap. Named rather than read
 *  back out of CORPUS by index: under this repo's index settings that read is
 *  `string | undefined`, and a test that indexes an array to mean a name is a
 *  test whose meaning moves when the corpus is reordered. */
const SHORT_LINE = 'Read did not run the migration';

/** One token, wider than any width the corpus is checked at. */
const UNBREAKABLE_WORD = 'averylongunbreakableidentifierthatcannotfitonanyreasonablelineatallhere';

const CORPUS = [
  SHORT_LINE,
  'Waiting for your answer before I continue',
  'a',
  'W',
  'one two three four five six seven eight nine ten',
  'supercalifragilisticexpialidocious',
  'src/packages/core/src/extension/api.ts is the seam every adapter imports',
  'line one\nline two\nline three',
  'trailing whitespace   collapses    inside   a   paragraph   ',
  '\n\n',
  '   ',
  'Mixed WIDTHS like WlWll make the greedy fill interesting to reason about',
  UNBREAKABLE_WORD,
];

/** Whitespace collapsed to single spaces, which is what the round trip expects. */
const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Whether every word in the text could fit a line of this width unaided. */
const wordsFit = (text: string, width: number): boolean =>
  text
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .every((word) => measure(word) <= width);

/** Long enough to overflow the default 280px text budget by several lines. */
const LONG_TEXT =
  'the migration ledger lives in a separate schema so dropping the application ' +
  'schema leaves it believing everything applied, which is why the migrations ' +
  'stage reads the tables and the artifact directly instead of trusting it';

describe('wrapText', () => {
  it('breaks a long string at word boundaries', () => {
    const text = 'Read did not run the migration';
    const lines = wrapText(text, MAX_WIDTH, measure);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(normalized(text));
    for (const line of lines) {
      expect(line).not.toMatch(/^ | $/);
      expect(line).not.toBe('');
    }
  });

  it('never exceeds the max width', () => {
    for (const text of CORPUS) {
      for (const width of [20, 47, MAX_WIDTH, 400]) {
        for (const line of wrapText(text, width, measure)) {
          expect(measure(line), `"${line}" at ${width}px`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('loses no characters when the lines are joined back together', () => {
    // The round trip only holds where no word had to be split, because a
    // split word comes back joined without the space that was never there.
    // That case is checked by the cap test above, on its own terms.
    let checked = 0;
    for (const text of CORPUS) {
      for (const width of [20, 47, MAX_WIDTH, 400]) {
        if (!wordsFit(text, width)) continue;
        checked += 1;
        const joined = wrapText(text, width, measure).join(' ');
        const expected = normalized(text);
        if (expected.length === 0) {
          expect(joined).toBe('');
          continue;
        }
        expect(joined, `"${text}" at ${width}px`).toBe(expected);
      }
    }
    // Otherwise the filter could quietly exclude every case and the test would
    // pass while asserting nothing.
    expect(checked).toBeGreaterThan(10);
  });

  it('keeps every line inside the cap even for a word wider than the cap', () => {
    const lines = wrapText(UNBREAKABLE_WORD, 20, measure);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(20);
  });

  it('preserves explicit newlines as line breaks and blank lines as blanks', () => {
    expect(wrapText('line one\nline two', MAX_WIDTH, measure)).toEqual(['line one', 'line two']);
    expect(wrapText('above\n\nbelow', MAX_WIDTH, measure)).toEqual(['above', '', 'below']);
  });

  it('emits nothing at all for text with no words in it', () => {
    expect(wrapText('', MAX_WIDTH, measure)).toEqual([]);
    expect(wrapText('   \n  ', MAX_WIDTH, measure)).toEqual([]);
  });

  it('returns nothing rather than looping when the cap cannot hold a glyph', () => {
    expect(wrapText('anything', 0, measure)).toEqual([]);
    expect(wrapText('anything', -5, measure)).toEqual([]);
    // A single glyph wider than the whole cap still terminates, one char at a time.
    expect(wrapText('WWWW', 1, measure)).toEqual(['W', 'W', 'W', 'W']);
  });
});

describe('layoutSpeechBubble', () => {
  const base = { x: 200, y: 300 };
  const portraitHeight = 32;

  it('sizes the panel to its text and the cap, never past the cap', () => {
    const short = layoutSpeechBubble('hi', measure, base, portraitHeight);
    expect(short.lines).toEqual(['hi']);
    expect(short.panel.width).toBe(measure('hi') + SPEECH_BUBBLE_GEOMETRY.paddingX * 2);
    expect(short.panel.height).toBe(
      1 * SPEECH_BUBBLE_GEOMETRY.lineHeight + SPEECH_BUBBLE_GEOMETRY.paddingY * 2,
    );

    // The height is a function of the line count, not of the character count,
    // so the property worth pinning is the formula against a panel that wraps.
    const long = layoutSpeechBubble(LONG_TEXT, measure, base, portraitHeight);
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.panel.width).toBeLessThanOrEqual(SPEECH_BUBBLE_GEOMETRY.maxWidth);
    expect(long.panel.height).toBe(
      long.lines.length * SPEECH_BUBBLE_GEOMETRY.lineHeight + SPEECH_BUBBLE_GEOMETRY.paddingY * 2,
    );
  });

  it('hangs the panel above the portrait, centred on it, with the tail between', () => {
    const layout = layoutSpeechBubble(SHORT_LINE, measure, base, portraitHeight);
    const { tailHeight } = SPEECH_BUBBLE_GEOMETRY;

    expect(layout.tailTip).toEqual({ x: base.x, y: base.y - portraitHeight });
    expect(layout.left).toBe(base.x - layout.panel.width / 2);
    expect(layout.top + layout.panel.height + tailHeight).toBe(layout.tailTip.y);
  });

  it('caps the line count and marks the panel as not showing everything', () => {
    const layout = layoutSpeechBubble(LONG_TEXT, measure, base, portraitHeight);

    expect(layout.lines).toHaveLength(SPEECH_BUBBLE_GEOMETRY.maxLines);
    expect(layout.truncated).toBe(true);
    expect(layout.lines[layout.lines.length - 1]).toContain(BUBBLE_ELLIPSIS);
    for (const line of layout.lines) {
      expect(measure(line)).toBeLessThanOrEqual(
        SPEECH_BUBBLE_GEOMETRY.maxWidth - SPEECH_BUBBLE_GEOMETRY.paddingX * 2,
      );
    }
  });

  it('reports no truncation when the text fits the cap', () => {
    const layout = layoutSpeechBubble(SHORT_LINE, measure, base, portraitHeight);
    expect(layout.truncated).toBe(false);
    expect(layout.lines.join(' ')).toBe(normalized(SHORT_LINE));
  });

  it('lays out to no panel for an empty message', () => {
    const layout = layoutSpeechBubble('   ', measure, base, portraitHeight);
    expect(layout.lines).toEqual([]);
    expect(layout.panel).toEqual({ width: 0, height: 0 });
  });

  it('honours per-call geometry overrides', () => {
    const layout = layoutSpeechBubble(SHORT_LINE, measure, base, portraitHeight, {
      maxWidth: 40,
      maxLines: 1,
    });
    expect(layout.lines).toHaveLength(1);
    expect(layout.panel.width).toBeLessThanOrEqual(40);
    expect(layout.truncated).toBe(true);
  });
});
