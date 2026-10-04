// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildTarGz, compress, paxPathRecord, paxRecord, tarBytes } from "./archive.testFixtures";
import {
  DEFAULT_IMPORT_ARCHIVE_LIMITS,
  ImportArchiveError,
  type ImportArchive,
  type ImportArchiveEntry,
  type ImportEntrySelector
} from "./archiveTypes";
import { openTarGzArchive } from "./tarGzArchive";

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

describe("tar.gz import archive", () => {
  it("streams only the selected regular files, resolving ustar, pax and GNU names", async () => {
    const longName = `${"deep/".repeat(30)}chat.json`;
    const blob = await buildTarGz([
      { content: "{\"format\":\"aiqsa.chat-archive\"}", path: "./manifest.json" },
      { content: "# readable", path: "chat.md" },
      { path: "archived/", type: "5" },
      { content: "{\"a\":1}", path: `${"p".repeat(120)}/b.json` },
      { content: paxPathRecord("pax/renamed.json"), path: "PaxHeader", type: "x" },
      { content: "{\"pax\":true}", path: "short.json" },
      // Byte lengths: a non-ASCII path between other records must not shift them.
      { content: `${paxRecord("comment", "черновик")}${paxPathRecord("archived/заметки-2026-09-01.json")}${paxRecord("mtime", "1759312800")}`, path: "PaxHeader", type: "x" },
      { content: "{\"cyrillic\":true}", path: "zametki.json" },
      { content: `${longName}\0`, path: "././@LongLink", type: "L" },
      { content: "{\"long\":true}", path: "truncated-name.json" },
      { content: "target", path: "link.json", type: "2" }
    ]);
    const seen: string[] = [];
    const entries = await read(openTarGzArchive(blob), (entry) => {
      seen.push(entry.path);
      return entry.path.endsWith(".json") ? { maxBytes: 1_000 } : null;
    });
    expect(seen).toEqual(["manifest.json", "chat.md", `${"p".repeat(120)}/b.json`, "pax/renamed.json",
      "archived/заметки-2026-09-01.json", longName]);
    expect(entries.map((entry) => [entry.path, text(entry)])).toEqual([
      ["manifest.json", "{\"format\":\"aiqsa.chat-archive\"}"],
      [`${"p".repeat(120)}/b.json`, "{\"a\":1}"],
      ["pax/renamed.json", "{\"pax\":true}"],
      ["archived/заметки-2026-09-01.json", "{\"cyrillic\":true}"],
      [longName, "{\"long\":true}"]
    ]);
  });

  it("reports a large entry as too large without keeping it, or keeps only a prefix", async () => {
    const blob = await buildTarGz([{ content: "0123456789".repeat(100), path: "big.json" }, { content: "after", path: "next.json" }]);
    expect((await read(openTarGzArchive(blob), () => ({ maxBytes: 10 }))).map((entry) => entry.kind)).toEqual(["too_large", "data"]);
    const [prefix] = await read(openTarGzArchive(blob), (entry) => entry.path === "big.json" ? { maxBytes: 4, prefix: true } : null);
    expect(prefix).toMatchObject({ kind: "data", truncated: true });
    expect(text(prefix)).toBe("0123");
  });

  it("stops a stream that expands beyond the compression-ratio guard", async () => {
    const bomb = await buildTarGz([{ content: new Uint8Array(8 * 1_024 * 1_024), path: "zeros.json" }]);
    expect(await failure(read(openTarGzArchive(bomb), () => null))).toBe("archive_ratio_exceeded");
  });

  it("bounds entry count and total bytes, and refuses damaged streams", async () => {
    const crowded = await buildTarGz([{ content: "a", path: "a" }, { content: "b", path: "b" }, { content: "c", path: "c" }]);
    expect(await failure(read(openTarGzArchive(crowded, { ...DEFAULT_IMPORT_ARCHIVE_LIMITS, maxEntries: 2 }), () => null)))
      .toBe("archive_too_many_entries");
    const heavy = await buildTarGz([{ content: "x".repeat(4_000), path: "a.json" }]);
    expect(await failure(read(openTarGzArchive(heavy, { ...DEFAULT_IMPORT_ARCHIVE_LIMITS, maxTotalBytes: 2_048 }), () => null)))
      .toBe("archive_too_large");
    const badChecksum = await buildTarGz([{ checksum: 1, content: "x", path: "a.json" }]);
    expect(await failure(read(openTarGzArchive(badChecksum), () => ({ maxBytes: 10 })))).toBe("archive_invalid");
    const whole = tarBytes([{ content: "y".repeat(2_000), path: "cut.json" }], { endMarker: false });
    const cut = new Blob([await compress(whole.subarray(0, 1_200), "gzip")]);
    expect(await failure(read(openTarGzArchive(cut), () => ({ maxBytes: 10_000 })))).toBe("archive_entry_damaged");
    expect(await failure(read(openTarGzArchive(new Blob(["plain text"])), () => null))).toBe("archive_entry_damaged");
  });

  it("stops reading when the consumer leaves early", async () => {
    const blob = await buildTarGz([{ content: "{}", path: "manifest.json" }, { content: "x".repeat(10_000), path: "rest.json" }]);
    const archive = openTarGzArchive(blob);
    for await (const entry of archive.entries(() => ({ maxBytes: 100_000 }))) {
      expect(entry.path).toBe("manifest.json");
      break;
    }
    // A second pass starts from the beginning.
    expect((await read(archive, () => ({ maxBytes: 100_000 }))).map((entry) => entry.path)).toEqual(["manifest.json", "rest.json"]);
  });
});
