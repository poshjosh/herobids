/**
 * Minimal in-memory tar archive creator.
 *
 * Implements the POSIX ustar format (IEEE 1003.1-1988) at the level needed
 * for Docker's `PUT /containers/{id}/archive` endpoint:
 *   - 512-byte header blocks
 *   - File data padded to 512-byte boundary
 *   - Two zero-filled 512-byte blocks at the end (EOF marker)
 *
 * Only regular files (typeflag '0') are supported. Directory entries are
 * created implicitly by parent path prefixes — the caller must include
 * explicit directory entries if needed.
 */

const BLOCK_SIZE = 512;
const HEADER_SIZE = 512;
const NAME_LENGTH = 100;
const MODE_LENGTH = 8;
const UID_LENGTH = 8;
const GID_LENGTH = 8;
const SIZE_LENGTH = 12;
const MTIME_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const MAGIC_OFFSET = 257;
const VERSION_OFFSET = 263;
const DEVMAJOR_LENGTH = 8;
const DEVMINOR_LENGTH = 8;

/**
 * Zero-padded octal string of the given length.
 * Throws if the value exceeds the representable width.
 */
function toOctal(value: number, length: number): string {
  const oct = value.toString(8);
  if (oct.length > length - 1) {
    throw new Error(`Value ${value} exceeds ${length - 1} octal digits for tar field`);
  }
  return oct.padStart(length - 1, '0') + '\0';
}

/**
 * Compute the ustar header checksum.
 *
 * The checksum is the sum of all 512 bytes of the header, treating
 * the 8-byte chksum field (at offset 148) as eight ASCII space (0x20) bytes.
 */
function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) {
    // chksum field occupies bytes 148–155 — treat as spaces
    if (i >= 148 && i < 156) {
      sum += 0x20;
    } else {
      sum += header[i]!;
    }
  }
  return sum;
}

/**
 * Set the checksum field in the header buffer.
 * The chksum field is 6 octal digits + null + space, left-padded with zeros.
 */
function setChecksum(header: Buffer): void {
  const cksum = computeChecksum(header);
  // toOctal(cksum, 7) always produces exactly 7 chars (6 octal digits + null);
  // append one space for the standard 8-byte chksum field.
  const cksumStr = toOctal(cksum, 7) + ' ';
  Buffer.from(cksumStr.slice(0, 8)).copy(header, 148);
}

/**
 * Pad a buffer to the next 512-byte boundary with zeros.
 */
function padToBlock(buf: Buffer): Buffer {
  const remainder = buf.length % BLOCK_SIZE;
  if (remainder === 0) return buf;
  const padding = Buffer.alloc(BLOCK_SIZE - remainder);
  return Buffer.concat([buf, padding]);
}

export interface TarEntry {
  /** Full path inside the archive (e.g. "docs/original/foo/bar.pdf"). */
  name: string;
  /** File body. */
  body: Buffer;
  /** Unix file mode (default: 0o644 for regular files). */
  mode?: number;
  /** Modification time as Unix epoch seconds (default: 0). */
  mtime?: number;
}

/**
 * Create a minimal ustar tar archive in memory.
 *
 * Docker's putArchive endpoint requires a tar archive. This function builds
 * one without external dependencies. Only regular files are supported;
 * directories are created implicitly by Docker when extracting.
 */
export function createTarArchive(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    if (entry.name.length > NAME_LENGTH) {
      throw new Error(`Tar entry name exceeds ${NAME_LENGTH} characters: ${entry.name}`);
    }

    // Assemble the 512-byte header
    const header = Buffer.alloc(HEADER_SIZE);

    // Name (100 bytes)
    const nameBytes = Buffer.from(entry.name, 'utf-8');
    nameBytes.copy(header, 0);

    // Mode (8 bytes)
    const mode = entry.mode ?? 0o644;
    Buffer.from(toOctal(mode, MODE_LENGTH)).copy(header, 100);

    // UID (8 bytes) — use root
    Buffer.from(toOctal(0, UID_LENGTH)).copy(header, 108);

    // GID (8 bytes) — use root
    Buffer.from(toOctal(0, GID_LENGTH)).copy(header, 116);

    // Size (12 bytes)
    Buffer.from(toOctal(entry.body.length, SIZE_LENGTH)).copy(header, 124);

    // Mtime (12 bytes)
    Buffer.from(toOctal(entry.mtime ?? 0, MTIME_LENGTH)).copy(header, 136);

    // Chksum (8 bytes) — filled after the rest of the header is built
    // Temporarily fill with spaces so checksum calculation is correct
    header.fill(0x20, 148, 156);

    // Typeflag (1 byte) — '0' = regular file
    header[TYPEFLAG_OFFSET] = 0x30; // '0'

    // Linkname (100 bytes) — unused, already zeroed

    // Magic (6 bytes) — "ustar\0"
    Buffer.from('ustar\0').copy(header, MAGIC_OFFSET);

    // Version (2 bytes) — "00"
    header[VERSION_OFFSET] = 0x30; // '0'
    header[VERSION_OFFSET + 1] = 0x30; // '0'

    // Uname (32 bytes) — "root"
    Buffer.from('root').copy(header, 265);

    // Gname (32 bytes) — "root"
    Buffer.from('root').copy(header, 297);

    // Devmajor (8 bytes) — zero
    Buffer.from(toOctal(0, DEVMAJOR_LENGTH)).copy(header, 329);

    // Devminor (8 bytes) — zero
    Buffer.from(toOctal(0, DEVMINOR_LENGTH)).copy(header, 337);

    // Prefix (155 bytes) — unused, already zeroed
    // Remaining 12 bytes after prefix are also zeroed

    // Now compute and set the real checksum
    setChecksum(header);

    blocks.push(header);
    blocks.push(padToBlock(entry.body));
  }

  // Two zero-filled 512-byte blocks mark the end of the archive
  blocks.push(Buffer.alloc(BLOCK_SIZE));
  blocks.push(Buffer.alloc(BLOCK_SIZE));

  return Buffer.concat(blocks);
}
