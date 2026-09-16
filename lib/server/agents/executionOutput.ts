import { CODEX_OUTPUT_LIMITS, CodexProtocolError } from "./codexProtocol";

export const AGENT_OUTPUT_POLL_BYTES = 64 * 1024;
export const AGENT_OUTPUT_PENDING_BYTES = 4 * 1024 * 1024;

/** Private runner response; only the protocol decoder may consume these bytes. */
export type AgentExecutionOutputPage = Readonly<{
  cursor: number;
  nextCursor: number;
  stdoutBase64: string;
  done: boolean;
  exitCode: number | null;
}>;

/**
 * Preserve raw stdout across SDK chunk boundaries and retryable HTTP polls.
 * A cursor acknowledges earlier bytes only on the NEXT request, so a lost
 * poll response can be fetched again. Overflow fails the execution; nothing
 * is silently evicted. stderr consumes the same budget but is never retained.
 */
export class AgentExecutionOutput {
  private buffer: Buffer;
  private acknowledged = 0;
  private offered = 0;
  private produced = 0;
  private totalBytes = 0;
  private ended = false;
  private exitCode: number | null = null;
  private overflowed = false;

  constructor(private readonly limits: Readonly<{
    pendingBytes: number;
    totalBytes: number;
    pageBytes: number;
  }> = {
    pendingBytes: AGENT_OUTPUT_PENDING_BYTES,
    totalBytes: CODEX_OUTPUT_LIMITS.totalBytes,
    pageBytes: AGENT_OUTPUT_POLL_BYTES
  }) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new CodexProtocolError("agent_protocol_invalid");
    }
    this.buffer = Buffer.alloc(limits.pendingBytes);
  }

  stdout(bytes: Uint8Array): void {
    this.account(bytes.byteLength);
    if (this.produced - this.acknowledged + bytes.byteLength > this.limits.pendingBytes) this.overflow();
    const start = this.produced % this.buffer.length;
    const first = Math.min(bytes.byteLength, this.buffer.length - start);
    this.buffer.set(bytes.subarray(0, first), start);
    this.buffer.set(bytes.subarray(first), 0);
    this.produced += bytes.byteLength;
  }

  stderr(bytes: Uint8Array): void {
    this.account(bytes.byteLength);
  }

  end(exitCode: number | null): void {
    this.ended = true;
    // -1 in the SDK can mean lost reaper notification, not an observed exit.
    this.exitCode = typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
      ? exitCode : null;
  }

  poll(cursor: number): AgentExecutionOutputPage {
    if (this.overflowed) this.overflow();
    if (!Number.isSafeInteger(cursor) || cursor < this.acknowledged || cursor > this.offered) {
      throw new CodexProtocolError("agent_output_cursor_invalid");
    }
    this.acknowledged = cursor;
    const length = Math.min(this.limits.pageBytes, this.produced - cursor);
    const bytes = Buffer.alloc(length);
    const start = cursor % this.buffer.length;
    const first = Math.min(length, this.buffer.length - start);
    bytes.set(this.buffer.subarray(start, start + first));
    bytes.set(this.buffer.subarray(0, length - first), first);
    const nextCursor = cursor + length;
    this.offered = Math.max(this.offered, nextCursor);
    const done = this.ended && nextCursor === this.produced;
    return {
      cursor,
      nextCursor,
      stdoutBase64: bytes.toString("base64"),
      done,
      exitCode: done ? this.exitCode : null
    };
  }

  private account(bytes: number): void {
    if (this.overflowed) this.overflow();
    if (this.ended) throw new CodexProtocolError("agent_protocol_invalid");
    this.totalBytes += bytes;
    if (this.totalBytes > this.limits.totalBytes) this.overflow();
  }

  private overflow(): never {
    this.overflowed = true;
    this.buffer = Buffer.alloc(0);
    throw new CodexProtocolError("agent_output_limit_exceeded");
  }
}
