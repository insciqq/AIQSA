import { crc32, deflateRawSync } from "node:zlib";
import { utils, write, type BookType } from "xlsx";
import {
  canonicalizeSpreadsheetArchive,
  parseSpreadsheetDocument
} from "./spreadsheet";
import {
  centralHeader,
  describeArchive,
  endOfCentralDirectory,
  localHeader,
  salesWorkbookEntries,
  storedFields,
  zip64Extra,
  zipArchive,
  zipEntries,
  type ZipFixtureEntry
} from "./spreadsheetArchive.testFixtures";
import {
  SPREADSHEET_MAX_COLUMNS_PER_SHEET,
  SPREADSHEET_MAX_UNCOMPRESSED_BYTES
} from "./spreadsheetLimits";

function workbookBytes(bookType: BookType): Buffer {
  const sheet = utils.aoa_to_sheet([
    ["Region", "Revenue", "Revenue", "Closed at", "Total"],
    ["North", 10, 2, new Date("2026-01-02T00:00:00.000Z"), null],
    ["South", 20, null, new Date("2026-01-03T00:00:00.000Z"), null]
  ], { cellDates: true });
  sheet.E2 = { f: "SUM(B2:B3)", t: "n", v: 30, w: "30.00", z: "0.00" };
  sheet["!rows"] = [{}, { hidden: true }];
  sheet["!cols"] = [{}, { hidden: true }];
  sheet["!merges"] = [utils.decode_range("A1:A2")];
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Sales");
  workbook.Workbook = { Sheets: [{ Hidden: 1 }] };
  return write(workbook, { bookType, cellStyles: true, type: "buffer" });
}

const mimeByType: Readonly<Record<"ods" | "xls" | "xlsx", string>> = {
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet"
};

describe("bounded spreadsheet parsing", () => {
  it.each(["xls", "xlsx", "ods"] as const)("normalizes typed %s workbooks", (bookType) => {
    const document = parseSpreadsheetDocument({
      bytes: workbookBytes(bookType),
      fileName: `sales.${bookType}`,
      mimeType: mimeByType[bookType]
    });

    expect(document).toMatchObject({
      engine: "spreadsheet",
      pageCount: 1,
      workbook: {
        sheets: [{
          cells: expect.arrayContaining([
            expect.objectContaining({ address: "B2", type: "number", value: 10 }),
            expect.objectContaining({ address: "E2", value: 30 })
          ]),
          name: "Sales",
          regions: [expect.objectContaining({ a1: "A1:E3", headerRow: 0 })]
        }]
      }
    });
    expect(document.blocks[0]).toMatchObject({
      headingPath: ["Sales", expect.any(String)],
      type: "table"
    });
    if (bookType !== "ods") {
      expect(document.workbook?.sheets[0]).toMatchObject({
        hidden: "hidden",
        hiddenColumns: [1]
      });
      expect(document.workbook?.warnings).toContain("hidden_data_present");
    }
    if (bookType === "xlsx") {
      expect(document.workbook?.sheets[0]?.hiddenRows).toEqual([1]);
    }
    expect(document.workbook?.warnings).toContain("duplicate_headers");
    expect(document.workbook?.sheets[0]?.regions[0]?.columnLabels).toEqual([
      "Region",
      "Revenue",
      "Revenue [2]",
      "Closed at",
      "Total"
    ]);
    if (bookType === "xls") {
      expect(document.workbook?.sheets[0]?.cells.find((cell) => cell.address === "E2")?.formula)
        .toBeNull();
    } else {
      expect(document.workbook?.sheets[0]?.cells.find((cell) => cell.address === "E2")?.formula)
        .toContain("SUM");
    }
  });

  it("keeps CSV formula-like text inert and preserves missing cells", () => {
    const document = parseSpreadsheetDocument({
      bytes: Buffer.from("name;amount;note\nalpha;1,25;=HYPERLINK(\"https://invalid\")\nbeta;;safe\n"),
      fileName: "locale.csv",
      mimeType: "text/csv"
    });
    const sheet = document.workbook!.sheets[0]!;
    expect(sheet.cells.find((cell) => cell.address === "C2")).toMatchObject({
      formula: null,
      type: "string",
      value: "=HYPERLINK(\"https://invalid\")"
    });
    expect(sheet.cells.some((cell) => cell.address === "B3")).toBe(false);
    expect(document.workbook?.warnings).toContain("formula_like_text");
    expect(document.text).toContain("'=HYPERLINK");
  });

  it("rejects workbook dimensions above the reviewed column bound", () => {
    const row = Array.from({ length: SPREADSHEET_MAX_COLUMNS_PER_SHEET + 1 }, (_value, index) => index);
    const sheet = utils.aoa_to_sheet([row]);
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Wide");
    expect(() => parseSpreadsheetDocument({
      bytes: write(workbook, { bookType: "xlsx", type: "buffer" }),
      fileName: "wide.xlsx",
      mimeType: mimeByType.xlsx
    })).toThrowError(expect.objectContaining({ code: "parser_output_too_large" }));
  });

  it("rejects an archive that advertises unbounded inflated content", () => {
    const centralOffset = 30;
    const centralSize = 46;
    const eocdOffset = centralOffset + centralSize;
    const bytes = Buffer.alloc(eocdOffset + 22);
    bytes.writeUInt32LE(0x02014b50, centralOffset);
    bytes.writeUInt32LE(1, centralOffset + 20);
    bytes.writeUInt32LE(SPREADSHEET_MAX_UNCOMPRESSED_BYTES + 1, centralOffset + 24);
    bytes.writeUInt32LE(0x06054b50, eocdOffset);
    bytes.writeUInt16LE(1, eocdOffset + 8);
    bytes.writeUInt16LE(1, eocdOffset + 10);
    bytes.writeUInt32LE(centralSize, eocdOffset + 12);
    bytes.writeUInt32LE(centralOffset, eocdOffset + 16);
    expect(() => canonicalizeSpreadsheetArchive(bytes))
      .toThrowError(expect.objectContaining({ code: "parser_output_too_large" }));
  });

  it("rejects a truncated spreadsheet archive with a stable parser error", () => {
    expect(() => canonicalizeSpreadsheetArchive(Buffer.from("PK")))
      .toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });
});

describe("spreadsheet archive canonicalization", () => {
  const entries = salesWorkbookEntries();
  const deflated: readonly ZipFixtureEntry[] = entries.map((entry) => ({ ...entry, method: 8 }));
  const zeros = Buffer.alloc(4 * 1_024 * 1_024);

  function parsedSales(bytes: Buffer): unknown {
    return parseSpreadsheetDocument({ bytes, fileName: "sales.xlsx", mimeType: mimeByType.xlsx })
      .workbook?.sheets[0]?.cells.find((cell) => cell.address === "B2")?.value;
  }

  function expectCanonicalFailure(bytes: Buffer, code = "parser_rejected"): void {
    expect(() => canonicalizeSpreadsheetArchive(bytes))
      .toThrowError(expect.objectContaining({ code }));
  }

  function withEntry(entry: ZipFixtureEntry): Buffer {
    return zipArchive([...deflated, entry]);
  }

  function withFirstEntry(overrides: Partial<ZipFixtureEntry>): Buffer {
    return zipArchive([{ ...deflated[0]!, ...overrides }, ...deflated.slice(1)]);
  }

  it("parses deflated packages and rebuilds one stored archive without extras", () => {
    const sheet = utils.aoa_to_sheet([["Region", "Revenue"], ["North", 10]]);
    const book = utils.book_new();
    utils.book_append_sheet(book, sheet, "Sales");
    const compressed = write(book, { bookType: "xlsx", compression: true, type: "buffer" }) as Buffer;
    const withComment = zipArchive(deflated.map((entry) => ({
      ...entry,
      central: { extra: Buffer.from([0x55, 0x54, 0x01, 0x00, 0x01]) }
    })), { comment: Buffer.from("archive comment") });

    for (const bytes of [compressed, withComment]) {
      const canonical = describeArchive(canonicalizeSpreadsheetArchive(bytes));
      expect(canonical).toMatchObject({ commentLength: 0, directorySignatures: 1 });
      expect(canonical.entries.length).toBeGreaterThan(1);
      expect(canonical.entries.every((entry) => entry.method === 0 && entry.localMethod === 0 &&
        entry.flags === 0 && entry.localFlags === 0 && entry.centralExtra === 0 &&
        entry.localExtra === 0)).toBe(true);
      expect(parsedSales(bytes)).toBe(10);
    }
    expect(describeArchive(compressed).entries.some((entry) => entry.method === 8)).toBe(true);
    expect(zipEntries(canonicalizeSpreadsheetArchive(compressed)))
      .toEqual(zipEntries(compressed));
  });

  it.each(["signed", "unsigned"] as const)(
    "accepts %s data descriptors whose local sizes are zero",
    (dataDescriptor) => {
      const archive = zipArchive(deflated.map((entry) => ({ ...entry, dataDescriptor })));
      expect(parsedSales(archive)).toBe(10);
    }
  );

  it("accepts empty stored and deflated entries", () => {
    const archive = zipArchive([
      ...deflated,
      { data: Buffer.alloc(0), name: "xl/empty-deflated.bin" },
      { data: Buffer.alloc(0), method: 0, name: "xl/empty-stored.bin" }
    ]);
    expect(deflateRawSync(Buffer.alloc(0)).byteLength).toBe(2);
    expect(parsedSales(archive)).toBe(10);
  });

  it("rejects ZIP64 size extras that disagree with the enforced sizes", () => {
    const hidden = Buffer.alloc(1_024 * 1_024);
    const payload = deflateRawSync(hidden);
    const extra = zip64Extra(BigInt(hidden.byteLength), BigInt(payload.byteLength));
    const entry = { data: hidden, name: "xl/media/zip64.bin", payload };
    expect(() => canonicalizeSpreadsheetArchive(withEntry({
      ...entry,
      central: { extra: zip64Extra(BigInt(hidden.byteLength), 0n) }
    }))).not.toThrow();
    expectCanonicalFailure(withEntry({
      ...entry,
      central: { extra, uncompressedSize: 1 },
      local: { extra, uncompressedSize: 1 }
    }));
    expectCanonicalFailure(withEntry({ ...entry, local: { extra: zip64Extra(1n, 1n) } }));
    expectCanonicalFailure(withEntry({
      ...entry,
      central: { extra, uncompressedSize: 0xffffffff },
      local: { extra, uncompressedSize: 0xffffffff }
    }));
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const archive = zipArchive(deflated);
    const eocd = archive.byteLength - 22;
    const withLocator = Buffer.concat([archive.subarray(0, eocd), locator, archive.subarray(eocd)]);
    withLocator.writeUInt32LE(withLocator.readUInt32LE(withLocator.byteLength - 10) + 20,
      withLocator.byteLength - 10);
    expectCanonicalFailure(withLocator);
  });

  it("verifies inflation against the declared size, consumed bytes and checksum", () => {
    const entry = { data: zeros, name: "xl/media/bomb.bin" };
    expect(() => canonicalizeSpreadsheetArchive(withEntry(entry))).not.toThrow();
    expectCanonicalFailure(withEntry({
      ...entry,
      central: { uncompressedSize: 0 },
      local: { uncompressedSize: 0 }
    }));
    const declaredTooLarge = zeros.byteLength + 1;
    expectCanonicalFailure(withEntry({
      ...entry,
      central: { uncompressedSize: declaredTooLarge },
      local: { uncompressedSize: declaredTooLarge }
    }));
    const payload = Buffer.concat([deflateRawSync(zeros), Buffer.from("trailing")]);
    expectCanonicalFailure(withEntry({ ...entry, payload }));
    const wrongCrc = (crc32(zeros) ^ 1) >>> 0;
    expectCanonicalFailure(withEntry({ ...entry, central: { crc: wrongCrc }, local: { crc: wrongCrc } }));
  });

  it("rejects local headers that disagree with the central directory", () => {
    const entry = { data: zeros, name: "xl/media/mismatch.bin" };
    expectCanonicalFailure(withEntry({ ...entry, central: { uncompressedSize: 1 }, local: { uncompressedSize: 0 } }));
    expectCanonicalFailure(withEntry({ ...entry, local: { uncompressedSize: 0 } }));
    expectCanonicalFailure(withFirstEntry({ local: { method: 0 } }));
    expectCanonicalFailure(withFirstEntry({ local: { name: "xl/renamed.xml" } }));
    expectCanonicalFailure(withFirstEntry({ local: { flags: 0x0008 } }));
  });

  it("rejects ambiguous directories, overlap, duplicate names and unsupported variants", () => {
    const archive = zipArchive(deflated);
    expectCanonicalFailure(Buffer.concat([archive, archive.subarray(archive.byteLength - 22)]));
    expectCanonicalFailure(Buffer.concat([archive, Buffer.from("x")]));
    expectCanonicalFailure(zipArchive(deflated, { comment: Buffer.from("note"), commentLength: 9 }));
    expectCanonicalFailure(withEntry({ ...deflated[0]!, name: deflated[0]!.name.toUpperCase() }));
    expectCanonicalFailure(withEntry({ data: Buffer.from("x"), name: "xl\\media.bin" }));
    expectCanonicalFailure(withFirstEntry({ central: { flags: 0x0001 }, local: { flags: 0x0001 } }));
    for (const method of [9, 12]) {
      expectCanonicalFailure(withFirstEntry({ central: { method }, local: { method } }));
    }

    const inner = Buffer.from("inner");
    const innerLocal = localHeader(storedFields(inner, "b.txt"));
    const outer = Buffer.concat([Buffer.from("xx"), innerLocal, inner]);
    const outerLocal = localHeader(storedFields(outer, "a.txt"));
    const directory = Buffer.concat([
      centralHeader({ ...storedFields(outer, "a.txt"), localOffset: 0 }),
      centralHeader({ ...storedFields(inner, "b.txt"), localOffset: outerLocal.byteLength + 2 })
    ]);
    expectCanonicalFailure(Buffer.concat([
      outerLocal,
      outer,
      directory,
      endOfCentralDirectory({
        count: 2,
        offset: outerLocal.byteLength + outer.byteLength,
        size: directory.byteLength
      })
    ]));
  });

  it("parses the real directory when a comment carries a forged trailing directory", () => {
    const forged = Buffer.alloc(18);
    forged.writeUInt32LE(0x06054b50, 0);
    forged.writeUInt16LE(1, 8);
    forged.writeUInt16LE(1, 10);
    const archive = zipArchive(deflated, { comment: forged });
    expect(describeArchive(canonicalizeSpreadsheetArchive(archive)))
      .toMatchObject({ commentLength: 0, directorySignatures: 1 });
    expect(parsedSales(archive)).toBe(10);
  });
});
