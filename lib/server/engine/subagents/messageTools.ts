import {
  ASK_PARENT_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  MAIN_AGENT_NAME,
  SEND_AGENT_MESSAGE_TOOL_NAME,
  SUBAGENT_BLOCKED_REASONS,
  SUBAGENT_ERROR_CODES,
  normalizeSubagentName,
  subagentMessageNonce
} from "../../../contracts/subagents";
import type { SubagentChatScope, SubagentMessaging, SubagentSendOutcome } from "../../subagents/ports";
import { askParentTool, listAgentsTool, parseAskParentArguments, parseSendAgentMessageArguments, sendAgentMessageTool } from "../../subagents/tools";
import type { ModelToolCall, ToolExecutionResult } from "../../tools/types";
import type { EngineTool, EngineToolExecution } from "../toolRegistry";

/**
 * What the agents of a chat see and reach each other with (operator decisions
 * 2026-10-31; `lib/server/subagents/tools.ts` declares the tools): `list_agents`
 * for every agent, `send_agent_message` and `ask_parent` for sub-agents. The main
 * agent writes with `call_subagent`, which is also how it answers a question,
 * whether the asker waits or handed back. Every call is scoped to the caller's
 * chat, owner and branch at the operation, whatever the model names. A message
 * is untrusted data for whoever reads it and authorizes nothing.
 */

export type AgentToolScope = SubagentChatScope & Readonly<{
  messaging: SubagentMessaging;
  /** The main-agent run that places the caller on its branch: its own for the main agent. */
  parentRunId: string;
}>;

/** How a question came out: read as a message that follows, handed back, or not answered in time. */
export type AgentQuestionOutcome = "answered" | "handed_back" | "limit" | "no_answer" | "unavailable";

/** What a turn does for its own tools: only it knows its mailbox, its parent and its time. */
export type AgentToolTurn = Readonly<{
  ask(question: string, execution: EngineToolExecution): Promise<AgentQuestionOutcome>;
  /** The sender's name. */
  name: string;
  /** Waits for a message from this agent; false when none came within the bound. */
  waitForReply(from: string, execution: EngineToolExecution): Promise<boolean>;
}>;

const result = (call: ModelToolCall, value: Readonly<Record<string, unknown>>): ToolExecutionResult =>
  ({ callId: call.id, content: [{ type: "json", value: { ...value } }], name: call.name, status: "complete" });

const refusal = (call: ModelToolCall, code: string, message: string): ToolExecutionResult =>
  ({ callId: call.id, content: [{ type: "json", value: { error: code, message } }], name: call.name, status: "error" });

function sendRefusalText(outcome: Extract<SubagentSendOutcome, { kind: "refused" }>, to: string): string {
  switch (outcome.code) {
    case SUBAGENT_ERROR_CODES.notActive:
      return to === MAIN_AGENT_NAME
        ? "The main agent runs no answer that can read this now, so nothing was delivered. Put it in your report, or use ask_parent if you cannot go on without an answer."
        : `That agent is no longer working${outcome.state ? ` (${outcome.state})` : ""}, so nothing was delivered. Read its report with list_agents.`;
    case SUBAGENT_ERROR_CODES.messageLimit:
      return "That agent has taken as many messages as it may, so nothing was delivered. Stop writing to it and go on with what you have.";
    default:
      return "No agent of that name is on this branch. Check the names with list_agents.";
  }
}

const QUESTION_RESULTS = {
  answered: { kind: "answered", message: "Your parent answered: its message follows." },
  handed_back: { kind: "handed_back", message: "Your parent is waiting for your report and can read nothing else, so tools are closed for this turn. " +
    `Reply now with your report: start it with \`Outcome: blocked (${SUBAGENT_BLOCKED_REASONS.needsAnswer})\`, say what you did so far and repeat the ` +
    "question. It continues you by name with the answer." },
  no_answer: { kind: "no_answer", message: "No answer came before your time for tools ran out. Go on with a reasonable assumption and name it in your " +
    `report, or report \`Outcome: blocked (${SUBAGENT_BLOCKED_REASONS.needsAnswer})\`.` }
} as const;

/** `list_agents`, the one tool the main agent takes from here. */
export function listAgentsEngineTool(scope: AgentToolScope): EngineTool {
  return {
    activity: () => ({ origin: "tool" as const, toolName: LIST_AGENTS_TOOL_NAME }),
    definition: listAgentsTool.tool,
    effects: listAgentsTool.effects,
    execute: async ({ call }) => {
      const listing = await scope.messaging.agents({ chatId: scope.chatId, parentRunId: scope.parentRunId, userId: scope.userId });
      return listing ? result(call, listing) : refusal(call, SUBAGENT_ERROR_CODES.notFound, "This chat's agents cannot be read now.");
    },
    observationSource: "workspace"
  };
}

/** A sub-agent's tools beside its filtered registry: no tool group narrows them. */
export function subagentMessageTools(scope: AgentToolScope, turn: AgentToolTurn): readonly EngineTool[] {
  const addressed = (call: ModelToolCall) => {
    const value = call.arguments.to;
    const to = typeof value === "string" && value.trim().toLowerCase() === MAIN_AGENT_NAME ? MAIN_AGENT_NAME : normalizeSubagentName(value);
    return { origin: "tool" as const, ...(to ? { serverName: to } : {}), toolName: SEND_AGENT_MESSAGE_TOOL_NAME };
  };
  return [
    listAgentsEngineTool(scope),
    { activity: addressed, definition: sendAgentMessageTool.tool, effects: sendAgentMessageTool.effects, observationSource: "workspace",
      execute: async (execution) => {
        const call = execution.call;
        const parsed = parseSendAgentMessageArguments(call.arguments);
        if (!parsed.ok) return refusal(call, parsed.code, parsed.message);
        const { message, to, waitForReply } = parsed.value;
        if (to === turn.name) return refusal(call, SUBAGENT_ERROR_CODES.nameInvalid, "That is your own name; write to another agent.");
        const sent = await scope.messaging.send({ chatId: scope.chatId, from: turn.name, nonce: subagentMessageNonce(execution.persistedToolCallId),
          parentRunId: scope.parentRunId, text: message, to, userId: scope.userId });
        if (sent.kind === "refused") return refusal(call, sent.code, sendRefusalText(sent, to));
        return result(call, { delivered: true, to, ...(waitForReply ? { replied: await turn.waitForReply(to, execution) } : {}) });
      } },
    // One open question at a time: the open call is what the main agent is told it asks, so each asks and is claimed on its own.
    { activity: () => ({ origin: "tool" as const, toolName: ASK_PARENT_TOOL_NAME }), definition: askParentTool.tool, effects: askParentTool.effects,
      observationSource: "workspace", serial: true, execute: async (execution) => {
        const call = execution.call;
        const parsed = parseAskParentArguments(call.arguments);
        if (!parsed.ok) return refusal(call, parsed.code, parsed.message);
        const outcome = await turn.ask(parsed.value.question, execution);
        if (outcome === "limit") {
          return refusal(call, SUBAGENT_ERROR_CODES.messageLimit, "You have asked as many questions as a turn may. Report with what you have and what is still open.");
        }
        if (outcome === "unavailable") {
          return refusal(call, SUBAGENT_ERROR_CODES.notActive, "Your question could not be sent now. Go on with a stated assumption, or report blocked.");
        }
        return result(call, QUESTION_RESULTS[outcome]);
      } }
  ];
}
