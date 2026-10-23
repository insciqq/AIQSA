import type {
  TranscriptCompactionItem,
  TranscriptItem,
  TranscriptOrigin,
  TranscriptTarget
} from "../transcript";

export const CODEX: TranscriptTarget = { model: "gpt-6.1-sol", nativeCompaction: true, provider: "codex-lb" };
export const GEMINI: TranscriptTarget = { model: "gemini-3.5-flash-lite", provider: "gemini" };

/** One token per character keeps expected values readable. */
export const charTokens = (value: unknown) => String(value).length;

export function handleFor(seed: string): string {
  let hex = "";
  for (let index = 0; hex.length < 32; index += 1) hex += ((seed.charCodeAt(index % seed.length) * 31 + index * 7) % 16).toString(16);
  return `tor1_${hex}`;
}

/** A transcript built item by item, ids `i1`, `i2`, … in order. */
export function transcriptBuilder(origin: TranscriptOrigin = CODEX) {
  let next = 0;
  let calls = 0;
  const items: TranscriptItem[] = [];
  const nextId = () => `i${++next}`;
  const source = { model: origin.model, provider: origin.provider };
  return {
    items,
    nextId,
    user(text: string, followup = false): string {
      const id = nextId();
      items.push({ ...(followup ? { followup: true as const } : {}), id, kind: "user", text });
      return id;
    },
    answer(text: string): string {
      const id = nextId();
      items.push({ id, kind: "assistant_text", origin: source, text });
      return id;
    },
    reasoning(): string {
      const id = nextId();
      items.push({ id, kind: "reasoning", native: { fields: { encrypted_content: `ENC-${id}`, id: `rs_${id}`, summary: [], type: "reasoning" },
        format: "openai_responses" }, origin: source });
      return id;
    },
    call(name: string, args: Readonly<Record<string, unknown>> | string): string {
      const callId = `call_${++calls}`;
      items.push({ arguments: typeof args === "string" ? args : JSON.stringify(args), callId, id: nextId(), kind: "tool_call", name,
        origin: source });
      return callId;
    },
    result(callId: string, name: string, output: string, outcome: "complete" | "error" | "unknown" = "complete"): string {
      const id = nextId();
      items.push({ callId, id, kind: "tool_result", name, outcome, output });
      return id;
    },
    /** A model response that calls one tool, then its result. Returns the call id. */
    tool(name: string, args: Readonly<Record<string, unknown>> | string, output: string,
      outcome: "complete" | "error" | "unknown" = "complete"): string {
      const callId = this.call(name, args);
      this.result(callId, name, output, outcome);
      return callId;
    },
    compaction(fields: Omit<TranscriptCompactionItem, "id" | "kind" | "origin"> & Partial<Pick<TranscriptCompactionItem, "origin">>): string {
      const id = nextId();
      items.push({ id, kind: "compaction", origin: fields.origin ?? source, ...fields });
      return id;
    }
  };
}
