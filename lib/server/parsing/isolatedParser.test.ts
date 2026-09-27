// @vitest-environment node

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { utils, write, type BookType } from "xlsx";
import { extractTextDocument } from "../uploads/textDocuments";
import { createDocumentParserBoundary } from "./boundary";
import {
  extractHtmlTextInIsolation,
  parseSpreadsheetInIsolation,
  type SpawnIsolatedParser
} from "./isolatedParser";
import { parseSpreadsheetDocument } from "./spreadsheet";
import {
  salesWorkbookEntries,
  zip64Extra,
  zipArchive,
  type ZipFixtureEntry
} from "./spreadsheetArchive.testFixtures";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const mimeByType: Readonly<Record<"csv" | "ods" | "xls" | "xlsx", string>> = {
  csv: "text/csv",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  xls: "application/vnd.ms-excel",
  xlsx: XLSX_MIME
};

function workbookBytes(bookType: Exclude<BookType, "csv">): Buffer {
  const sheet = utils.aoa_to_sheet([
    ["Region", "Revenue", "Closed at", "Total"],
    ["North", 10, new Date("2026-01-02T00:00:00.000Z"), null],
    ["South", 20, new Date("2026-01-03T00:00:00.000Z"), null]
  ], { cellDates: true });
  sheet.D2 = { f: "SUM(B2:B3)", t: "n", v: 30, w: "30.00", z: "0.00" };
  sheet["!merges"] = [utils.decode_range("A1:A2")];
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sales");
  return write(workbook, { bookType, cellStyles: true, compression: true, type: "buffer" }) as Buffer;
}

// Several seconds of legitimate CSV work in the child.
function slowCsv(): Buffer {
  const rows = Array.from({ length: 60_000 }, (_value, index) =>
    `row${index},${index},text ${index},${index * 2}`);
  return Buffer.from(`name,value,note,double\n${rows.join("\n")}\n`);
}

function recordingSpawn(pids: number[]): SpawnIsolatedParser {
  return (command, args, options) => {
    const child = spawn(command, args, options);
    if (child.pid !== undefined) pids.push(child.pid);
    return child;
  };
}

function liveGroupMembers(groupId: number): number[] {
  const members: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(group) === groupId && state !== "Z") members.push(Number(entry));
    } catch {
      // The process exited while listing.
    }
  }
  return members;
}

async function expectGroupGone(groupId: number | undefined): Promise<void> {
  expect(groupId).toEqual(expect.any(Number));
  for (let attempt = 0; attempt < 100 && liveGroupMembers(groupId!).length > 0; attempt += 1) {
    await delay(20);
  }
  expect(liveGroupMembers(groupId!)).toEqual([]);
}

function hostileArchives(): Readonly<Record<string, Buffer>> {
  const entries: ZipFixtureEntry[] = salesWorkbookEntries().map((entry) => ({ ...entry, method: 8 }));
  const zeros = Buffer.alloc(4 * 1_024 * 1_024);
  const hidden = Buffer.alloc(1_024 * 1_024);
  const zip64 = zip64Extra(BigInt(hidden.byteLength));
  const forged = Buffer.alloc(18);
  forged.writeUInt32LE(0x06054b50, 0);
  forged.writeUInt16LE(1, 10);
  return {
    declaredZero: zipArchive([...entries, {
      central: { uncompressedSize: 0 },
      data: zeros,
      local: { uncompressedSize: 0 },
      name: "xl/media/b.bin"
    }]),
    forgedTrailingDirectory: zipArchive(entries, { comment: forged }),
    localMismatch: zipArchive([...entries, {
      central: { uncompressedSize: 1 },
      data: zeros,
      local: { uncompressedSize: 0 },
      name: "xl/media/e.bin"
    }]),
    zip64Extra: zipArchive([...entries, {
      central: { extra: zip64, uncompressedSize: 1 },
      data: hidden,
      local: { extra: zip64, uncompressedSize: 1 },
      name: "xl/media/a.bin"
    }])
  };
}

describe("isolated document parser process", () => {
  it("parses every spreadsheet format through the boundary exactly as in process", async () => {
    const boundary = createDocumentParserBoundary({ config: {} });
    const inputs = [
      ...(["xlsx", "ods", "xls"] as const).map((bookType) => ({
        bytes: workbookBytes(bookType),
        fileName: `sales.${bookType}`,
        mimeType: mimeByType[bookType]
      })),
      {
        bytes: Buffer.from("name;amount;note\nalpha;1,25;=HYPERLINK(\"https://invalid\")\nbeta;;safe\n"),
        fileName: "locale.csv",
        mimeType: mimeByType.csv
      }
    ];
    for (const input of inputs) {
      const isolated = await boundary.parse(input);
      expect(isolated).toEqual(parseSpreadsheetDocument(input));
      expect(Object.isFrozen(isolated.workbook?.sheets[0]?.cells[0])).toBe(true);
    }
  }, 60_000);

  it("extracts HTML exactly as in process", async () => {
    const html = Buffer.from(
      "<h1>Report &amp; Notes</h1><script>alert(1)</script><style>p{}</style><p>A&nbsp;B</p>"
    );
    for (const maxChars of [1_000, 8]) {
      await expect(extractHtmlTextInIsolation({ bytes: html, maxChars })).resolves.toEqual(
        extractTextDocument(html, { fileName: "report.html", maxChars, mimeType: "text/html" })
      );
    }
  }, 30_000);

  it("stops an overdue parser together with its process group", async () => {
    const pids: number[] = [];
    await expect(parseSpreadsheetInIsolation({
      bytes: slowCsv(),
      format: "csv",
      mediaType: mimeByType.csv
    }, { spawn: recordingSpawn(pids), timeoutMs: 600 }))
      .rejects.toMatchObject({ code: "parser_timeout", engine: "spreadsheet" });
    expect(pids).toHaveLength(1);
    await expectGroupGone(pids[0]);
  }, 30_000);

  it("rejects with the caller's abort reason and stops the process group", async () => {
    const pids: number[] = [];
    const controller = new AbortController();
    const reason = new Error("attachment_processing_lease_lost");
    const parsing = parseSpreadsheetInIsolation({
      bytes: slowCsv(),
      format: "csv",
      mediaType: mimeByType.csv,
      signal: controller.signal
    }, { spawn: recordingSpawn(pids) });
    await delay(400);
    controller.abort(reason);
    await expect(parsing).rejects.toBe(reason);
    await expectGroupGone(pids[0]);
  }, 30_000);

  it("reports memory and output exhaustion as too large", async () => {
    const large = Buffer.alloc(48 * 1_024 * 1_024);
    const archive = zipArchive([
      ...salesWorkbookEntries().map((entry) => ({ ...entry, method: 8 as const })),
      { data: large, name: "xl/media/large.bin" }
    ]);
    await expect(parseSpreadsheetInIsolation({
      bytes: archive,
      format: "xlsx",
      mediaType: XLSX_MIME
    }, { memoryBudgetBytes: 16 * 1_024 * 1_024 }))
      .rejects.toMatchObject({ code: "parser_output_too_large" });
    await expect(parseSpreadsheetInIsolation({
      bytes: Buffer.from("name,amount\nalpha,1\n"),
      format: "csv",
      mediaType: mimeByType.csv
    }, { maxOutputBytes: 64 })).rejects.toMatchObject({ code: "parser_output_too_large" });
  }, 60_000);

  it("fails closed when the child cannot apply its limits or start", async () => {
    const withoutPrlimit: SpawnIsolatedParser = (command, args, options) =>
      spawn(command, args, { ...options, env: { ...options.env!, PATH: "/nonexistent" } });
    const input = { bytes: Buffer.from("a,b\n1,2\n"), format: "csv" as const, mediaType: mimeByType.csv };
    await expect(parseSpreadsheetInIsolation(input, { spawn: withoutPrlimit }))
      .rejects.toMatchObject({ code: "parser_unavailable" });
    await expect(parseSpreadsheetInIsolation(input, {
      spawn: () => { throw new Error("spawn_failed"); }
    })).rejects.toMatchObject({ code: "parser_unavailable" });
  }, 30_000);

  it.each([
    ["process.exit(0)", "parser_invalid_output"],
    ["require('fs').writeSync(3, '{\"ok\":true');process.exit(0)", "parser_invalid_output"],
    ["require('fs').writeSync(3, '{\"ok\":false,\"code\":\"parser_timeout\"}');process.exit(0)",
      "parser_invalid_output"],
    ["require('fs').writeSync(3, '{\"ok\":true,\"result\":{\"kind\":\"text\"}}');process.exit(0)",
      "parser_invalid_output"],
    ["require('fs').writeSync(3, '{\"ok\":false,\"code\":\"parser_rejected\"}');process.exit(0)",
      "parser_rejected"],
    ["process.exit(78)", "parser_unavailable"],
    ["process.kill(process.pid, 'SIGABRT')", "parser_output_too_large"],
    ["process.kill(process.pid, 'SIGKILL')", "parser_output_too_large"],
    ["process.kill(process.pid, 'SIGXCPU')", "parser_timeout"],
    ["process.kill(process.pid, 'SIGSEGV')", "parser_unavailable"]
  ])("maps child outcome %s to %s", async (source, code) => {
    // Signals with a core action must not leave dumps in the working directory.
    const noCore = "require('child_process').spawnSync('prlimit', " +
      "['--pid', String(process.pid), '--core=0:0']);";
    const scripted: SpawnIsolatedParser = (command, _args, options) =>
      spawn(command, ["-e", `${noCore}${source}`], options);
    await expect(extractHtmlTextInIsolation({ bytes: Buffer.from("<p>x</p>"), maxChars: 10 }, {
      spawn: scripted
    })).rejects.toMatchObject({ code, engine: "inline" });
  }, 30_000);

  it("keeps an unrelated HTTP handler responsive while hostile inputs are parsed", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const latencies: number[] = [];
    let probing = true;
    const probe = (async () => {
      while (probing) {
        const started = performance.now();
        await (await fetch(url)).text();
        latencies.push(performance.now() - started);
        await delay(50);
      }
    })();
    const outcomes: Record<string, unknown> = {};
    try {
      for (const [name, bytes] of Object.entries(hostileArchives())) {
        outcomes[name] = await parseSpreadsheetInIsolation({
          bytes,
          format: "xlsx",
          mediaType: XLSX_MIME
        }).then((document) => document.workbook?.sheets[0]?.cells
          .find((cell) => cell.address === "B2")?.value, (error: { code?: string }) => error.code);
      }
      outcomes.unclosedTags = await extractHtmlTextInIsolation({
        bytes: Buffer.from("<a".repeat(512 * 1_024)),
        maxChars: 1_000
      }).then((result) => result.truncated);
    } finally {
      probing = false;
      await probe;
      await new Promise((resolve) => server.close(resolve));
    }
    expect(outcomes).toEqual({
      declaredZero: "parser_rejected",
      forgedTrailingDirectory: 10,
      localMismatch: "parser_rejected",
      unclosedTags: true,
      zip64Extra: "parser_rejected"
    });
    expect(latencies.length).toBeGreaterThan(5);
    expect(Math.max(...latencies)).toBeLessThan(200);
  }, 60_000);
});
