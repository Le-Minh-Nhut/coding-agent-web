/**
 * A minimal PNG decoder, for one job: turn a presented frame into pixels so a
 * spec can decide whether the transcript area was actually painted.
 *
 * Why this exists at all: the owner's symptom is a *blank region during a fast
 * scroll*, and every DOM-based check reports the truth of the main thread — the
 * rows are mounted, positioned and styled correctly — while the user sees
 * background. Only the compositor's own output carries that fact, so a spec has
 * to read pixels. Chromium's screencast hands us PNGs; there is no installed
 * decoder in this repository and the alternative was a dependency for ~70 lines
 * of `zlib` + unfiltering, which this project does not pay for.
 *
 * Scope, deliberately: 8-bit non-interlaced RGB/RGBA/greyscale PNG, which is
 * what `Page.startScreencast` and `Page.captureScreenshot` produce. Anything
 * else throws with the reason rather than returning wrong pixels.
 */
import { inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major, `width * 4` bytes per row. */
  pixels: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error("decodePng: not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colourType = data[9]!;
      const interlace = data[12];
      channels = CHANNELS[colourType] ?? 0;
      if (depth !== 8) throw new Error(`decodePng: bit depth ${depth} unsupported`);
      if (channels === 0) throw new Error(`decodePng: colour type ${colourType} unsupported`);
      if (interlace !== 0) throw new Error("decodePng: interlaced PNG unsupported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error("decodePng: no IHDR");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let previous: Uint8Array<ArrayBuffer> = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]!;
    cursor += 1;
    // A fresh copy per row: the unfilter writes into it, so the inflated buffer
    // must not be mutated under a later row's `previous`.
    const line: Uint8Array<ArrayBuffer> = Uint8Array.prototype.slice.call(raw, cursor, cursor + stride);
    cursor += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels]! : 0;
      const up = previous[index]!;
      const upLeft = index >= channels ? previous[index - channels]! : 0;
      let value = line[index]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`decodePng: filter ${filter} unsupported`);
      line[index] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      if (channels === 1) {
        pixels[to] = pixels[to + 1] = pixels[to + 2] = line[from]!;
      } else if (channels === 2) {
        pixels[to] = pixels[to + 1] = pixels[to + 2] = line[from]!;
        pixels[to + 3] = line[from + 1]!;
      } else {
        pixels[to] = line[from]!;
        pixels[to + 1] = line[from + 1]!;
        pixels[to + 2] = line[from + 2]!;
        pixels[to + 3] = channels === 4 ? line[from + 3]! : 255;
      }
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** `#rrggbb` → `[r, g, b]`. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
