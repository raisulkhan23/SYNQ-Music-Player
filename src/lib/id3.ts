/**
 * A minimal ID3v2.3 tag writer for MP3 files.
 *
 * WHY THIS EXISTS. melo embeds title/artist/album/artwork into its downloads
 * via ffmpeg. SYNQ downloads run entirely in the browser, where no ffmpeg
 * exists — but ID3v2 is a plain byte format, and a tag prepended to an MP3
 * stream is a valid MP3: every decoder skips the tag and starts at the first
 * frame sync. Writing ~40 lines of byte packing means a saved SoundCloud
 * release carries its name, its artist and its cover into whatever player
 * opens it next, instead of arriving as "01-track.mp3".
 *
 * The generated tag is prepended to the finished file in `opfsSink.ts`
 * (`prependToStoredDownload`), after the download engine's own integrity
 * checks — the tag is decoration on a verified file, never a participant in
 * the transfer.
 *
 * v2.3, not v2.4: every mainstream tagger and OS media library reads v2.3,
 * and its frame sizes are plain big-endian 32-bit ints (v2.4's syncsafe sizes
 * are a compatibility trap for older parsers).
 */

/** Text frames write UTF-16 with a BOM (encoding byte 0x01) so every
 * language survives; v2.3's default Latin-1 would corrupt anything else. */
function utf16Bytes(value: string): Uint8Array {
  // 0xFF 0xFE (BOM) + little-endian UTF-16, no terminator (the frame adds one).
  const encoded = new Uint16Array(value.length);
  for (let i = 0; i < value.length; i++) encoded[i] = value.charCodeAt(i);
  const bom = new Uint8Array([0xff, 0xfe]);
  const body = new Uint8Array(encoded.buffer);
  const out = new Uint8Array(bom.length + body.length + 2);
  out.set(bom, 0);
  out.set(body, bom.length);
  // UTF-16 terminator: two zero bytes.
  out[out.length - 2] = 0;
  out[out.length - 1] = 0;
  return out;
}

function frameId(id: string): Uint8Array {
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) bytes[i] = id.charCodeAt(i);
  return bytes;
}

/** One text frame: 4-byte id, 4-byte big-endian size, 2 flag bytes, payload. */
function textFrame(id: string, value: string): Uint8Array {
  const text = utf16Bytes(value);
  const size = text.length + 1; // + encoding byte
  const frame = new Uint8Array(10 + size);
  frame.set(frameId(id), 0);
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame[10] = 0x01; // UTF-16 with BOM
  frame.set(text, 11);
  return frame;
}

/** APIC (attached picture): encoding, mime (Latin-1), picture type, data. */
function apicFrame(imageBytes: Uint8Array, mime: string): Uint8Array {
  const mimeBytes = new Uint8Array(mime.length + 1);
  for (let i = 0; i < mime.length; i++) mimeBytes[i] = mime.charCodeAt(i);
  // mime is null-terminated by the +1 above; then picture type + description.
  const description = new Uint8Array([0x01, 0xff, 0xfe, 0x00, 0x00]);
  const size = 1 + mimeBytes.length + description.length + imageBytes.length;
  const frame = new Uint8Array(10 + size);
  frame.set(frameId("APIC"), 0);
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame[10] = 0x00; // picture data is binary; mime is Latin-1
  frame.set(mimeBytes, 11);
  frame.set(description, 11 + mimeBytes.length);
  frame.set(imageBytes, 11 + mimeBytes.length + description.length);
  return frame;
}

/** WXXX/TXXX frame carrying the licence URL — attribution travels with the file. */
function txxxFrame(description: string, url: string): Uint8Array {
  const desc = utf16Bytes(description);
  const value = utf16Bytes(url);
  const size = desc.length + value.length + 1;
  const frame = new Uint8Array(10 + size);
  frame.set(frameId("TXXX"), 0);
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame[10] = 0x01;
  frame.set(desc, 11);
  frame.set(value, 11 + desc.length);
  return frame;
}

/** v2.3 tag header: size is a SYNC-SAFE 32-bit int (7 bits per byte). */
function header(tagSize: number): Uint8Array {
  const head = new Uint8Array(10);
  head[0] = 0x49; // I
  head[1] = 0x44; // D
  head[2] = 0x33; // 3
  head[3] = 0x03; // version 2.3
  head[4] = 0x00;
  head[5] = 0x00; // no flags
  head[6] = (tagSize >>> 21) & 0x7f;
  head[7] = (tagSize >>> 14) & 0x7f;
  head[8] = (tagSize >>> 7) & 0x7f;
  head[9] = tagSize & 0x7f;
  return head;
}

/** What the tag knows about the track. All fields optional; empty in = empty out. */
export interface Id3TagInput {
  title?: string;
  artist?: string;
  album?: string;
  /** Track length in milliseconds (TLEN). */
  durationMs?: number;
  /** Cover-art bytes (JPEG or PNG — the mime must match the bytes). */
  artwork?: Uint8Array | null;
  /** "image/jpeg" or "image/png", required when artwork is present. */
  artworkMime?: string | null;
  /** A free-text note carried as a TXXX frame (e.g. attribution line). */
  comment?: string | null;
  /** Licence URL carried as a TXXX frame. */
  licenseUrl?: string | null;
}

/** Human-readable summary of what a tag was built from (for diagnostics). */
export function describeTagInput(input: Id3TagInput): string {
  return [input.artist, input.title].filter(Boolean).join(" — ") || "untagged";
}

/**
 * Build a complete ID3v2.3 tag, or return null when there is nothing to write
 * (no title, artist, album, artwork, duration, comment or licence — a tag of
 * nothing would just be dead bytes).
 */
export function buildId3Tag(input: Id3TagInput): Uint8Array | null {
  const frames: Uint8Array[] = [];
  if (input.title?.trim()) frames.push(textFrame("TIT2", input.title.trim()));
  if (input.artist?.trim()) frames.push(textFrame("TPE1", input.artist.trim()));
  if (input.album?.trim()) frames.push(textFrame("TALB", input.album.trim()));
  if (Number.isFinite(input.durationMs) && (input.durationMs ?? 0) > 0) {
    frames.push(textFrame("TLEN", String(Math.round(input.durationMs ?? 0))));
  }
  if (input.comment?.trim()) {
    frames.push(txxxFrame("SYNQ", input.comment.trim()));
  }
  if (input.licenseUrl?.trim()) {
    frames.push(txxxFrame("Licence", input.licenseUrl.trim()));
  }
  if (
    input.artwork &&
    input.artwork.length > 0 &&
    input.artworkMime &&
    /^(image\/(jpeg|png))$/.test(input.artworkMime)
  ) {
    frames.push(apicFrame(input.artwork, input.artworkMime));
  }
  if (frames.length === 0) return null;

  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const tag = new Uint8Array(10 + total);
  tag.set(header(total), 0);
  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }
  return tag;
}
