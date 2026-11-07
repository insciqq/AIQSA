import type { ComputerFailureCode } from "@/lib/contracts/computer";
import {
  CONNECT_MAX_BYTES_CHUNK,
  CONNECT_MAX_OP_DEADLINE_MS,
  CONNECT_MAX_TRANSFER_BYTES,
  parseConnectOpResult
} from "@/lib/contracts/connect";
import { getComputerOps, type ComputerOps } from "./computerPort";
import { logConnect } from "./observability";

/**
 * Fetches a whole file from the user's computer into memory through the port, in `read_bytes` chunks: the base for
 * tools that read documents and images or attach a file to the answer. The device's text ops carry only UTF-8; this
 * carries bytes.
 */

export const COMPUTER_FILE_FETCH_LIMITS = Object.freeze({
  /** One `read_bytes` call. */
  chunkBytes: CONNECT_MAX_BYTES_CHUNK,
  /** `read_bytes` calls of one fetch at once; the device runs at most `CONNECT_MAX_CONCURRENT_OPS` of all kinds. */
  inFlight: 4,
  /** The largest file any fetch takes; a caller's `maxBytes` is cut to it. */
  maxFileBytes: CONNECT_MAX_TRANSFER_BYTES,
  /**
   * Bytes of all files in transfer in this process at once, across runs. A fetch that would pass it fails at once with
   * `computer_limit` rather than waiting, so a turn never stalls behind another user's transfer.
   */
  processBytes: 268_435_456
});

/** A byte budget for files in transfer: `reserve` answers a release function, or null when the bytes are not free. */
export type ComputerFileBudget = Readonly<{
  reserve(bytes: number): (() => void) | null;
  /** Bytes not reserved now. */
  available(): number;
}>;

export function createComputerFileBudget(totalBytes: number): ComputerFileBudget {
  let used = 0;
  return {
    available: () => totalBytes - used,
    reserve(bytes) {
      if (bytes > totalBytes - used) return null;
      used += bytes;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        used -= bytes;
      };
    }
  };
}

const globalForBudget = globalThis as typeof globalThis & { __aiqsaComputerFileBudget?: ComputerFileBudget };

/** The process's budget, shared by every route bundle (single replica, as the relay). */
function processBudget(): ComputerFileBudget {
  globalForBudget.__aiqsaComputerFileBudget ??= createComputerFileBudget(COMPUTER_FILE_FETCH_LIMITS.processBytes);
  return globalForBudget.__aiqsaComputerFileBudget;
}

/** What a computer tool knows of its call (`ComputerToolContext` in `lib/server/tools/computerTools.ts`) and the file. */
export type ComputerFileFetchInput = Readonly<{
  /** The port; absent, the process's (`getComputerOps`). */
  ops?: ComputerOps;
  userId: string;
  deviceId: string;
  runId: string;
  /** The chat's working folder; a relative `path` starts there, as for `read`. */
  cwd: string;
  path: string;
  /** A larger file fails with `computer_file_too_large` after its first chunk; cut to {@link COMPUTER_FILE_FETCH_LIMITS}. */
  maxBytes: number;
  /** The whole fetch's time; past it the fetch stops its calls and fails with `computer_timeout`. */
  timeoutMs: number;
  /** Stop or the turn's deadline: the fetch stops its calls and fails with `computer_cancelled`. */
  signal: AbortSignal;
  /** Tests; absent, the process's. */
  budget?: ComputerFileBudget;
}>;

export type ComputerFile = Readonly<{
  ok: true;
  bytes: Buffer;
  /** The file's size, `bytes.length`. */
  size: number;
  /** The file's modification time in milliseconds since the epoch, the same in every chunk. */
  modifiedMs: number;
  /** The path's last part, `\` and `/` both separating; `file` when the path names none. */
  fileName: string;
}>;

/**
 * Why a fetch failed: a device code (`connect_unsupported` from a client without `read_bytes` included, unchanged),
 * a port code, or the fetch's own `computer_file_too_large`, `computer_file_changed` (size or modification time
 * differed between chunks), `computer_limit` (the process budget), `computer_timeout`, `computer_cancelled` or
 * `connect_device_error` (a chunk that does not match its request). `sent` as the port's: whether a call may have
 * reached the device; reading changes nothing there either way.
 */
export type ComputerFileFetchFailure = Readonly<{ ok: false; code: ComputerFailureCode; sent: boolean }>;

export type ComputerFileFetchOutcome = ComputerFile | ComputerFileFetchFailure;

/** The last part of a device path, `.` and `..` resolved, a drive prefix (`C:name`) dropped; `file` when none is left. */
export function computerFileName(path: string): string {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]/u)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const last = parts.length === 1 ? (parts[0] ?? "").replace(/^[A-Za-z]:/u, "") : parts.at(-1) ?? "";
  return last === "" || last === "~" || /^[A-Za-z]:$/u.test(last) ? "file" : last;
}

type Chunk = Readonly<{ bytes: Buffer; size: number; modifiedMs: number; eof: boolean }>;

function failure(code: ComputerFailureCode, sent: boolean): ComputerFileFetchFailure {
  return { code, ok: false, sent };
}

/**
 * Fetches the file at `path` whole, or fails with a stable code. The first chunk tells the size: a file over
 * `maxBytes` fails before the rest is read, and the size is reserved in the process budget until the fetch returns.
 * The rest follows {@link COMPUTER_FILE_FETCH_LIMITS}`.inFlight` calls at a time; every chunk must report the first
 * one's size and modification time, so a file written meanwhile fails rather than mixing versions. On any failure,
 * Stop or the deadline the other calls are aborted (the port cancels them on the device), and the fetch returns only
 * once every call it made has settled. Logs carry codes, sizes and durations only.
 */
export async function fetchComputerFile(input: ComputerFileFetchInput): Promise<ComputerFileFetchOutcome> {
  const startedAt = Date.now();
  const ops = input.ops ?? getComputerOps();
  const budget = input.budget ?? processBudget();
  if (!Number.isFinite(input.maxBytes) || input.maxBytes < 0 || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    logConnect({ action: "skip", code: "connect_request_invalid", outcome: "blocked", stage: "validate" });
    return failure("connect_device_error", false);
  }
  if (input.signal.aborted) return failure("computer_cancelled", false);
  const maxBytes = Math.min(Math.floor(input.maxBytes), COMPUTER_FILE_FETCH_LIMITS.maxFileBytes);
  const deadlineAt = startedAt + input.timeoutMs;
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, input.timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const signal = AbortSignal.any([input.signal, stop.signal]);
  let sent = false;
  let release: (() => void) | null = null;

  /** Stop and the deadline outrank the code a call settled with when they cut it short. */
  const settled = (code: ComputerFailureCode): ComputerFileFetchFailure =>
    failure(input.signal.aborted ? "computer_cancelled" : timedOut ? "computer_timeout" : code, sent);
  /** A failure the fetch decides itself; a refusal by size or budget is `blocked`, a bad or changed chunk `failed`. */
  const fail = (code: ComputerFailureCode, size?: number, refused = false): ComputerFileFetchFailure => {
    logConnect({
      ...(refused ? { action: "skip" as const } : {}),
      code,
      ...(size === undefined ? {} : { count: size }),
      durationMs: Date.now() - startedAt,
      outcome: refused ? "blocked" : "failed",
      stage: "read"
    });
    return failure(code, sent);
  };

  async function readChunk(offset: number, length: number): Promise<Chunk | ComputerFileFetchFailure> {
    const left = deadlineAt - Date.now();
    if (left <= 0) {
      timedOut = true;
      return settled("computer_timeout");
    }
    const outcome = await ops.call({
      args: { cwd: input.cwd, length, offset, path: input.path },
      deviceId: input.deviceId,
      op: "read_bytes",
      runId: input.runId,
      signal,
      timeoutMs: Math.min(left, CONNECT_MAX_OP_DEADLINE_MS),
      userId: input.userId
    });
    if (outcome.ok || outcome.sent) sent = true;
    if (!outcome.ok) return settled(outcome.code);
    const result = parseConnectOpResult("read_bytes", outcome.result);
    if (!result) return fail("connect_device_error");
    return { bytes: Buffer.from(result.data, "base64"), eof: result.eof, modifiedMs: result.modifiedMs, size: result.size };
  }

  /** A chunk's own failure: another version of the file, or bytes that do not answer the request. */
  function chunkCode(chunk: Chunk, offset: number, length: number, first?: Chunk): ComputerFailureCode | null {
    if (first && (chunk.size !== first.size || chunk.modifiedMs !== first.modifiedMs)) return "computer_file_changed";
    const expected = Math.max(0, Math.min(length, chunk.size - offset));
    return chunk.bytes.length === expected && chunk.eof === (offset + expected >= chunk.size) ? null : "connect_device_error";
  }

  try {
    const first = await readChunk(0, COMPUTER_FILE_FETCH_LIMITS.chunkBytes);
    if ("code" in first) return first;
    const firstCode = chunkCode(first, 0, COMPUTER_FILE_FETCH_LIMITS.chunkBytes);
    if (firstCode) return fail(firstCode, first.size);
    if (first.size > maxBytes) return fail("computer_file_too_large", first.size, true);
    release = budget.reserve(first.size);
    if (!release) return fail("computer_limit", first.size, true);
    const bytes = Buffer.alloc(first.size);
    first.bytes.copy(bytes, 0);

    const offsets: number[] = [];
    for (let offset = first.bytes.length; offset < first.size; offset += COMPUTER_FILE_FETCH_LIMITS.chunkBytes) offsets.push(offset);
    // Workers take the next offset in turn; the first failure stops the others' calls.
    const state: { next: number; failed: ComputerFileFetchFailure | null } = { failed: null, next: 0 };
    const worker = async () => {
      while (!state.failed && state.next < offsets.length) {
        const offset = offsets[state.next++]!;
        const length = Math.min(COMPUTER_FILE_FETCH_LIMITS.chunkBytes, first.size - offset);
        const chunk = await readChunk(offset, length);
        if (state.failed) return;
        if ("code" in chunk) state.failed = chunk;
        else {
          const code = chunkCode(chunk, offset, length, first);
          if (!code) {
            chunk.bytes.copy(bytes, offset);
            continue;
          }
          state.failed = fail(code, first.size);
        }
        stop.abort();
      }
    };
    await Promise.all(Array.from({ length: Math.min(COMPUTER_FILE_FETCH_LIMITS.inFlight, offsets.length) }, worker));
    if (state.failed) return settled(state.failed.code);
    if (input.signal.aborted || timedOut) return settled("computer_cancelled");
    return { bytes, fileName: computerFileName(input.path), modifiedMs: first.modifiedMs, ok: true, size: first.size };
  } finally {
    clearTimeout(timer);
    release?.();
  }
}
