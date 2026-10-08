import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "../../domain/crc32";
import { writeZip } from "./zip";
import { ARTIFACT_ZIP_LIMITS, ArtifactZipError, readZipArchive, type ArtifactZipErrorCode, type ZipReadLimits } from "./zipReader";

type RawEntry = {
  name: string | Buffer;
  bytes?: Buffer;
  method?: number;
  flags?: number;
  packed?: number;
  unpacked?: number;
  crc?: number;
  compressed?: Buffer;
  attributes?: number;
  madeBy?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  descriptorSignature?: boolean;
};

/** Tiny ZIP fixture writer; intentionally permits inconsistent declarations. */
function rawZip(entries: RawEntry[], comment = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const bytes = entry.bytes ?? Buffer.from("data");
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0x0800;
    const compressed = entry.compressed ?? (method === 8 ? deflateRawSync(bytes) : bytes);
    const packed = entry.packed ?? compressed.length;
    const unpacked = entry.unpacked ?? bytes.length;
    const crc = entry.crc ?? crc32(bytes);
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed, 18);
      local.writeUInt32LE(unpacked, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (flags & 8) {
      const start = entry.descriptorSignature === false ? 0 : 4;
      descriptor = Buffer.alloc(start + 12);
      if (start) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, start);
      descriptor.writeUInt32LE(packed, start + 4);
      descriptor.writeUInt32LE(unpacked, start + 8);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(entry.madeBy ?? 0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed, 20);
    central.writeUInt32LE(unpacked, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(entry.attributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, localExtra, compressed, descriptor);
    directory.push(central, name, centralExtra);
    offset += local.length + name.length + localExtra.length + compressed.length + descriptor.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, centralBytes, end, comment]);
}

function directoryStart(archive: Buffer): number {
  return archive.readUInt32LE(archive.length - 6);
}

async function expectFailure(archive: Uint8Array, code: ArtifactZipErrorCode, path?: string, limits?: ZipReadLimits): Promise<void> {
  const error: unknown = await readZipArchive(archive, limits).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ArtifactZipError);
  expect(error).toMatchObject({ name: "ArtifactZipError", message: code, code, ...(path !== undefined ? { path } : {}) });
}

describe("readZipArchive", () => {
  it("round trips the export writer, sorts paths, and preserves binary and empty files", async () => {
    const files = [
      { path: "index.html", bytes: Buffer.from("<h1>Example</h1>") },
      { path: "assets/image.bin", bytes: Buffer.from([0, 128, 255, 42]) },
      { path: "assets/css/main.css", bytes: Buffer.from("body { color: red; }") },
      { path: "empty.txt", bytes: Buffer.alloc(0) }
    ];
    const archive = writeZip(files);
    const padded = Buffer.concat([Buffer.alloc(7), archive, Buffer.alloc(11)]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, archive.length);
    const result = await readZipArchive(view);
    expect(result).toEqual({ entries: [files[2], files[1], files[3], files[0]], strippedRoot: null, skipped: 0 });
    expect(result.entries.every(entry => Buffer.isBuffer(entry.bytes))).toBe(true);
  });

  it("reads stored and deflated entries together, with optional extra fields", async () => {
    const extra = Buffer.from([0xfe, 0xca, 2, 0, 1, 2]);
    const archive = rawZip([
      { name: "index.html", bytes: Buffer.from("index"), flags: 0, localExtra: extra, centralExtra: extra },
      { name: "assets/main.js", bytes: Buffer.from("script"), method: 8 },
      { name: "empty", bytes: Buffer.alloc(0) }
    ]);
    const result = await readZipArchive(archive);
    archive.fill(0);
    expect(result).toEqual({
      entries: [
        { path: "assets/main.js", bytes: Buffer.from("script") },
        { path: "empty", bytes: Buffer.alloc(0) },
        { path: "index.html", bytes: Buffer.from("index") }
      ], strippedRoot: null, skipped: 0
    });
  });

  it("strips exactly one common folder after filtering", async () => {
    const archive = writeZip([
      { path: "site/assets/css/main.css", bytes: Buffer.from("css") },
      { path: "site/index.html", bytes: Buffer.from("html") },
      { path: "__MACOSX/site/._index.html", bytes: Buffer.alloc(0) },
      { path: ".DS_Store", bytes: Buffer.alloc(0) }
    ]);
    expect(await readZipArchive(archive)).toEqual({
      entries: [{ path: "assets/css/main.css", bytes: Buffer.from("css") }, { path: "index.html", bytes: Buffer.from("html") }],
      strippedRoot: "site", skipped: 2
    });
    expect(await readZipArchive(writeZip([{ path: "site/nested/index.html", bytes: Buffer.alloc(0) }]))).toMatchObject({
      entries: [{ path: "nested/index.html" }], strippedRoot: "site"
    });
  });

  it.each([["one/a", "two/b"], ["site/a", "root.txt"], ["One/a", "one/b"]])("does not strip distinct roots %j", async (a, b) => {
    expect((await readZipArchive(rawZip([{ name: a }, { name: b }]))).strippedRoot).toBeNull();
  });

  it("counts directories and macOS metadata as skipped without inflating them", async () => {
    const skipped = ["site/", "__MACOSX/", "__MACOSX/file", "site/__MACOSX/file", ".DS_Store", "site/.DS_Store", "._x", "site/._x"];
    const archive = rawZip([
      ...skipped.map(name => ({ name, method: 8, compressed: Buffer.from([0xff]), unpacked: 100_000_000 })),
      { name: "site/index.html" }
    ]);
    expect(await readZipArchive(archive)).toEqual({ entries: [{ path: "index.html", bytes: Buffer.from("data") }], strippedRoot: "site", skipped: 8 });
  });

  it("counts retained files separately from the bounded raw entry count", async () => {
    const limits = { ...ARTIFACT_ZIP_LIMITS, maxEntries: 1 };
    expect(await readZipArchive(rawZip([
      { name: "site/index.html" }, { name: "site/" }, { name: "__MACOSX/x" }, { name: "site/.DS_Store" }
    ]), limits)).toMatchObject({ skipped: 3, entries: [{ path: "index.html" }] });
    await expectFailure(rawZip(Array.from({ length: 5 }, (_, i) => ({ name: `__MACOSX/${i}` }))), "artifact_zip_entry_limit_exceeded", undefined, limits);
  });

  it.each([0, 8])("honours signed and signatureless data descriptors for method %i", async method => {
    for (const descriptorSignature of [true, false]) {
      const bytes = Buffer.from("descriptor data");
      expect(await readZipArchive(rawZip([{ name: "file", method, flags: 0x0808, bytes, descriptorSignature }]))).toEqual({
        entries: [{ path: "file", bytes }], strippedRoot: null, skipped: 0
      });
    }
  });

  it("checks actual size and CRC with data descriptors", async () => {
    await expectFailure(rawZip([{ name: "file", flags: 8, method: 8, unpacked: 1 }]), "artifact_zip_size_mismatch", "file");
    await expectFailure(rawZip([{ name: "file", flags: 8, crc: 0 }]), "artifact_zip_crc_mismatch", "file");
  });

  it("accepts a maximum-length EOCD comment containing a false signature", async () => {
    const comment = Buffer.alloc(65_535, 65);
    comment.writeUInt32LE(0x06054b50, 200);
    expect((await readZipArchive(rawZip([{ name: "file" }], comment))).entries).toHaveLength(1);
  });

  it("decodes UTF-8 names and preserves a leading BOM as part of the name", async () => {
    const result = await readZipArchive(writeZip([
      { path: "страница.html", bytes: Buffer.from("ok") }, { path: "\ufeffindex.html", bytes: Buffer.alloc(0) }
    ]));
    expect(result.entries.map(entry => entry.path)).toEqual(["страница.html", "\ufeffindex.html"]);
  });
});

describe("ZIP expansion and integrity bounds", () => {
  it("rejects a 10 MiB deflate bomb before decompression", async () => {
    const archive = rawZip([{ name: "bomb", method: 8, bytes: Buffer.alloc(10 * 1024 * 1024), crc: 0 }]);
    await expectFailure(archive, "artifact_zip_compression_ratio_exceeded", "bomb");
  });

  it("rejects 501 retained files and caps raw directory work at 2000 entries", async () => {
    await expectFailure(rawZip(Array.from({ length: 501 }, (_, i) => ({ name: `${i}.txt`, bytes: Buffer.alloc(0) }))), "artifact_zip_entry_limit_exceeded", "500.txt");
    await expectFailure(rawZip(Array.from({ length: 2001 }, (_, i) => ({ name: `__MACOSX/${i}`, bytes: Buffer.alloc(0) }))), "artifact_zip_entry_limit_exceeded");
  });

  it("rejects declared single-file and total byte excess using tiny archives", async () => {
    await expectFailure(rawZip([{ name: "large", method: 8, unpacked: 24 * 1024 * 1024 + 1 }]), "artifact_zip_entry_too_large", "large");
    // Padded compressed declarations stay below the ratio cap; no output is allocated.
    const entries = ["first", "second"].map(name => ({ name, method: 8, compressed: Buffer.alloc(180_000), unpacked: 17 * 1024 * 1024 }));
    await expectFailure(rawZip(entries), "artifact_zip_total_too_large", "second");
  });

  it("preflights all retained files before inflating the first", async () => {
    await expectFailure(rawZip([
      { name: "invalid-deflate", method: 8, compressed: Buffer.from([0xff]) },
      { name: "too-large", method: 8, unpacked: ARTIFACT_ZIP_LIMITS.maxEntryBytes + 1 }
    ]), "artifact_zip_entry_too_large", "too-large");
  });

  it.each([0, 1, 3, 5, 20])("rejects declared size %i for four actual deflated bytes", async unpacked => {
    await expectFailure(rawZip([{ name: "file", method: 8, unpacked }]), "artifact_zip_size_mismatch", "file");
  });

  it("bounds an understated expansion far below its actual output", async () => {
    await expectFailure(rawZip([{ name: "file", method: 8, bytes: Buffer.alloc(1024 * 1024), unpacked: 1, crc: 0 }]), "artifact_zip_size_mismatch", "file");
  });

  it("requires identical compressed and uncompressed sizes for stored files", async () => {
    await expectFailure(rawZip([{ name: "file", unpacked: 3 }]), "artifact_zip_size_mismatch", "file");
  });

  it.each([0, 8])("checks CRC for method %i without exposing contents", async method => {
    await expectFailure(rawZip([{ name: "file", bytes: Buffer.from("private contents"), method, crc: 0 }]), "artifact_zip_crc_mismatch", "file");
  });

  it("rejects invalid or incomplete deflate streams with typed errors", async () => {
    for (const compressed of [Buffer.from([0xff]), Buffer.alloc(0), deflateRawSync(Buffer.from("data")).subarray(0, 3)]) {
      await expectFailure(rawZip([{ name: "file", method: 8, compressed }]), "artifact_zip_invalid", "file");
    }
  });

  it("honours custom size, ratio, and floor boundaries", async () => {
    const archive = rawZip([{ name: "a", bytes: Buffer.from("1234") }, { name: "b", bytes: Buffer.alloc(0) }]);
    const limits = { maxEntries: 2, maxEntryBytes: 4, maxTotalBytes: 4, maxCompressionRatio: 1, ratioFloorBytes: 0 };
    expect((await readZipArchive(archive, limits)).entries).toHaveLength(2);
    await expectFailure(archive, "artifact_zip_entry_too_large", "a", { ...limits, maxEntryBytes: 3 });
    await expectFailure(archive, "artifact_zip_total_too_large", "a", { ...limits, maxTotalBytes: 3 });
    await expectFailure(archive, "artifact_zip_compression_ratio_exceeded", "a", { ...limits, maxCompressionRatio: 0.5 });
    expect((await readZipArchive(archive, { ...limits, ratioFloorBytes: 4, maxCompressionRatio: 0.5 })).entries).toHaveLength(2);
    await expectFailure(rawZip([{ name: "file", method: 8, compressed: Buffer.alloc(0), unpacked: 1 }]), "artifact_zip_compression_ratio_exceeded", "file", limits);
  });

  it.each([
    { maxEntries: 0 }, { maxEntries: 1.5 }, { maxEntryBytes: -1 }, { maxTotalBytes: NaN },
    { maxCompressionRatio: Infinity }, { maxCompressionRatio: 0 }, { ratioFloorBytes: -1 }
  ])("rejects invalid limit configuration %j", async overrides => {
    await expectFailure(rawZip([{ name: "file" }]), "artifact_zip_limits_invalid", undefined, { ...ARTIFACT_ZIP_LIMITS, ...overrides });
  });
});

describe("ZIP path safety", () => {
  it.each([
    "../escape", "a/../escape", "./file", "a/./file", "/absolute", "\\absolute", "a\\b", "C:relative", "C:/absolute",
    "site/C:relative", "a//b", "", "a//", "/", "a\0b", "a\nb", "a\tb", "a\u007fb", "a\u0085b", "a".repeat(513), "é".repeat(257)
  ])("rejects unsafe paths %j", async name => {
    await expectFailure(rawZip([{ name }]), "artifact_zip_path_invalid");
  });

  it("accepts a 512-byte path", async () => {
    const path = "a".repeat(512);
    expect((await readZipArchive(rawZip([{ name: path }]))).entries[0]!.path).toBe(path);
  });

  it.each([Buffer.from([0xff, 0xfe]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])])("rejects invalid UTF-8 %j", async name => {
    await expectFailure(rawZip([{ name, flags: 0x0800 }]), "artifact_zip_path_invalid");
  });

  it.each([Buffer.from("café"), Buffer.from([0x80]), Buffer.from([0x1f]), Buffer.from([0x7f])])("requires printable ASCII without the UTF-8 flag: %j", async name => {
    await expectFailure(rawZip([{ name, flags: 0 }]), "artifact_zip_path_invalid");
  });

  it.each(["link", "dir/", "__MACOSX/link"])("rejects Unix symlinks even when filtered: %s", async name => {
    await expectFailure(rawZip([{ name, madeBy: 0x0314, attributes: (0xa1ff << 16) >>> 0 }]), "artifact_zip_symlink", name);
  });

  it("interprets Unix mode only for the Unix host", async () => {
    expect((await readZipArchive(rawZip([{ name: "file", madeBy: 20, attributes: (0xa1ff << 16) >>> 0 }]))).entries).toHaveLength(1);
  });

  it.each([
    ["file", "file"], ["File", "file"], ["é", "É"], ["a", "a/b"], ["a/b", "a"],
    ["A/b", "a"], ["A", "a/b"], ["a/", "a"], ["a", "a/"], ["a/", "A/"]
  ])("rejects duplicate paths and file/directory collisions %j", async (a, b) => {
    await expectFailure(rawZip([{ name: a }, { name: b }]), "artifact_zip_duplicate_path", b);
  });

  it("allows explicit directories before or after their children", async () => {
    for (const names of [["a/", "a/b", "a/c"], ["a/b", "a/", "a/c"]]) {
      expect(await readZipArchive(rawZip(names.map(name => ({ name }))))).toMatchObject({
        entries: [{ path: "b" }, { path: "c" }], skipped: 1, strippedRoot: "a"
      });
    }
  });

  it("validates filtered paths before skipping", async () => {
    await expectFailure(rawZip([{ name: "__MACOSX/../file" }, { name: "ok" }]), "artifact_zip_path_invalid", "__MACOSX/../file");
  });
});

describe("ZIP structure and cancellation", () => {
  it.each([1, 0x40, 0x2000])("rejects encryption flag %i", async flags => {
    await expectFailure(rawZip([{ name: "file", flags }]), "artifact_zip_encrypted", "file");
  });

  it("rejects unsupported compression", async () => {
    await expectFailure(rawZip([{ name: "file", method: 12 }]), "artifact_zip_compression_unsupported", "file");
  });

  it.each(["packed", "unpacked"] as const)("rejects ZIP64 %s markers", async field => {
    await expectFailure(rawZip([{ name: "file", [field]: 0xffffffff }]), "artifact_zip_zip64_unsupported", "file");
  });

  it.each([4, 6, 8, 10, 12, 16])("rejects ZIP64 EOCD marker at offset %i", async offset => {
    const archive = rawZip([{ name: "file" }]);
    if (offset < 12) archive.writeUInt16LE(0xffff, archive.length - 22 + offset);
    else archive.writeUInt32LE(0xffffffff, archive.length - 22 + offset);
    await expectFailure(archive, "artifact_zip_zip64_unsupported");
  });

  it.each(["localExtra", "centralExtra"] as const)("rejects ZIP64 extra fields in %s", async field => {
    await expectFailure(rawZip([{ name: "file", [field]: Buffer.from([1, 0, 0, 0]) }]), "artifact_zip_zip64_unsupported", "file");
  });

  it("rejects a ZIP64 locator without marker sizes", async () => {
    const archive = rawZip([{ name: "file" }]);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50);
    await expectFailure(Buffer.concat([archive.subarray(0, -22), locator, archive.subarray(-22)]), "artifact_zip_zip64_unsupported");
  });

  it.each([18, 22])("rejects local ZIP64 size markers at offset %i", async offset => {
    const archive = rawZip([{ name: "file", flags: 8 }]);
    archive.writeUInt32LE(0xffffffff, offset);
    await expectFailure(archive, "artifact_zip_zip64_unsupported", "file");
  });

  it.each([34, 42])("rejects central ZIP64 markers at offset %i", async offset => {
    const archive = rawZip([{ name: "file" }]);
    if (offset === 34) archive.writeUInt16LE(0xffff, directoryStart(archive) + offset);
    else archive.writeUInt32LE(0xffffffff, directoryStart(archive) + offset);
    await expectFailure(archive, "artifact_zip_zip64_unsupported", "file");
  });

  it.each([4, 6, 8])("rejects multi-disk EOCD fields at offset %i", async offset => {
    const archive = rawZip([{ name: "file" }]);
    archive.writeUInt16LE(2, archive.length - 22 + offset);
    await expectFailure(archive, "artifact_zip_multidisk_unsupported");
  });

  it("rejects a central-directory entry on another disk", async () => {
    const archive = rawZip([{ name: "file" }]);
    archive.writeUInt16LE(1, directoryStart(archive) + 34);
    await expectFailure(archive, "artifact_zip_multidisk_unsupported", "file");
  });

  it("rejects every truncation of a small archive", async () => {
    const archive = rawZip([{ name: "file" }]);
    for (let length = 0; length < archive.length; length++) {
      await expectFailure(archive.subarray(0, length), "artifact_zip_invalid");
    }
  });

  it.each([0, 6, 8, 14, 18, 22, 26, 28, 30])("cross-checks local header field at offset %i", async offset => {
    const archive = rawZip([{ name: "file" }]);
    archive[offset] = archive[offset]! ^ 1;
    await expectFailure(archive, "artifact_zip_invalid", "file");
  });

  it.each(["localExtra", "centralExtra"] as const)("rejects malformed extra fields in %s", async field => {
    for (const extra of [Buffer.from([2]), Buffer.from([2, 0, 2, 0, 1])]) {
      await expectFailure(rawZip([{ name: "file", [field]: extra }]), "artifact_zip_invalid", "file");
    }
  });

  it("rejects inconsistent data descriptors", async () => {
    const archive = rawZip([{ name: "file", flags: 8 }]);
    archive[directoryStart(archive) - 1] = 1;
    await expectFailure(archive, "artifact_zip_invalid", "file");
  });

  it("rejects local headers or data extending into the central directory", async () => {
    const badOffset = rawZip([{ name: "file" }]);
    badOffset.writeUInt32LE(directoryStart(badOffset), directoryStart(badOffset) + 42);
    await expectFailure(badOffset, "artifact_zip_invalid", "file");
    await expectFailure(rawZip([{ name: "file", packed: 1000, unpacked: 1000 }]), "artifact_zip_invalid", "file");
  });

  it("rejects overlapping entries, including a header embedded in another entry's data", async () => {
    const archive = rawZip([{ name: "a", bytes: Buffer.alloc(40) }, { name: "b", bytes: Buffer.alloc(0) }]);
    const central = directoryStart(archive);
    const secondCentral = central + 47;
    const secondLocal = archive.readUInt32LE(secondCentral + 42);
    archive.copy(archive, 32, secondLocal, secondLocal + 31);
    archive.writeUInt32LE(32, secondCentral + 42);
    await expectFailure(archive, "artifact_zip_invalid", "b");
  });

  it("rejects broken central-directory signatures, lengths, offsets, and entry counts", async () => {
    for (const mutate of [
      (archive: Buffer) => archive.writeUInt32LE(0, directoryStart(archive)),
      (archive: Buffer) => archive.writeUInt16LE(0xffff, directoryStart(archive) + 30),
      (archive: Buffer) => archive.writeUInt32LE(0, archive.length - 6),
      (archive: Buffer) => archive.writeUInt32LE(0, archive.length - 10),
      (archive: Buffer) => { archive.writeUInt16LE(0, archive.length - 14); archive.writeUInt16LE(0, archive.length - 12); },
      (archive: Buffer) => { archive.writeUInt16LE(2, archive.length - 14); archive.writeUInt16LE(2, archive.length - 12); }
    ]) {
      const archive = rawZip([{ name: "file" }]);
      mutate(archive);
      await expectFailure(archive, "artifact_zip_invalid");
    }
  });

  it("rejects trailing bytes not declared in the EOCD comment", async () => {
    await expectFailure(Buffer.concat([rawZip([{ name: "file" }]), Buffer.from([0])]), "artifact_zip_invalid");
  });

  it("rejects archives empty before or after filtering", async () => {
    await expectFailure(writeZip([]), "artifact_zip_empty");
    await expectFailure(rawZip([{ name: "dir/" }, { name: ".DS_Store" }, { name: "__MACOSX/x" }, { name: "._x" }]), "artifact_zip_empty");
  });

  it("honours cancellation before parsing without exposing the abort reason", async () => {
    const controller = new AbortController();
    controller.abort("private abort reason");
    const error: unknown = await readZipArchive(Buffer.alloc(0), undefined, controller.signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ArtifactZipError);
    expect(error).toMatchObject({ code: "artifact_zip_aborted", message: "artifact_zip_aborted" });
  });

  it("checks cancellation after asynchronous inflation before returning files", async () => {
    const controller = new AbortController();
    const result = readZipArchive(writeZip([
      { path: "first", bytes: Buffer.from("first") }, { path: "second", bytes: Buffer.from("second") }
    ]), undefined, controller.signal);
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(ArtifactZipError);
    await expect(result).rejects.toMatchObject({ code: "artifact_zip_aborted", path: "first" });
  });
});
