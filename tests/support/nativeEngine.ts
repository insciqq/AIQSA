import { vi } from "vitest";
import type { NativeEngineHandlerDeps } from "@/lib/server/engine/handlerSupport";
import { parseNativeEngineUsers } from "@/lib/server/engine/routing";
import type { ToolCallBeginResult, ToolCallRow } from "@/lib/server/engine/toolCallStore";
import type { TranscriptItem } from "@/lib/server/engine/transcript";

/**
 * The native engine's stores in memory, for handler tests that admit runs
 * through the ordinary send handler: `listed` is the pilot allowlist
 * (`AIQSA_NATIVE_ENGINE_USERS` entries), `published` collects the answers it
 * published, `transcript` the items it recorded and `calls` the tool calls it
 * recorded before sending them. `tools` gives the harness and self-service
 * tools' owners (no saved secrets; the self-service owners are never reached
 * by a run that does not call them).
 */
export function nativeEngineFake(listed: readonly string[], options: Readonly<{ tools?: boolean }> = {}) {
  const published: string[] = [];
  const transcript: TranscriptItem[] = [];
  const calls: ToolCallRow[] = [];
  const row = (input: Readonly<{ arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number;
    toolName: string }>, state: ToolCallRow["state"], result: ToolCallRow["result"]): ToolCallRow => {
    const recorded: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `call-row-${calls.length + 1}`,
      ordinal: input.ordinal, providerCallId: input.providerCallId, result, roundIndex: input.roundIndex,
      startedAt: state === "running" ? new Date().toISOString() : null, state, toolName: input.toolName };
    calls.push(recorded);
    return recorded;
  };
  const deps: NativeEngineHandlerDeps = {
    allowlist: () => parseNativeEngineUsers(listed.join(",")),
    engine: {
      approvedCall: vi.fn(async () => null),
      mcpBindingRows: async () => [],
      observations: async () => ({ withReservation: vi.fn() }) as never,
      runs: {
        applyUsageTotals: async () => undefined,
        complete: async () => true,
        publishAnswer: async (_scope, input) => { published.push(input.text); return true; },
        recordDetachedCompaction: async () => true,
        saveStoppedText: async () => true,
        writeUsageRows: async () => undefined
      },
      savedResults: { read: async () => null },
      toolCalls: {
        begin: async (input): Promise<ToolCallBeginResult> => ({ kind: "running", row: row(input, "running", null) }),
        refuse: async (input) => row(input, "error", input.result),
        settle: async () => true
      },
      transcripts: {
        append: async (_scope, _from, items) => { transcript.push(...items); },
        approvalContinuationTurns: async () => new Set(),
        loadRuns: async () => new Map(),
        nativeRunsForAnswers: async () => new Map(),
        nextSequence: async () => transcript.length,
        runLive: async () => true
      }
    },
    findOrphans: async () => [],
    ...(options.tools ? { tools: {
      secrets: { list: async () => [], read: async () => { throw new Error("secret_not_expected"); } },
      selfService: { assistants: {} as never, db: {} as never, storage: {} as never }
    } } : {})
  };
  return { calls, deps, published, transcript };
}
