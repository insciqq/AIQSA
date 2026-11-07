// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConnectOpArgs } from "@/lib/contracts/connect";
import type { ThreadGeneratedFile } from "@/lib/contracts/workspace";
import { COMPUTER_FILE_FETCH_LIMITS, createComputerFileBudget } from "../connect/computerFileFetch";
import type { ComputerOpCall, ComputerOpOutcome, ComputerOps } from "../connect/computerPort";
import type { ComputerOutputPublishInput, ComputerOutputStore } from "../connect/computerOutputs";
import type { FrozenComputerBinding } from "./computerBinding";
import { computerAttachmentName, executeComputerAttachFile, type ComputerAttachFileContext } from "./computerAttachFile";
import { ComputerOpError } from "./computerTools";
import type { ModelToolCall } from "./types";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const RUN = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const MODIFIED = 1_762_500_000_123;
const binding: FrozenComputerBinding = { arch: "amd64", cwd: "~/Reports", deviceId: DEVICE, name: "laptop", online: true, os: "linux" };

type Answer = (args: ConnectOpArgs<"read_bytes">) => ComputerOpOutcome | Promise<ComputerOpOutcome>;

/** A port that answers each `read_bytes` call; an abort settles a waiting call as `computer_cancelled`, as the relay does. */
function stubOps(answer: Answer) {
  const calls: ConnectOpArgs<"read_bytes">[] = [];
  const ops: ComputerOps = {
    call: (async (input: ComputerOpCall<"read_bytes">) => {
      expect(input).toMatchObject({ deviceId: DEVICE, op: "read_bytes", runId: RUN, userId: USER });
      calls.push(input.args);
      if (input.signal.aborted) return { code: "computer_cancelled", ok: false, sent: false };
      return await new Promise<ComputerOpOutcome>((resolve) => {
        input.signal.addEventListener("abort", () => resolve({ code: "computer_cancelled", ok: false, sent: true }), { once: true });
        void Promise.resolve(answer(input.args)).then(resolve);
      });
    }) as unknown as ComputerOps["call"],
    describe: async () => null,
    runEnded: () => {}
  };
  return { calls, ops };
}

function fileAnswer(file: Buffer, override: (args: ConnectOpArgs<"read_bytes">) => Partial<{ modifiedMs: number; size: number }> = () => ({})):
  Answer {
  return (args) => {
    const bytes = file.subarray(Math.min(args.offset, file.length), Math.min(args.offset + args.length, file.length));
    return { ok: true, result: { data: bytes.toString("base64"), eof: args.offset + bytes.length >= file.length, modifiedMs: MODIFIED,
      size: file.length, ...override(args) } };
  };
}

/** The answer's files in memory, attached once per call and once per name and bytes, as the Prisma store does. */
function memoryStore(refusal?: "computer_output_closed" | "computer_output_limit") {
  const files: Array<ThreadGeneratedFile & { bytes: Buffer; toolCallId: string }> = [];
  const publish = vi.fn(async (input: ComputerOutputPublishInput) => {
    input.signal.throwIfAborted();
    const same = files.find((file) => file.toolCallId === input.toolCallId ||
      file.fileName === input.fileName && file.bytes.equals(input.bytes));
    if (same) return { file: project(same), ok: true as const, reused: true };
    if (refusal) return { code: refusal, ok: false as const };
    const file = { attachmentId: `attachment-${files.length + 1}`, byteSize: input.bytes.length, bytes: input.bytes, fileName: input.fileName,
      mimeType: "application/pdf", relativePath: input.fileName, source: "computer" as const, toolCallId: input.toolCallId };
    files.push(file);
    return { file: project(file), ok: true as const, reused: false };
  });
  const project = (file: (typeof files)[number]): ThreadGeneratedFile => ({ attachmentId: file.attachmentId, byteSize: file.byteSize,
    fileName: file.fileName, mimeType: file.mimeType, relativePath: file.relativePath, source: "computer" });
  const store: ComputerOutputStore = {
    find: vi.fn(async ({ toolCallId }) => {
      const file = files.find((entry) => entry.toolCallId === toolCallId);
      return file ? project(file) : null;
    }),
    publish
  };
  return { files, publish, store };
}

function context(ops: ComputerOps, store: ComputerOutputStore): ComputerAttachFileContext {
  return { binding, budget: createComputerFileBudget(256 * 1_048_576), ops, outputs: store, runId: RUN, userId: USER };
}

const call = (args: Record<string, unknown>): ModelToolCall => ({ arguments: args, id: "call-attach", name: "computer_attach_file" });
const execution = (args: Record<string, unknown>, signal = new AbortController().signal, persistedToolCallId = "row-1") =>
  ({ call: call(args), persistedToolCallId, signal });

describe("computer_attach_file", () => {
  it("reads the file whole from the chat's folder and puts it on the answer under its own name", async () => {
    const pdf = Buffer.from("%PDF-1.7 report");
    const { calls, ops } = stubOps(fileAnswer(pdf));
    const { files, publish, store } = memoryStore();
    const result = await executeComputerAttachFile(context(ops, store), execution({ name: null, path: "out/report.pdf" }));

    expect(calls).toEqual([{ cwd: "~/Reports", length: COMPUTER_FILE_FETCH_LIMITS.chunkBytes, offset: 0, path: "out/report.pdf" }]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ fileName: "report.pdf", runId: RUN, toolCallId: "row-1", userId: USER }));
    expect(files[0]!.bytes.equals(pdf)).toBe(true);
    expect(result.status).toBe("complete");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result.content)).toContain("Attached report.pdf (15 bytes) to this answer.");
    // The answer's event names the file by its name, never its path on the computer.
    expect(result.artifacts).toEqual([{ data: { artifactType: "computer_file", payload: { attachmentId: "attachment-1", byteSize: 15,
      fileName: "report.pdf", mimeType: "application/pdf", relativePath: "report.pdf", source: "computer" } }, type: "artifact" }]);
  });

  it("shows the name the agent gives, and refuses one that is no file name before anything is sent", async () => {
    const { calls, ops } = stubOps(fileAnswer(Buffer.from("x")));
    const { publish, store } = memoryStore();
    await executeComputerAttachFile(context(ops, store), execution({ name: "Q3 report.pdf", path: "a.bin" }));
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ fileName: "Q3 report.pdf" }));
    for (const name of ["../x.pdf", "a/b.pdf", "", "..", 7]) {
      const refused = await executeComputerAttachFile(context(ops, store), execution({ name, path: "a.bin" }));
      expect(refused).toMatchObject({ content: [{ value: { error: "tool_arguments_invalid" } }], status: "error" });
    }
    const noPath = await executeComputerAttachFile(context(ops, store), execution({ name: null, path: "a\u0000b" }));
    expect(noPath).toMatchObject({ content: [{ value: { error: "tool_arguments_invalid" } }], status: "error" });
    expect(calls).toHaveLength(1);
  });

  it("attaches one file per call however often the call is tried, and the same file under the same name once", async () => {
    const { calls, ops } = stubOps(fileAnswer(Buffer.from("same bytes")));
    const { files, publish, store } = memoryStore();
    const first = await executeComputerAttachFile(context(ops, store), execution({ name: null, path: "a.txt" }));
    const retry = await executeComputerAttachFile(context(ops, store), execution({ name: null, path: "a.txt" }));
    // The retry finds the call's file before reading the computer again.
    expect(calls).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(retry.artifacts).toEqual(first.artifacts);
    expect(JSON.stringify(retry.content)).toContain("already on this answer");
    // Another call of the same unchanged file: read again, attached once.
    const again = await executeComputerAttachFile(context(ops, store), execution({ name: null, path: "a.txt" }, undefined, "row-2"));
    expect(again.artifacts).toEqual(first.artifacts);
    expect(files).toHaveLength(1);
  });

  it("leaves a transfer cut short to the batch's retry, and words the definite failures for a file", async () => {
    const { store, publish } = memoryStore();
    const dropped = stubOps(() => ({ code: "connect_device_disconnected", ok: false, sent: true }));
    const thrown = await executeComputerAttachFile(context(dropped.ops, store), execution({ name: null, path: "a.txt" })).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ComputerOpError);
    expect(thrown).toMatchObject({ code: "connect_device_disconnected", transient: true });

    const old = stubOps(() => ({ code: "connect_unsupported", ok: false, sent: true }));
    const unsupported = await executeComputerAttachFile(context(old.ops, store), execution({ name: null, path: "a.txt" }));
    expect(unsupported).toMatchObject({ content: [{ value: { error: "connect_unsupported" } }], status: "error" });
    expect(JSON.stringify(unsupported.content)).toContain("It updates itself: try again in a minute");

    const offline = stubOps(() => ({ code: "connect_device_offline", ok: false, sent: false }));
    const notSent = await executeComputerAttachFile(context(offline.ops, store), execution({ name: null, path: "a.txt" }));
    expect(JSON.stringify(notSent.content)).toContain("Nothing was sent to the computer.");

    const empty = stubOps(fileAnswer(Buffer.alloc(0)));
    expect(await executeComputerAttachFile(context(empty.ops, store), execution({ name: null, path: "a.txt" })))
      .toMatchObject({ content: [{ value: { error: "computer_file_empty" } }], status: "error" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses a file over 64 MiB, which the device refuses to send", async () => {
    const huge = stubOps(() => ({ code: "computer_file_too_large", ok: false, sent: true }));
    const { publish, store } = memoryStore();
    const result = await executeComputerAttachFile(context(huge.ops, store), execution({ name: null, path: "movie.mkv" }));
    expect(result).toMatchObject({ content: [{ value: { error: "computer_file_too_large" } }], status: "error" });
    expect(JSON.stringify(result.content)).toContain("larger than 64 MiB");
    expect(huge.calls).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses a file that changed between its chunks", async () => {
    const file = Buffer.alloc(COMPUTER_FILE_FETCH_LIMITS.chunkBytes + 10, 1);
    const changing = stubOps(fileAnswer(file, (args) => args.offset === 0 ? {} : { modifiedMs: MODIFIED + 1 }));
    const { publish, store } = memoryStore();
    const result = await executeComputerAttachFile(context(changing.ops, store), execution({ name: null, path: "log.txt" }));
    expect(result).toMatchObject({ content: [{ value: { error: "computer_file_changed" } }], status: "error" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("attaches nothing once Stop ends the transfer", async () => {
    const stop = new AbortController();
    const { ops } = stubOps(() => new Promise<ComputerOpOutcome>(() => {
      queueMicrotask(() => stop.abort(new DOMException("stopped", "AbortError")));
    }));
    const { publish, store } = memoryStore();
    await expect(executeComputerAttachFile(context(ops, store), execution({ name: null, path: "a.txt" }, stop.signal))).rejects.toThrow("stopped");
    expect(publish).not.toHaveBeenCalled();
  });

  it("tells the agent when the answer holds its most files or takes no more, and when storing failed", async () => {
    const { ops } = stubOps(fileAnswer(Buffer.from("x")));
    const full = await executeComputerAttachFile(context(ops, memoryStore("computer_output_limit").store), execution({ name: null, path: "a.txt" }));
    expect(full).toMatchObject({ content: [{ value: { error: "computer_output_limit" } }], status: "error" });
    expect(JSON.stringify(full.content)).toContain("already has 20 files");
    const closed = await executeComputerAttachFile(context(ops, memoryStore("computer_output_closed").store), execution({ name: null, path: "a.txt" }));
    expect(closed).toMatchObject({ content: [{ value: { error: "computer_output_closed" } }], status: "error" });
    const broken: ComputerOutputStore = { find: async () => null, publish: async () => { throw new Error("storage down"); } };
    const failed = await executeComputerAttachFile(context(ops, broken), execution({ name: null, path: "a.txt" }));
    expect(failed).toMatchObject({ content: [{ value: { error: "computer_output_unpublished" } }], status: "error" });
  });
});

describe("the name a computer file shows", () => {
  it("keeps the agent's safe name and makes the file's own one safe", () => {
    expect(computerAttachmentName(" Report.pdf ", "x")).toBe("Report.pdf");
    expect(computerAttachmentName("a/b.pdf", "x")).toBeNull();
    expect(computerAttachmentName(null, "notes\u0007.txt")).toBe("notes_.txt");
    expect(computerAttachmentName(null, "..")).toBe("file");
    const long = `${"я".repeat(200)}.docx`;
    const cut = computerAttachmentName(null, long)!;
    expect(new TextEncoder().encode(cut).byteLength).toBeLessThanOrEqual(255);
    expect(cut.endsWith(".docx")).toBe(true);
  });
});
