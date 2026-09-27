/**
 * A software pixel buffer: the smallest thing that can draw a placeholder.
 *
 * This exists because of a measured constraint rather than a preference.
 * `Graphics.generateTexture()` in PixiJS 8 bakes through the render pipeline,
 * and there is no pipeline outside a browser — `generateTexture` is not even a
 * method on `Graphics` in 8.21; the nearest equivalent, `graphics.texture`,
 * returns a texture with undefined dimensions until a renderer has run. So a
 * factory built on it cannot be constructed in a test, and a factory that
 * cannot be constructed in a test cannot have its cache tested, and the bead
 * requires the cache to be tested.
 *
 * Filling an RGBA byte array and handing it to `TextureSource` has no such
 * dependency: it is the same work in both environments, which is what "keeps V0
 * unblocked by art and makes the client testable without an asset pipeline" has
 * to mean if it is going to be true rather than aspirational.
 *
 * Deliberately not a graphics library. `fillRect` and `fillEllipse` are what the
 * placeholders use; everything else is a reason to reach for the renderer.
 */

import { BufferImageSource, Texture } from 'pixi.js';

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** `#rrggbb` to a colour, so a palette can be written the way DESIGN.md reads. */
export function hex(value: number): Rgba {
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: 255 };
}

export function withAlpha(color: Rgba, alpha: number): Rgba {
  return { ...color, a: Math.round(Math.max(0, Math.min(1, alpha)) * 255) };
}

/**
 * A row-major RGBA8 image, written pixel by pixel.
 *
 * Not a canvas and not a wrapper: an owned `Uint8ClampedArray` and a bounds
 * check on every write, because a placeholder that silently writes past the end
 * of its buffer produces a corrupt texture that renders as noise on one machine
 * and as nothing on another.
 */
export class PixelCanvas {
  readonly #pixels: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.#pixels = new Uint8ClampedArray(width * height * 4);
  }

  set(x: number, y: number, color: Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.#pixels[offset] = color.r;
    this.#pixels[offset + 1] = color.g;
    this.#pixels[offset + 2] = color.b;
    this.#pixels[offset + 3] = color.a;
  }

  get(x: number, y: number): Rgba {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const offset = (y * this.width + x) * 4;
    return {
      r: this.#pixels[offset] ?? 0,
      g: this.#pixels[offset + 1] ?? 0,
      b: this.#pixels[offset + 2] ?? 0,
      a: this.#pixels[offset + 3] ?? 0,
    };
  }

  /** Fills an axis-aligned rect, clipped to the canvas. */
  fillRect(x: number, y: number, w: number, h: number, color: Rgba): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        this.set(px, py, color);
      }
    }
  }

  /**
   * Fills the pixels of a 1px rect, i.e. an outline.
   *
   * A separate method rather than a thin `fillRect` because an outline is drawn
   * from four edges and getting the inset wrong is a classic way to produce a
   * border that is one pixel too thick on two sides.
   */
  strokeRect(x: number, y: number, w: number, h: number, color: Rgba, thickness = 1): void {
    this.fillRect(x, y, w, thickness, color);
    this.fillRect(x, y + h - thickness, w, thickness, color);
    this.fillRect(x, y, thickness, h, color);
    this.fillRect(x + w - thickness, y, thickness, h, color);
  }

  /**
   * Fills an ellipse inscribed in the given box.
   *
   * Used for the selection ring and the team disc, where a rect would read as a
   * box rather than as ground.
   */
  fillEllipse(x: number, y: number, w: number, h: number, color: Rgba): void {
    const rx = w / 2;
    const ry = h / 2;
    const cx = x + rx;
    const cy = y + ry;
    for (let py = Math.floor(y); py < Math.ceil(y + h); py += 1) {
      for (let px = Math.floor(x); px < Math.ceil(x + w); px += 1) {
        const dx = (px + 0.5 - cx) / rx;
        const dy = (py + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(px, py, color);
      }
    }
  }

  /**
   * Wraps the buffer as a Pixi texture. The only Pixi call in this file.
   *
   * `BufferImageSource`, and that is not a stylistic choice between two
   * constructors that both return a texture. It is the one that works.
   *
   * A plain `TextureSource` has no `uploadMethodId`, so the renderer's bind
   * group has no idea how to put a raw typed array on the GPU: the texture is
   * created, it reports the right width and height, it reports a valid
   * resource, and it uploads nothing. Every sprite built this way was a
   * transparent rectangle that rendered as nothing.
   *
   * Measured in a running browser rather than inferred: `renderer.extract` on
   * the unit layer returned 48x48 bounds with 0 opaque pixels and a single
   * colour (black) — the sprite was in the tree, correctly parented, correctly
   * positioned and correctly scaled, and contributed no pixels at all. The
   * bounds were right, which is why every earlier check of the node, the
   * texture's dimensions and the sprite's alpha all passed.
   *
   * `format` is stated rather than inferred, because `BufferImageSource` picks
   * `bgra8unorm` for a `Uint8ClampedArray` that does not name one — blue and
   * red swapped, which is a sprite that renders in the wrong colours rather than
   * one that fails loudly.
   */
  toTexture(): Texture {
    const source = new BufferImageSource({
      resource: this.#pixels,
      width: this.width,
      height: this.height,
      format: 'rgba8unorm',
      // The buffer is written as straight (non-premultiplied) alpha and Pixi
      // uploads it as such, so the two must agree or a translucent zone marker
      // comes out with the wrong opacity.
      alphaMode: 'premultiply-alpha-on-upload',
    });
    return new Texture({ source });
  }
}
