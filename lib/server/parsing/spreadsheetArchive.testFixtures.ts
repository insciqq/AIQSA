import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { utils, write } from "xlsx";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const EOCD_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export type ZipFixtureFields = Readonly<{
  compressedSize: number;
  crc: number;
  extra: Buffer;
  flags: number;
  method: number;
  name: string;
  uncompressedSize: number;
}>;

export type ZipFixtureEntry = Readonly<{
  central?: Partial<ZipFixtureFields>;
  data: Buffer;
  dataDescriptor?: "signed" | "unsigned";
  local?: Partial<ZipFixtureFields>;
  method?: 0 | 8;
  name: string;
  payload?: Buffer;
}>;

export type ZipEntryFixture = Readonly<{ data: Buffer; name: string }>;

/** A small valid workbook whose first sheet has B2 = 10. */
export function salesWorkbookEntries(): ZipEntryFixture[] {
  const sheet = utils.aoa_to_sheet([
    ["Region", "Revenue"],
    ["North", 10],
    ["South", 20]
  ]);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sales");
  return zipEntries(write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer);
}

/** Reads a well-formed fixture archive; not a validating parser. */
export function zipEntries(archive: Buffer): ZipEntryFixture[] {
  const eocd = archive.lastIndexOf(EOCD_SIGNATURE_BYTES);
  const entries: ZipEntryFixture[] = [];
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < archive.readUInt16LE(eocd + 10); index += 1) {
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const local = archive.readUInt32LE(cursor + 42);
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) +
      archive.readUInt16LE(local + 28);
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      data: method === 8 ? inflateRawSync(payload) : Buffer.from(payload),
      name: archive.toString("utf8", cursor + 46, cursor + 46 + nameLength)
    });
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32);
  }
  return entries;
}

export function storedFields(data: Buffer, name: string): ZipFixtureFields {
  return {
    compressedSize: data.byteLength,
    crc: crc32(data),
    extra: Buffer.alloc(0),
    flags: 0,
    method: 0,
    name,
    uncompressedSize: data.byteLength
  };
}

export function localHeader(fields: ZipFixtureFields): Buffer {
  const name = Buffer.from(fields.name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(fields.flags, 6);
  header.writeUInt16LE(fields.method, 8);
  header.writeUInt32LE(fields.crc >>> 0, 14);
  header.writeUInt32LE(fields.compressedSize, 18);
  header.writeUInt32LE(fields.uncompressedSize, 22);
  header.writeUInt16LE(name.byteLength, 26);
  header.writeUInt16LE(fields.extra.byteLength, 28);
  return Buffer.concat([header, name, fields.extra]);
}

export function centralHeader(fields: ZipFixtureFields & Readonly<{ localOffset: number }>): Buffer {
  const name = Buffer.from(fields.name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(fields.flags, 8);
  header.writeUInt16LE(fields.method, 10);
  header.writeUInt32LE(fields.crc >>> 0, 16);
  header.writeUInt32LE(fields.compressedSize, 20);
  header.writeUInt32LE(fields.uncompressedSize, 24);
  header.writeUInt16LE(name.byteLength, 28);
  header.writeUInt16LE(fields.extra.byteLength, 30);
  header.writeUInt32LE(fields.localOffset, 42);
  return Buffer.concat([header, name, fields.extra]);
}

export function endOfCentralDirectory(input: Readonly<{
  comment?: Buffer;
  commentLength?: number;
  count: number;
  offset: number;
  size: number;
}>): Buffer {
  const comment = input.comment ?? Buffer.alloc(0);
  const record = Buffer.alloc(22);
  record.writeUInt32LE(EOCD_SIGNATURE, 0);
  record.writeUInt16LE(input.count, 8);
  record.writeUInt16LE(input.count, 10);
  record.writeUInt32LE(input.size, 12);
  record.writeUInt32LE(input.offset, 16);
  record.writeUInt16LE(input.commentLength ?? comment.byteLength, 20);
  return Buffer.concat([record, comment]);
}

/** A ZIP64 extended-information extra field carrying 64-bit values. */
export function zip64Extra(...values: readonly bigint[]): Buffer {
  const field = Buffer.alloc(4 + 8 * values.length);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, index) => field.writeBigUInt64LE(value, 4 + 8 * index));
  return field;
}

function dataDescriptor(fields: ZipFixtureFields, signed: boolean): Buffer {
  const descriptor = Buffer.alloc(signed ? 16 : 12);
  let cursor = 0;
  if (signed) {
    descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
    cursor = 4;
  }
  descriptor.writeUInt32LE(fields.crc >>> 0, cursor);
  descriptor.writeUInt32LE(fields.compressedSize, cursor + 4);
  descriptor.writeUInt32LE(fields.uncompressedSize, cursor + 8);
  return descriptor;
}

/**
 * Lays out local headers, payloads and optional descriptors in order, then the
 * directory. Overrides apply to one header only, which models disagreement.
 */
export function zipArchive(
  entries: readonly ZipFixtureEntry[],
  options: Readonly<{ comment?: Buffer; commentLength?: number }> = {}
): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(entry.data) : entry.data);
    const base: ZipFixtureFields = {
      compressedSize: payload.byteLength,
      crc: crc32(entry.data),
      extra: Buffer.alloc(0),
      flags: entry.dataDescriptor ? 0x0008 : 0,
      method,
      name: entry.name,
      uncompressedSize: entry.data.byteLength
    };
    const local = localHeader({
      ...base,
      ...(entry.dataDescriptor ? { compressedSize: 0, crc: 0, uncompressedSize: 0 } : {}),
      ...entry.local
    });
    const descriptor = entry.dataDescriptor
      ? dataDescriptor(base, entry.dataDescriptor === "signed")
      : Buffer.alloc(0);
    directory.push(centralHeader({ ...base, ...entry.central, localOffset: offset }));
    parts.push(local, payload, descriptor);
    offset += local.byteLength + payload.byteLength + descriptor.byteLength;
  }
  const centralDirectory = Buffer.concat(directory);
  return Buffer.concat([
    ...parts,
    centralDirectory,
    endOfCentralDirectory({
      ...(options.comment ? { comment: options.comment } : {}),
      ...(options.commentLength === undefined ? {} : { commentLength: options.commentLength }),
      count: entries.length,
      offset,
      size: centralDirectory.byteLength
    })
  ]);
}

/** Structural facts about an archive produced by the canonicalizer. */
export function describeArchive(archive: Buffer): Readonly<{
  commentLength: number;
  directorySignatures: number;
  entries: readonly Readonly<{
    centralExtra: number;
    flags: number;
    localExtra: number;
    localFlags: number;
    localMethod: number;
    method: number;
  }>[];
}> {
  const eocd = archive.byteLength - 22;
  let directorySignatures = 0;
  for (let index = archive.indexOf(EOCD_SIGNATURE_BYTES); index >= 0;
    index = archive.indexOf(EOCD_SIGNATURE_BYTES, index + 1)) directorySignatures += 1;
  const entries = [];
  let cursor = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < archive.readUInt16LE(eocd + 10); index += 1) {
    const local = archive.readUInt32LE(cursor + 42);
    entries.push({
      centralExtra: archive.readUInt16LE(cursor + 30),
      flags: archive.readUInt16LE(cursor + 8),
      localExtra: archive.readUInt16LE(local + 28),
      localFlags: archive.readUInt16LE(local + 6),
      localMethod: archive.readUInt16LE(local + 8),
      method: archive.readUInt16LE(cursor + 10)
    });
    cursor += 46 + archive.readUInt16LE(cursor + 28) + archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32);
  }
  return { commentLength: archive.readUInt16LE(eocd + 20), directorySignatures, entries };
}
