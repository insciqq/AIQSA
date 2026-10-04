// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildZip, recordingBlob } from "./archive.testFixtures";
import {
  crc32Update,
  DEFAULT_IMPORT_ARCHIVE_LIMITS,
  ImportArchiveError,
  type ImportArchive,
  type ImportArchiveEntry,
  type ImportEntrySelector
} from "./archiveTypes";
import { openZipArchive } from "./zipArchive";

const text = (entry: ImportArchiveEntry | undefined) =>
  entry?.kind === "data" ? new TextDecoder().decode(entry.bytes) : null;

async function read(archive: ImportArchive, select: ImportEntrySelector): Promise<ImportArchiveEntry[]> {
  const entries: ImportArchiveEntry[] = [];
  for await (const entry of archive.entries(select)) entries.push(entry);
  return entries;
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImportArchiveError) return error.code;
    throw error;
  }
  return "none";
}

describe("zip import archive", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32Update(0, new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32Update(crc32Update(0, new TextEncoder().encode("1234")), new TextEncoder().encode("56789"))).toBe(0xcbf43926);
  });

  it("lists by the central directory and reads only the selected entries", async () => {
    const zip = await buildZip([
      { content: "{\"a\":1}", path: "export_manifest.json" },
      { content: "x".repeat(50_000), method: 0, path: "chat.html" },
      { content: "", path: "folder/" },
      { content: "[1,2,3]", path: "conversations-000.json" },
      { content: "{}", method: 0, path: "./nested\\user.json" }
    ]);
    const recorded = recordingBlob(zip);
    const archive = await openZipArchive(recorded.blob);
    const seen: string[] = [];
    const entries = await read(archive, (entry) => {
      seen.push(entry.path);
      return entry.path.startsWith("conversations") || entry.path === "export_manifest.json" ? { maxBytes: 1_000 } : null;
    });
    expect(seen).toEqual(["export_manifest.json", "chat.html", "conversations-000.json", "nested/user.json"]);
    expect(entries.map((entry) => [entry.path, text(entry)])).toEqual([
      ["export_manifest.json", "{\"a\":1}"],
      ["conversations-000.json", "[1,2,3]"]
    ]);
    // The stored 50,000-byte entry's data was never sliced; only the end record, directory, headers and selected data were.
    expect(recorded.slices.filter(([start, end]) => end - start === 50_000)).toEqual([]);
    expect(recorded.slices.length).toBe(2 + 2 * 2);
  });

  it("reports an entry above its read bound as too large unread, or reads only a prefix", async () => {
    const archive = await openZipArchive(await buildZip([{ content: "0123456789".repeat(10), path: "big.json" }]));
    expect(await read(archive, () => ({ maxBytes: 10 }))).toEqual([{ kind: "too_large", path: "big.json", size: 100 }]);
    const [prefix] = await read(archive, () => ({ maxBytes: 12, prefix: true }));
    expect(prefix).toMatchObject({ kind: "data", truncated: true });
    expect(text(prefix)).toBe("012345678901");
  });

  it("refuses a selected entry whose compression ratio marks a zip bomb", async () => {
    const zip = await buildZip([{ content: new Uint8Array(4 * 1_024 * 1_024), path: "bomb.json" }, { content: "ok", path: "small.json" }]);
    const archive = await openZipArchive(zip);
    expect(text((await read(archive, (entry) => entry.path === "small.json" ? { maxBytes: 10 } : null))[0])).toBe("ok");
    expect(await failure(read(archive, () => ({ maxBytes: 8 * 1_024 * 1_024 })))).toBe("archive_ratio_exceeded");
  });

  it("never trusts declared sizes or checksums", async () => {
    const lying = await openZipArchive(await buildZip([{ content: "abcdefghij", declaredSize: 4, path: "lie.json" }]));
    expect(await failure(read(lying, () => ({ maxBytes: 100 })))).toBe("archive_entry_damaged");
    const corrupt = await openZipArchive(await buildZip([{ content: "abcdefghij", declaredCrc: 1, path: "crc.json" }]));
    expect(await failure(read(corrupt, () => ({ maxBytes: 100 })))).toBe("archive_entry_damaged");
  });

  it("refuses encrypted entries, too many entries and the total budget", async () => {
    const encrypted = await openZipArchive(await buildZip([{ content: "secret", flags: 1, path: "locked.json" }]));
    expect(await failure(read(encrypted, () => ({ maxBytes: 100 })))).toBe("archive_unsupported");
    const crowded = await buildZip([{ content: "a", path: "a" }, { content: "b", path: "b" }, { content: "c", path: "c" }]);
    expect(await failure(openZipArchive(crowded, { ...DEFAULT_IMPORT_ARCHIVE_LIMITS, maxEntries: 2 })))
      .toBe("archive_too_many_entries");
    const budgeted = await openZipArchive(await buildZip([{ content: "x".repeat(600), path: "a" }, { content: "y".repeat(600), path: "b" }]),
      { ...DEFAULT_IMPORT_ARCHIVE_LIMITS, maxTotalBytes: 1_000 });
    expect(await failure(read(budgeted, () => ({ maxBytes: 10_000 })))).toBe("archive_too_large");
  });

  it("reads ZIP64 records and refuses what is not a zip", async () => {
    const archive = await openZipArchive(await buildZip([{ content: "zip64 body", path: "conversations.json" }], { zip64: true }));
    expect(text((await read(archive, () => ({ maxBytes: 100 })))[0])).toBe("zip64 body");
    expect(await failure(openZipArchive(new Blob(["not an archive at all, just text"])))).toBe("archive_invalid");
    const valid = await buildZip([{ content: "x", path: "x" }]);
    expect(await failure(openZipArchive(new Blob([valid, "trailing"])))).toBe("archive_invalid");
  });
});
