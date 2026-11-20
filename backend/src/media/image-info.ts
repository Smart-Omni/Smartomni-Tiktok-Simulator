/**
 * Identifies an uploaded picture from its bytes (never from the client's `mimetype` or file name) and reads its size.
 * Only JPEG, PNG and WebP are accepted. Returns undefined for anything else or for a truncated/corrupt header.
 */
export interface ImageInfo {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
}

export function imageInfo(buf: Buffer): ImageInfo | undefined {
  if (buf.length < 12) return undefined;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return png(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return jpeg(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return webp(buf);
  return undefined;
}

const sized = (mimeType: ImageInfo['mimeType'], width: number, height: number): ImageInfo | undefined =>
  width > 0 && height > 0 ? { mimeType, width, height } : undefined;

function png(buf: Buffer): ImageInfo | undefined {
  // IHDR is always the first chunk: length(4) type(4) width(4) height(4).
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return sized('image/png', buf.readUInt32BE(16), buf.readUInt32BE(20));
}

function jpeg(buf: Buffer): ImageInfo | undefined {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // end of image / start of scan before any frame header
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry precision(1) height(2) width(2).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) return undefined;
      return sized('image/jpeg', buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
    }
    i += 2 + len;
  }
  return undefined;
}

function webp(buf: Buffer): ImageInfo | undefined {
  if (buf.length < 30) return undefined;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Key frame: 3-byte frame tag, start code 9D 01 2A, then 14-bit width and height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    return sized('image/webp', buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    return sized('image/webp', buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1);
  }
  return undefined;
}
