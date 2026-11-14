// A small PNG encoder for the raw RGB bitmaps older Companion versions send. The controller and the
// panel take key images as PNG.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes 8-bit RGB pixels, row by row, as a PNG. */
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  if (rgb.length !== width * height * 3) throw new Error(`expected ${width * height * 3} bytes of RGB, got ${rgb.length}`);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // no filter
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * A KEY-STATE bitmap as PNG base64: Companion sends either a data: URL in the format the surface asked
 * for, or raw square RGB. Anything else (webp, a size that is not a square) gives undefined.
 */
export function bitmapToPng(bitmap: string): string | undefined {
  if (bitmap.startsWith('data:')) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(bitmap);
    return m?.[1];
  }
  const rgb = Buffer.from(bitmap, 'base64');
  const side = Math.round(Math.sqrt(rgb.length / 3));
  if (!side || side * side * 3 !== rgb.length) return undefined;
  return encodePng(rgb, side, side).toString('base64');
}
