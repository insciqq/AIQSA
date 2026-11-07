import type { ConnectOpArgs } from "@/lib/contracts/connect";
import {
  COMPUTER_FILE_FETCH_LIMITS,
  computerFileName,
  createComputerFileBudget,
  fetchComputerFile,
  type ComputerFileFetchInput
} from "./computerFileFetch";
import type { ComputerOpCall, ComputerOpOutcome, ComputerOps } from "./computerPort";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const RUN = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const CHUNK = COMPUTER_FILE_FETCH_LIMITS.chunkBytes;
const MODIFIED = 1_762_500_000_123;

type Answer = (args: ConnectOpArgs<"read_bytes">, signal: AbortSignal) => ComputerOpOutcome | Promise<ComputerOpOutcome>;

/** A port whose calls an answer decides; an abort settles a waiting call as `computer_cancelled`, as the relay does. */
function stubOps(answer: Answer) {
  const calls: ConnectOpArgs<"read_bytes">[] = [];
  const stats = { inFlight: 0, maxInFlight: 0 };
  const ops: ComputerOps = {
    call: (async (input: ComputerOpCall<"read_bytes">) => {
      expect(input).toMatchObject({ deviceId: DEVICE, op: "read_bytes", runId: RUN, userId: USER });
      calls.push(input.args);
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        if (input.signal.aborted) return { code: "computer_cancelled", ok: false, sent: false };
        return await new Promise<ComputerOpOutcome>((resolve) => {
          input.signal.addEventListener("abort", () => resolve({ code: "computer_cancelled", ok: false, sent: true }), { once: true });
          Promise.resolve(answer(input.args, input.signal)).then(resolve);
        });
      } finally {
        stats.inFlight -= 1;
      }
    }) as unknown as ComputerOps["call"],
    describe: async () => null,
    runEnded: () => {}
  };
  return { calls, ops, stats };
}

/** The device's answer for a file of these bytes. */
function fileAnswer(file: Buffer, override: (args: ConnectOpArgs<"read_bytes">) => Partial<{ data: string; size: number; modifiedMs: number; eof: boolean }> = () => ({})): Answer {
  return (args) => {
    const bytes = file.subarray(Math.min(args.offset, file.length), Math.min(args.offset + args.length, file.length));
    return {
      ok: true,
      result: {
        data: bytes.toString("base64"),
        eof: args.offset + bytes.length >= file.length,
        modifiedMs: MODIFIED,
        size: file.length,
        ...override(args)
      }
    };
  };
}

function testFile(size: number): Buffer {
  const file = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) file[index] = (index * 31 + 7) % 256;
  return file;
}

function input(ops: ComputerOps, overrides: Partial<ComputerFileFetchInput> = {}): ComputerFileFetchInput {
  return {
    budget: createComputerFileBudget(COMPUTER_FILE_FETCH_LIMITS.processBytes),
    cwd: "C:\\Users\\ivan",
    deviceId: DEVICE,
    maxBytes: COMPUTER_FILE_FETCH_LIMITS.maxFileBytes,
    ops,
    path: "Documents\\Отчёт.pdf",
    runId: RUN,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    userId: USER,
    ...overrides
  };
}

describe("fetchComputerFile", () => {
  it("assembles a file from chunks, at most four at a time, and releases its budget", async () => {
    const file = testFile(CHUNK * 9 + CHUNK / 2);
    const { calls, ops, stats } = stubOps(async (args, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return fileAnswer(file)(args, signal);
    });
    const budget = createComputerFileBudget(COMPUTER_FILE_FETCH_LIMITS.processBytes);
    const outcome = await fetchComputerFile(input(ops, { budget }));
    expect(outcome).toMatchObject({ fileName: "Отчёт.pdf", modifiedMs: MODIFIED, ok: true, size: file.length });
    expect(outcome.ok && outcome.bytes.equals(file)).toBe(true);
    expect(calls.map((args) => [args.offset, args.length])).toEqual([
      ...Array.from({ length: 10 }, (_, index) => [index * CHUNK, index === 9 ? CHUNK / 2 : CHUNK])
    ]);
    expect(calls.every((args) => args.cwd === "C:\\Users\\ivan" && args.path === "Documents\\Отчёт.pdf")).toBe(true);
    expect(stats.maxInFlight).toBe(COMPUTER_FILE_FETCH_LIMITS.inFlight);
    // The file holds its bytes reserved until its holder releases them.
    expect(budget.available()).toBe(COMPUTER_FILE_FETCH_LIMITS.processBytes - file.length);
    if (outcome.ok) outcome.release();
    expect(budget.available()).toBe(COMPUTER_FILE_FETCH_LIMITS.processBytes);
  });

  it("fetches an empty file and one smaller than a chunk with one call", async () => {
    for (const size of [0, 1000]) {
      const file = testFile(size);
      const { calls, ops } = stubOps(fileAnswer(file));
      const outcome = await fetchComputerFile(input(ops, { path: "/home/ivan/a.png" }));
      expect(outcome).toMatchObject({ fileName: "a.png", ok: true, size });
      expect(outcome.ok && outcome.bytes.equals(file)).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });

  it("fails when the file changes between chunks and leaves no call running", async () => {
    const file = testFile(CHUNK * 6);
    const { ops, stats } = stubOps(async (args, signal) => {
      if (args.offset === CHUNK * 2) return fileAnswer(file, () => ({ modifiedMs: MODIFIED + 1 }))(args, signal);
      if (args.offset > 0) await new Promise((resolve) => setTimeout(resolve, 5));
      return fileAnswer(file)(args, signal);
    });
    await expect(fetchComputerFile(input(ops))).resolves.toEqual({ code: "computer_file_changed", ok: false, sent: true });
    expect(stats.inFlight).toBe(0);

    const grown = stubOps(fileAnswer(file, (args) => (args.offset > 0 ? { size: file.length + 1, eof: false } : {})));
    await expect(fetchComputerFile(input(grown.ops))).resolves.toEqual({ code: "computer_file_changed", ok: false, sent: true });
  });

  it("refuses a file over maxBytes after its first chunk", async () => {
    const file = testFile(CHUNK * 3);
    const { calls, ops } = stubOps(fileAnswer(file));
    await expect(fetchComputerFile(input(ops, { maxBytes: CHUNK * 3 - 1 }))).resolves
      .toEqual({ code: "computer_file_too_large", ok: false, sent: true });
    expect(calls).toHaveLength(1);
  });

  it("refuses a chunk that does not match its request", async () => {
    const file = testFile(CHUNK * 2);
    const short = stubOps(fileAnswer(file, (args) => (args.offset > 0 ? { data: Buffer.alloc(3).toString("base64") } : {})));
    await expect(fetchComputerFile(input(short.ops))).resolves.toEqual({ code: "connect_device_error", ok: false, sent: true });
    const noEof = stubOps(fileAnswer(file, (args) => (args.offset > 0 ? { eof: false } : {})));
    await expect(fetchComputerFile(input(noEof.ops))).resolves.toEqual({ code: "connect_device_error", ok: false, sent: true });
    const malformed = stubOps(fileAnswer(file, () => ({ data: "not base64" })));
    await expect(fetchComputerFile(input(malformed.ops))).resolves.toEqual({ code: "connect_device_error", ok: false, sent: true });
  });

  it("stops every call on Stop mid-transfer and answers computer_cancelled", async () => {
    const file = testFile(CHUNK * 8);
    const stop = new AbortController();
    const { calls, ops, stats } = stubOps((args, signal) => {
      if (args.offset === 0) return fileAnswer(file)(args, signal);
      if (calls.length === COMPUTER_FILE_FETCH_LIMITS.inFlight + 1) setTimeout(() => stop.abort(), 1);
      return new Promise<ComputerOpOutcome>(() => {});
    });
    await expect(fetchComputerFile(input(ops, { signal: stop.signal }))).resolves
      .toEqual({ code: "computer_cancelled", ok: false, sent: true });
    expect(stats.inFlight).toBe(0);
    expect(calls).toHaveLength(COMPUTER_FILE_FETCH_LIMITS.inFlight + 1);

    const before = new AbortController();
    before.abort();
    const idle = stubOps(fileAnswer(file));
    await expect(fetchComputerFile(input(idle.ops, { signal: before.signal }))).resolves
      .toEqual({ code: "computer_cancelled", ok: false, sent: false });
    expect(idle.calls).toHaveLength(0);
  });

  it("stops at its deadline with computer_timeout", async () => {
    const file = testFile(CHUNK * 4);
    const { ops, stats } = stubOps((args, signal) =>
      args.offset === 0 ? fileAnswer(file)(args, signal) : new Promise<ComputerOpOutcome>(() => {}));
    await expect(fetchComputerFile(input(ops, { timeoutMs: 30 }))).resolves.toEqual({ code: "computer_timeout", ok: false, sent: true });
    expect(stats.inFlight).toBe(0);
  });

  it("fails with computer_limit when the process budget cannot hold the file", async () => {
    const file = testFile(CHUNK * 2);
    const budget = createComputerFileBudget(CHUNK * 3);
    const held = budget.reserve(CHUNK + 1);
    const { calls, ops } = stubOps(fileAnswer(file));
    await expect(fetchComputerFile(input(ops, { budget }))).resolves.toEqual({ code: "computer_limit", ok: false, sent: true });
    expect(calls).toHaveLength(1);
    held?.();
    const fetched = await fetchComputerFile(input(ops, { budget }));
    expect(fetched).toMatchObject({ ok: true, size: CHUNK * 2 });
    // The file keeps its bytes reserved until its holder is done with them; releasing twice frees them once.
    expect(budget.available()).toBe(CHUNK);
    await expect(fetchComputerFile(input(ops, { budget }))).resolves.toEqual({ code: "computer_limit", ok: false, sent: true });
    if (!fetched.ok) throw new Error("expected a file");
    fetched.release();
    fetched.release();
    expect(budget.available()).toBe(CHUNK * 3);
  });

  it("passes an old client's connect_unsupported and the port's codes through unchanged", async () => {
    const old = stubOps(() => ({ code: "connect_unsupported", ok: false, sent: true }));
    await expect(fetchComputerFile(input(old.ops))).resolves.toEqual({ code: "connect_unsupported", ok: false, sent: true });
    const offline = stubOps(() => ({ code: "connect_device_offline", ok: false, sent: false }));
    await expect(fetchComputerFile(input(offline.ops))).resolves.toEqual({ code: "connect_device_offline", ok: false, sent: false });
    const missing = stubOps(() => ({ code: "computer_path_not_found", ok: false, sent: true }));
    await expect(fetchComputerFile(input(missing.ops))).resolves.toEqual({ code: "computer_path_not_found", ok: false, sent: true });
  });
});

describe("computerFileName", () => {
  it("takes the last part of POSIX and Windows paths", () => {
    expect(computerFileName("C:\\Users\\ivan\\Отчёт.pdf")).toBe("Отчёт.pdf");
    expect(computerFileName("~/Pictures/photo.jpg")).toBe("photo.jpg");
    expect(computerFileName("docs/../scan.png")).toBe("scan.png");
    expect(computerFileName("C:report.docx")).toBe("report.docx");
    expect(computerFileName("\\\\server\\share\\a b.xlsx")).toBe("a b.xlsx");
    expect(computerFileName("notes.txt")).toBe("notes.txt");
    expect(computerFileName("~")).toBe("file");
    expect(computerFileName("C:\\")).toBe("file");
  });
});
