import { START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME } from "../../contracts/research";
import { ASK_PARENT_TOOL_NAME, CALL_SUBAGENT_TOOL_NAME, LIST_AGENTS_TOOL_NAME, SEND_AGENT_MESSAGE_TOOL_NAME, STOP_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import { READ_TOOL_RESULT_NAME, type SavedToolResultReader } from "../engine/toolResults";
import type { TranscriptItem } from "../engine/transcript";
import { FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import { READ_SECRET_TOOL_NAME } from "../tools/readSecret";
import { UPDATE_PLAN_TOOL_NAME } from "../tools/updatePlan";
import type { ResearchOpenedSource } from "./gates";

/**
 * The text agents of a run really got from outside: the main agent's tool
 * results and those of its sub-agents' threads, foreground and background,
 * whole where a saved copy can be read. What agents wrote themselves is no
 * evidence, so a report's or a brief's words never count as opened text.
 */
const AGENT_WRITTEN: ReadonlySet<string> = new Set([ASK_PARENT_TOOL_NAME, CALL_SUBAGENT_TOOL_NAME, LIST_AGENTS_TOOL_NAME, READ_SECRET_TOOL_NAME,
  READ_TOOL_RESULT_NAME, SEND_AGENT_MESSAGE_TOOL_NAME, START_RESEARCH_TOOL_NAME, STOP_SUBAGENT_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  UPDATE_PLAN_TOOL_NAME]);

/** Bounds one read: a run's opened text is checked in memory. */
export const RESEARCH_SOURCE_LIMITS = Object.freeze({ results: 2_000, totalCharacters: 16_000_000 });

function pageUrl(call: TranscriptItem | undefined): string | null {
  if (call?.kind !== "tool_call" || call.name !== FETCH_URL_TOOL_NAME) return null;
  try {
    const parsed = JSON.parse(call.arguments) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

export function createResearchSources(input: Readonly<{
  chatId: string;
  /** The main agent's items as the run holds them. */
  items(): readonly TranscriptItem[];
  runId: string;
  savedResults: SavedToolResultReader;
  threads: Pick<SubagentThreadStore, "backgroundRunIds" | "threadEffectItems">;
  userId: string;
}>) {
  const scope = { chatId: input.chatId, userId: input.userId };
  return {
    async opened(signal: AbortSignal): Promise<readonly ResearchOpenedSource[]> {
      const background = await input.threads.backgroundRunIds({ ...scope, parentRunIds: [input.runId] });
      const threads = await input.threads.threadEffectItems({ ...scope, runIds: [input.runId, ...background] });
      const opened: ResearchOpenedSource[] = [];
      let characters = 0;
      for (const list of [input.items(), ...threads.map((thread) => thread.items)]) {
        const calls = new Map(list.flatMap((item) => item.kind === "tool_call" ? [[item.callId, item] as const] : []));
        for (const item of list) {
          if (item.kind !== "tool_result" || item.outcome !== "complete" || AGENT_WRITTEN.has(item.name)) continue;
          if (opened.length >= RESEARCH_SOURCE_LIMITS.results || characters >= RESEARCH_SOURCE_LIMITS.totalCharacters) return opened;
          signal.throwIfAborted();
          let text = item.output;
          let partial = false;
          if (item.handle) {
            const saved = await input.savedResults.read({ ...scope, handle: item.handle, signal }).catch(() => null);
            if (saved) text = saved.text;
            else partial = true;
          }
          characters += text.length;
          opened.push({ partial, text, toolName: item.name, url: pageUrl(calls.get(item.callId)) });
        }
      }
      return opened;
    }
  };
}
