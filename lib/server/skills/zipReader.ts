import { inflateRawSync } from "node:zlib";
import { SKILL_ARCHIVE_MAX_BYTES, SKILL_ARCHIVE_MAX_ENTRIES, SKILL_FILE_MAX_BYTES } from "../../contracts/skills";
import { isSafeWorkspaceRelativePath } from "../../domain/workspace";
import { crc32 } from "../artifacts/zip";
import { SkillBundleError, skillLimit } from "./bundleErrors";

export type SkillImportFile = { path: string; bytes: Buffer; executable?: boolean };

function invalid(code = "skill_archive_invalid"): never {
  throw new SkillBundleError({ code });
}

function checkExtra(bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) invalid();
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    if (id === 0x0001) invalid("skill_zip64_unsupported");
    offset += 4 + size;
    if (offset > bytes.length) invalid();
  }
}

/** In-memory reader with declared AND actual expansion bounds. No disk extraction. */
export function readSkillZip(bytes: Buffer): SkillImportFile[] {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      end = index;
      break;
    }
  }
  if (end < 0) invalid();
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) invalid("skill_zip64_unsupported");
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) invalid();
  if (start + size !== end || (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)) invalid();
  skillLimit("archiveEntries", count, SKILL_ARCHIVE_MAX_ENTRIES);
  let cursor = start;
  let expanded = 0;
  const files: SkillImportFile[] = [];
  const ranges: Array<readonly [number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const system = bytes.readUInt16LE(cursor + 4) >>> 8;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const packed = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const local = bytes.readUInt32LE(cursor + 42);
    if (packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff || disk === 0xffff) invalid("skill_zip64_unsupported");
    if (disk !== 0 || flags & (1 | 0x40 | 0x2000)) invalid("skill_archive_encrypted");
    if (method !== 0 && method !== 8) invalid("skill_archive_compression_unsupported");
    if (cursor + 46 + nameLength + extraLength + commentLength > end) invalid();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let path: string;
    try { path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(nameBytes); } catch { invalid("skill_path_invalid"); }
    const directory = path.endsWith("/");
    const normalizedPath = directory ? path.slice(0, -1) : path;
    if (!isSafeWorkspaceRelativePath(normalizedPath) || /^[a-z]:/iu.test(normalizedPath)) invalid("skill_path_invalid");
    const mode = system === 3 || system === 19 ? attributes >>> 16 : 0;
    const type = mode & 0o170000;
    if (type !== 0 && type !== (directory ? 0o040000 : 0o100000)) invalid("skill_archive_special_file");
    checkExtra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) invalid();
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) invalid();
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + packed > start || localNameLength !== nameLength ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) invalid();
    checkExtra(bytes.subarray(local + 30 + localNameLength, dataStart));
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== packed || bytes.readUInt32LE(local + 22) !== unpacked)) invalid();
    const range: readonly [number, number] = [local, dataStart + packed];
    if (ranges.some(([from, to]) => from < range[1] && range[0] < to)) invalid();
    ranges.push(range);
    skillLimit("fileBytes", unpacked, SKILL_FILE_MAX_BYTES);
    skillLimit("archiveBytes", expanded + unpacked, SKILL_ARCHIVE_MAX_BYTES);
    let content: Buffer;
    const maximum = Math.min(SKILL_FILE_MAX_BYTES, SKILL_ARCHIVE_MAX_BYTES - expanded);
    try {
      content = method === 0 ? bytes.subarray(dataStart, dataStart + packed)
        : inflateRawSync(bytes.subarray(dataStart, dataStart + packed), { maxOutputLength: Math.max(1, maximum) });
    } catch { invalid("skill_archive_expansion_invalid"); }
    skillLimit("fileBytes", content.length, SKILL_FILE_MAX_BYTES);
    skillLimit("archiveBytes", expanded + content.length, SKILL_ARCHIVE_MAX_BYTES);
    if (content.length !== unpacked || crc32(content) !== crc) invalid("skill_archive_integrity_invalid");
    expanded += content.length;
    if (directory) { if (content.length !== 0) invalid(); continue; }
    files.push({ path, bytes: content, ...(system === 3 || system === 19 ? { executable: (mode & 0o111) !== 0 } : {}) });
  }
  if (cursor !== end) invalid();
  return files;
}
