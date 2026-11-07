// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ConnectOpArgs } from "@/lib/contracts/connect";
import { COMPUTER_FILE_FETCH_LIMITS } from "../connect/computerFileFetch";
import type { ComputerOpCall, ComputerOpOutcome, ComputerOps } from "../connect/computerPort";
import { createFakeComputerOps } from "../connect/computerPort";
import { projectTranscript, type TranscriptToolResultItem } from "../engine/transcript";
import { DocumentParserError } from "../parsing/errors";
import type { DocumentParseInput, ParsedDocument } from "../parsing/types";
import type { ProviderRunRequest } from "../providers/types";
import { createDirectImageBudget } from "../workspace/directImageView";
import type { FrozenComputerBinding } from "./computerBinding";
import {
  COMPUTER_CONNECT_OUTDATED_TEXT,
  COMPUTER_DOCUMENT_TYPES,
  COMPUTER_READ_FILE_LIMITS,
  computerReadKind,
  createComputerReadFiles
} from "./computerReadFiles";
import { executeComputerTool, pageServerText, type ComputerToolContext } from "./computerTools";
import type { ToolExecutionResult } from "./types";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const RUN = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const MODIFIED = 1_762_500_000_123;
const binding: FrozenComputerBinding = { arch: "amd64", cwd: "C:\\Users\\ivan\\Reports", deviceId: DEVICE, name: "DESKTOP-7Q2",
  online: true, os: "windows" };

function request(vision: boolean): ProviderRunRequest {
  return { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [] },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision },
    modelId: "fake", params: {}, prompt: { developer: null, system: null }, provider: "fake", searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto" };
}

type Device = { files: Map<string, { bytes: Buffer; modifiedMs: number }>; calls: ConnectOpArgs<"read_bytes">[]; ops: ComputerOps };

/** A computer whose files answer `read_bytes` as the device does; `answer` overrides one call. */
function device(answer?: (args: ConnectOpArgs<"read_bytes">) => ComputerOpOutcome | undefined): Device {
  const files = new Map<string, { bytes: Buffer; modifiedMs: number }>();
  const calls: ConnectOpArgs<"read_bytes">[] = [];
  const ops: ComputerOps = {
    call: (async (input: ComputerOpCall<"read_bytes">): Promise<ComputerOpOutcome> => {
      expect(input).toMatchObject({ deviceId: DEVICE, op: "read_bytes", runId: RUN, userId: USER });
      calls.push(input.args);
      const own = answer?.(input.args);
      if (own) return own;
      const file = files.get(input.args.path);
      if (!file) return { code: "computer_path_not_found", ok: false, sent: true };
      const part = file.bytes.subarray(Math.min(input.args.offset, file.bytes.length),
        Math.min(input.args.offset + input.args.length, file.bytes.length));
      return { ok: true, result: { data: part.toString("base64"), eof: input.args.offset + part.length >= file.bytes.length,
        modifiedMs: file.modifiedMs, size: file.bytes.length } };
    }) as unknown as ComputerOps["call"],
    describe: async () => null,
    runEnded: () => {}
  };
  return { calls, files, ops };
}

function parsed(text: string, status: "complete" | "partial" = "complete"): ParsedDocument {
  return { assets: [], attempts: [], blocks: [], engine: "tika", fieldGroups: [], languages: [], mediaType: "application/pdf", pageCount: 1,
    quality: {} as ParsedDocument["quality"], status, text, warnings: [], workbook: null };
}

type PdfText = (bytes: Buffer, signal: AbortSignal) => Promise<Readonly<{ text: string; status: "complete" | "partial" | "no_text" }>>;

function setup(options: Readonly<{ vision?: boolean; resultImages?: boolean; parse?: (input: DocumentParseInput) => Promise<ParsedDocument>;
  limits?: { available: boolean; maxBytes: number } | null; answer?: Parameters<typeof device>[0]; pdfText?: PdfText }> = {}) {
  const computer = device(options.answer);
  const parse = vi.fn<(input: DocumentParseInput) => Promise<ParsedDocument>>(options.parse ?? (async () => parsed("one\ntwo\nthree\nfour\n")));
  const pdfText = vi.fn<PdfText>(options.pdfText ?? (async () => { throw new Error("unpdf failed"); }));
  let finish!: () => void;
  const runEnded = new Promise<void>((resolve) => { finish = resolve; });
  const budget = createDirectImageBudget();
  const files = createComputerReadFiles({ budget, parse, parserLimits: () => options.limits === undefined
    ? { available: true, maxBytes: 25_000_000 } : options.limits, pdfText, request: request(options.vision ?? true),
  resultImages: options.resultImages ?? true, runEnded, runId: RUN });
  const context: ComputerToolContext = { binding, files, ops: computer.ops, runId: RUN, userId: USER };
  const read = (path: string, offset: number | null = null, limit: number | null = null, id = "r1") =>
    executeComputerTool(context, { arguments: { limit, offset, path }, id, name: "computer_read" }, new AbortController().signal, 1);
  return { budget, computer, end: async () => { finish(); await runEnded; }, files, parse, pdfText, read };
}

const text = (result: ToolExecutionResult) => (result.content[0] as { text: string }).text;
const failure = (result: ToolExecutionResult) => (result.content[0] as { value: { error: string; message: string } }).value;

describe("what computer_read reads by extension", () => {
  it("reads the parser's document formats as documents, images as images, and plain text as text", () => {
    expect([...COMPUTER_DOCUMENT_TYPES.keys()].sort()).toEqual([".doc", ".docx", ".eml", ".epub", ".msg", ".odp", ".ods", ".odt", ".pdf",
      ".pptx", ".rtf", ".xls", ".xlsx"]);
    expect(computerReadKind("C:\\Users\\ivan\\Report.PDF")).toMatchObject({ kind: "document", mimeType: "application/pdf" });
    expect(computerReadKind("~/Pictures/Photo.JPG")).toEqual({ extension: ".jpg", kind: "image", mimeType: "image/jpeg" });
    expect(computerReadKind("scan.tif")).toMatchObject({ kind: "image", mimeType: "image/tiff" });
    for (const path of ["notes.txt", "README.md", "data.json", "table.csv", "page.html", "logo.svg", "Makefile", "archive.zip"]) {
      expect(computerReadKind(path)).toBeNull();
    }
  });
});

describe("a document on the computer", () => {
  it("pages its extracted text like a text read and pages on from the run's cache without fetching or parsing again", async () => {
    const run = setup();
    run.computer.files.set("report.docx", { bytes: Buffer.from("docx bytes"), modifiedMs: MODIFIED });
    const first = await run.read("report.docx", null, 2);
    expect(text(first)).toBe("report.docx: lines 1-2 of 4 (extracted text from docx, not the file's raw bytes)\n" +
      "     1\tone\n     2\ttwo\nLines 3-4 are not shown: read on with offset 3.");
    expect(run.parse).toHaveBeenCalledTimes(1);
    // The parser gets a neutral name with the format's type, never the user's file name.
    expect(run.parse.mock.calls[0]![0]).toMatchObject({ fileName: "document.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const fetchCalls = run.computer.calls.length;
    const second = await run.read("report.docx", 3, 2);
    expect(text(second)).toBe("report.docx: lines 3-4 of 4 (extracted text from docx, not the file's raw bytes)\n     3\tthree\n     4\tfour");
    expect(run.parse).toHaveBeenCalledTimes(1);
    // Only a one-byte probe tells that the file is unchanged.
    expect(run.computer.calls.slice(fetchCalls)).toEqual([{ cwd: binding.cwd, length: 1, offset: 0, path: "report.docx" }]);
    // A changed file is fetched and parsed again.
    run.computer.files.set("report.docx", { bytes: Buffer.from("new docx bytes"), modifiedMs: MODIFIED + 1 });
    run.parse.mockResolvedValueOnce(parsed("changed\n"));
    expect(text(await run.read("report.docx"))).toContain("     1\tchanged");
    expect(run.parse).toHaveBeenCalledTimes(2);
    // The run's end frees the cache: a later read fetches again.
    await run.end();
    await run.read("report.docx");
    expect(run.parse).toHaveBeenCalledTimes(3);
  });

  it("says a document without a text layer has none, and notes a text that stops early", async () => {
    const run = setup({ parse: async () => parsed(" \n\n") });
    run.computer.files.set("scan.pdf", { bytes: Buffer.from("%PDF"), modifiedMs: MODIFIED });
    const scan = await run.read("scan.pdf");
    expect(scan.status).toBe("complete");
    expect(text(scan)).toContain("scan.pdf: the pdf document has no text layer");
    const partial = setup({ parse: async () => parsed("a\nb\n", "partial") });
    partial.computer.files.set("book.epub", { bytes: Buffer.from("epub"), modifiedMs: MODIFIED });
    expect(text(await partial.read("book.epub"))).toMatch(/2\tb\nThe document's text stops early/u);
  });

  it("fails with the parser's stable code, and sends nothing when the installation has no parser for the format", async () => {
    const run = setup({ parse: async () => { throw new DocumentParserError("parser_rejected", "tika"); } });
    run.computer.files.set("locked.docx", { bytes: Buffer.from("x"), modifiedMs: MODIFIED });
    const rejected = await run.read("locked.docx");
    expect(rejected.status).toBe("error");
    expect(failure(rejected)).toMatchObject({ error: "parser_rejected", message: expect.stringContaining("password") });
    const missing = setup({ limits: { available: false, maxBytes: 25_000_000 } });
    const unavailable = await missing.read("report.docx");
    expect(failure(unavailable)).toMatchObject({ error: "parser_unavailable", message: expect.stringContaining("Nothing was sent") });
    expect(missing.computer.calls).toEqual([]);
    expect(missing.parse).not.toHaveBeenCalled();
  });

  it("reads a PDF with unpdf when the parser is unavailable or timed out, as uploads do, and keeps the parser's code otherwise", async () => {
    const run = setup({ parse: async () => { throw new DocumentParserError("parser_unavailable", "tika"); },
      pdfText: async () => ({ status: "complete", text: "page one\r\npage two\n" }) });
    run.computer.files.set("scan.pdf", { bytes: Buffer.from("%PDF-1.7"), modifiedMs: MODIFIED });
    expect(text(await run.read("scan.pdf"))).toBe("scan.pdf: lines 1-2 of 2 (extracted text from pdf, not the file's raw bytes)\n" +
      "     1\tpage one\n     2\tpage two");
    expect(run.pdfText).toHaveBeenCalledTimes(1);
    const timedOut = setup({ parse: async () => { throw new DocumentParserError("parser_timeout", "tika"); } });
    timedOut.computer.files.set("scan.pdf", { bytes: Buffer.from("%PDF-1.7"), modifiedMs: MODIFIED });
    // unpdf failed too: the parser's own code stands.
    expect(failure(await timedOut.read("scan.pdf"))).toMatchObject({ error: "parser_timeout" });
    expect(timedOut.pdfText).toHaveBeenCalledTimes(1);
    const docx = setup({ parse: async () => { throw new DocumentParserError("parser_unavailable", "tika"); },
      pdfText: async () => ({ status: "complete", text: "never" }) });
    docx.computer.files.set("report.docx", { bytes: Buffer.from("x"), modifiedMs: MODIFIED });
    expect(failure(await docx.read("report.docx"))).toMatchObject({ error: "parser_unavailable" });
    expect(docx.pdfText).not.toHaveBeenCalled();
    const rejected = setup({ parse: async () => { throw new DocumentParserError("parser_rejected", "tika"); } });
    rejected.computer.files.set("bad.pdf", { bytes: Buffer.from("x"), modifiedMs: MODIFIED });
    expect(failure(await rejected.read("bad.pdf"))).toMatchObject({ error: "parser_rejected" });
    expect(rejected.pdfText).not.toHaveBeenCalled();
  });

  it("refuses a document over the parser's limit after its first chunk", async () => {
    const run = setup({ limits: { available: true, maxBytes: 1_048_576 } });
    run.computer.files.set("big.pdf", { bytes: Buffer.alloc(2 * 1_048_576), modifiedMs: MODIFIED });
    const result = await run.read("big.pdf");
    expect(failure(result)).toMatchObject({ error: "computer_file_too_large", message: expect.stringContaining("larger than the 1 MB") });
    expect(run.computer.calls).toHaveLength(1);
    expect(run.parse).not.toHaveBeenCalled();
  });

  it("reports a file written while it was fetched as changed, for the model to read again later", async () => {
    let chunks = 0;
    const run = setup({ answer: (args) => {
      chunks += 1;
      if (args.offset === 0) return undefined;
      return { ok: true, result: { data: Buffer.alloc(args.length).toString("base64"), eof: true, modifiedMs: MODIFIED + chunks,
        size: COMPUTER_FILE_FETCH_LIMITS.chunkBytes + args.length } };
    } });
    run.computer.files.set("live.xlsx", { bytes: Buffer.alloc(COMPUTER_FILE_FETCH_LIMITS.chunkBytes + 10), modifiedMs: MODIFIED });
    const result = await run.read("live.xlsx");
    expect(result.status).toBe("error");
    expect(failure(result)).toMatchObject({ error: "computer_file_changed", message: expect.stringContaining("changed on the computer") });
  });

  it("tells the model that an older AIQSA Connect updates itself shortly", async () => {
    const run = setup({ answer: () => ({ code: "connect_unsupported", ok: false, sent: true }) });
    const result = await run.read("report.docx");
    expect(failure(result)).toEqual({ error: "connect_unsupported", message: COMPUTER_CONNECT_OUTDATED_TEXT });
    expect(COMPUTER_CONNECT_OUTDATED_TEXT).toContain("Try again in a minute");
  });
});

describe("an image on the computer", () => {
  const png = () => sharp({ create: { background: "#3366cc", channels: 3, height: 30, width: 40 } }).png().toBuffer();

  it("shows a vision model a bounded preview on its result, for this run's requests only", async () => {
    const run = setup();
    const bytes = await png();
    run.computer.files.set("photo.PNG", { bytes, modifiedMs: MODIFIED });
    const result = await run.read("photo.PNG", 5, 7);
    expect(result.status).toBe("complete");
    expect(text(result)).toMatch(new RegExp(`^photo\\.PNG: PNG image, 40×30 pixels, ${bytes.length} bytes\\. It is attached to this result ` +
      "as a 40×30 preview\\.", "u"));
    expect(text(result)).toContain("call computer_read with this path again");
    const item: TranscriptToolResultItem = { callId: "r1", id: "i1", kind: "tool_result", name: "computer_read", outcome: "complete",
      output: text(result) };
    const history = projectTranscript([{ arguments: "{}", callId: "r1", id: "c1", kind: "tool_call", name: "computer_read" }, item],
      { model: "fake", provider: "fake" }, { images: run.files.images });
    expect(history[1]).toMatchObject({ images: [{ mimeType: "image/png" }], type: "tool_result" });
    // The batch may add what the turn has left below the result; the image still rides with it.
    expect(run.files.images.attached({ ...item, output: `${item.output}\n\nTool calls left: 3` })).toBeDefined();
    expect(run.files.images.attached({ ...item, output: "another result" })).toBeUndefined();
    expect(run.budget.usage().heldBytes).toBeGreaterThan(0);
    await run.end();
    expect(run.files.images.attached(item)).toBeUndefined();
    expect(run.budget.usage().heldBytes).toBe(0);
  });

  it("refuses a model without vision before anything is sent, naming the way forward", async () => {
    const run = setup({ vision: false });
    const result = await run.read("photo.jpg");
    expect(failure(result)).toMatchObject({ error: "computer_image_needs_vision",
      message: expect.stringContaining("choose a model that can see images") });
    expect(run.computer.calls).toEqual([]);
    // A vision model on a route whose requests carry no result image would never see it either.
    const route = setup({ resultImages: false });
    expect(failure(await route.read("photo.png"))).toMatchObject({ error: "computer_image_needs_vision",
      message: expect.stringContaining("Nothing was sent to the computer") });
    expect(route.computer.calls).toEqual([]);
  });

  it("refuses an image over 24 MiB and one that does not decode", async () => {
    const run = setup({ answer: (args) => args.path === "huge.tif"
      ? { ok: true, result: { data: Buffer.alloc(args.length).toString("base64"), eof: false, modifiedMs: MODIFIED,
        size: COMPUTER_READ_FILE_LIMITS.imageBytes + 1 } } : undefined });
    expect(failure(await run.read("huge.tif"))).toMatchObject({ error: "computer_file_too_large",
      message: expect.stringContaining("larger than the 24 MiB") });
    run.computer.files.set("broken.png", { bytes: Buffer.from("not a png"), modifiedMs: MODIFIED });
    expect(failure(await run.read("broken.png"))).toMatchObject({ error: "image_reference_unsupported" });
    // A GIF whose header reads but whose data stops early fails inside the decoder: still a stable refusal.
    const gif = await sharp({ create: { background: "red", channels: 3, height: 20, width: 20 } }).gif().toBuffer();
    run.computer.files.set("cut.gif", { bytes: Buffer.concat([gif.subarray(0, 40), Buffer.from([0x3b])]), modifiedMs: MODIFIED });
    const cut = await run.read("cut.gif");
    expect(cut.status).toBe("error");
    expect(failure(cut)).toMatchObject({ error: "image_reference_unsupported" });
  });
});

describe("other files", () => {
  it("keeps the device's text read, and a binary file's refusal names what computer_read and computer_attach_file do", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ code: "computer_file_binary", ok: false, sent: true }, "read");
    const files = createComputerReadFiles({ request: request(true), resultImages: true, runEnded: null, runId: RUN });
    const result = await executeComputerTool({ binding, files, ops, runId: RUN, userId: USER },
      { arguments: { limit: null, offset: null, path: "data.bin" }, id: "b1", name: "computer_read" }, new AbortController().signal);
    expect(ops.calls[0]).toMatchObject({ op: "read" });
    expect(failure(result)).toMatchObject({ error: "computer_file_binary" });
    expect(failure(result).message).toContain("docx");
    expect(failure(result).message).toContain("png");
    expect(failure(result).message).toContain("computer_attach_file");
  });

  it("pages a server-held text as the device pages a file: lines cut, bytes bounded", () => {
    const long = "x".repeat(2_100);
    expect(pageServerText(`a\n${long}\nc`, 1, 3)).toEqual({ content: `a\n${"x".repeat(2_000)}\nc`, startLine: 1, totalLines: 3,
      truncated: true });
    expect(pageServerText("a\nb\n", 2, 5)).toEqual({ content: "b\n", startLine: 2, totalLines: 2, truncated: false });
    const wide = Array.from({ length: 200 }, () => "я".repeat(1_000)).join("\n");
    const page = pageServerText(wide, 1, 200);
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(262_144);
    expect(page.truncated).toBe(true);
  });
});
