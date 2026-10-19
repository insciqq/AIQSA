/**
 * Reads the run stream the in-process send handler answers with
 * (`event: <type>` / `data: <json>` frames, `: keepalive` comments every few
 * seconds). It never interprets content; the bridge maps the frames it needs.
 * A stream silent past `idleMs` (not even a keepalive) counts as lost, and a
 * frame over its bound is skipped whole.
 */

export type RunStreamFrame = Readonly<{ type: string; data: unknown }>;

export type RunStreamRead =
  | Readonly<{ kind: "frame"; frame: RunStreamFrame }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "stalled" }>;

export type RunStreamReader = Readonly<{
  next(): Promise<RunStreamRead>;
  /** Stops reading; the run itself goes on (cancelling the response never cancels a run). */
  cancel(): Promise<void>;
}>;

/** Keepalives arrive every 5 s; a minute of silence means the stream is gone. */
export const RUN_STREAM_IDLE_MS = 60_000;
const FRAME_MAX_CHARS = 16 * 1024 * 1024;

type Timers = Readonly<{
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

const realTimers: Timers = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (callback, ms) => setTimeout(callback, ms)
};

function parseFrame(block: string): RunStreamFrame | null {
  let type: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if (!type) return null;
  if (data.length === 0) return { data: null, type };
  try {
    return { data: JSON.parse(data.join("\n")) as unknown, type };
  } catch {
    return null;
  }
}

export function createRunStreamReader(body: ReadableStream<Uint8Array>, options: Readonly<{
  idleMs?: number;
  timers?: Timers;
}> = {}): RunStreamReader {
  const idleMs = options.idleMs ?? RUN_STREAM_IDLE_MS;
  const timers = options.timers ?? realTimers;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: RunStreamFrame[] = [];
  let buffer = "";
  let skipping = false;
  let ended: "closed" | "stalled" | null = null;

  function absorb(text: string): void {
    buffer += text.replace(/\r\n?/gu, "\n");
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end === -1) break;
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (skipping) {
        skipping = false;
        continue;
      }
      const frame = parseFrame(block);
      if (frame) frames.push(frame);
    }
    if (buffer.length > FRAME_MAX_CHARS) {
      // An oversized frame is dropped whole; reading resumes after its end.
      buffer = "";
      skipping = true;
    }
  }

  async function readChunk(): Promise<"data" | "closed" | "stalled"> {
    let timer: unknown;
    const stalled = new Promise<"stalled">((resolve) => { timer = timers.setTimeout(() => resolve("stalled"), idleMs); });
    try {
      const result = await Promise.race([reader.read(), stalled]);
      if (result === "stalled") return "stalled";
      if (result.done) {
        absorb(decoder.decode());
        if (buffer.trim()) absorb("\n\n");
        return "closed";
      }
      absorb(decoder.decode(result.value, { stream: true }));
      return "data";
    } catch {
      return "closed";
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function stop(): Promise<void> {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }

  return Object.freeze({
    async next(): Promise<RunStreamRead> {
      for (;;) {
        const frame = frames.shift();
        if (frame) return { frame, kind: "frame" };
        if (ended) return { kind: ended };
        const read = await readChunk();
        if (read !== "data") {
          ended = read;
          if (read === "stalled") await stop();
        }
      }
    },
    async cancel() {
      ended ??= "closed";
      frames.length = 0;
      await stop();
    }
  });
}
