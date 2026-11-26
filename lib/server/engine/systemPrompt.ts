import {
  ASSISTANT_CHAT_BASELINE_TEMPLATE,
  STANDARD_CHAT_BASELINE_TEMPLATE,
  STANDARD_CHAT_FALLBACK_TIME_ZONE
} from "../../domain/promptTemplates";
import { logEvent } from "../observability";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderRunRequest } from "../providers/types";
import { READ_SECRET_TOOL_NAME } from "../tools/readSecret";
import type { RunTool } from "../tools/types";
import { workspaceSecretVariables } from "../workspace/secrets/manifest";
import type { RunSecretScope, RunSecretSource } from "../workspace/secrets/runSecrets";
import { systemPromptFor, turnContextText, type SavedSecretFact, type SubagentPromptFacts } from "./prompts";

/**
 * The system prompt of a native run's requests (`systemPromptFor`): the
 * model family's prompt and AIQSA's harness section first, then what
 * admission froze into `prompt.system` for the chat (the Workspace contract,
 * the MCP tool index, image guidance, an Assistant's own instructions), then
 * the environment: the date in the admitted zone and the saved secrets
 * `read_secret` reads, each with the environment variables its Workspace
 * commands get. The baseline sentence admission rendered for the old core
 * ("You are a helpful AI assistant. Today is ...") gives way: the family
 * prompt is the persona and the environment carries the date. Personal
 * instructions, the answer rules and Memory stay where the adapters render
 * them, after this text, as on the old core.
 *
 * Provider caches reuse a prompt's longest unchanged prefix, so nothing in
 * this text changes between a chat's turns on one day: what holds only for
 * this run (the time of day, and what admission recorded as this turn's in
 * `prompt.turnGuidance`: its paths, the current message's facts, the chat's
 * images, files and artifacts) leaves it and goes into the turn context the
 * engine sends just before the run's input (`turnContext`). Computed once per
 * run from the run's tools, so every request of the run repeats the same text.
 *
 * Admission writes every part through `appendPromptPart`, and a rewrite goes
 * through `replacePromptSegment`, so `system` and the recorded lists never
 * disagree; `splitTurnGuidance` is the one reader that finds the recorded
 * parts in an admitted request.
 */

/** The admitted baseline's own sentence: the template with its placeholders as one-line wildcards. */
function baselinePattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace("\\{local_date\\}", "[^\\n]+").replace("\\{local_time\\}", "[^\\n]+")}$`, "u");
}

const BASELINES = Object.freeze({
  assistant_chat: baselinePattern(ASSISTANT_CHAT_BASELINE_TEMPLATE),
  standard_chat: baselinePattern(STANDARD_CHAT_BASELINE_TEMPLATE)
});

/** The run's own guidance in `prompt.system`, without the baseline sentence admission put first. */
export function admittedRunGuidance(prompt: ProviderRunRequest["prompt"]): string {
  const system = prompt.system?.trim() ?? "";
  const pattern = prompt.baseline ? BASELINES[prompt.baseline.source] : null;
  if (!pattern) return system;
  const end = system.indexOf("\n\n");
  const first = end < 0 ? system : system.slice(0, end);
  return pattern.test(first) ? (end < 0 ? "" : system.slice(end + 2).trim()) : system;
}

const SEPARATOR = "\n\n";

type AdmittedPrompt = ProviderRunRequest["prompt"];

/**
 * Where an appended part belongs besides `system`: the chat's alone, this
 * turn's (`turnGuidance`, which the native engine sends with the input), or
 * the run's Workspace (`workspaceGuidance`, which stays in the system text and
 * which a sub-agent turn without the Workspace leaves out).
 */
export type PromptPartScope = "chat" | "turn" | "workspace";

/**
 * The prompt with `part` appended to `system` and, for a turn's or the
 * Workspace's part, recorded exactly as appended, in one write: a part added
 * to one representation and not the other was the shape of several fixes.
 * A part without text goes into neither. The stored shape stays `system` with
 * the recorded lists, so a reader of an admitted request still finds each
 * recorded part where it stands (`splitTurnGuidance`).
 */
export function appendPromptPart<Prompt extends AdmittedPrompt>(prompt: Prompt, part: string | null | undefined,
  scope: PromptPartScope): Prompt {
  if (!part?.trim()) return prompt;
  const system = [prompt.system, part].filter(Boolean).join(SEPARATOR);
  if (scope === "turn") return { ...prompt, system, turnGuidance: [...prompt.turnGuidance ?? [], part] };
  if (scope === "workspace") return { ...prompt, system, workspaceGuidance: [...prompt.workspaceGuidance ?? [], part] };
  return { ...prompt, system };
}

/**
 * The prompt with the one place `segment` stands in `system` replaced by
 * `replacement`, and every recorded part rewritten the same way, so each is
 * still found where it stands; null when `segment` is not in `system`
 * exactly once. A PDF retry rewrites its Workspace contract's server-owned
 * segments with it (`preparePdfRetry`).
 */
export function replacePromptSegment<Prompt extends AdmittedPrompt>(prompt: Prompt, segment: string,
  replacement: string): Prompt | null {
  const system = prompt.system ?? "";
  const at = system.indexOf(segment);
  if (at < 0 || at !== system.lastIndexOf(segment)) return null;
  const replaced = (parts: readonly string[] | undefined) => parts?.map((part) => part.split(segment).join(replacement));
  const turnGuidance = replaced(prompt.turnGuidance);
  const workspaceGuidance = replaced(prompt.workspaceGuidance);
  return { ...prompt, system: system.slice(0, at) + replacement + system.slice(at + segment.length),
    ...(turnGuidance ? { turnGuidance } : {}), ...(workspaceGuidance ? { workspaceGuidance } : {}) };
}

/** Where `part` stands whole in `text` between separators, from `from` on; -1 when nowhere. */
function wholePartAt(text: string, part: string, from: number): number {
  for (let at = text.indexOf(part, from); at >= 0; at = text.indexOf(part, at + 1)) {
    const opens = at === 0 || at >= SEPARATOR.length && text.startsWith(SEPARATOR, at - SEPARATOR.length);
    if (opens && (at + part.length === text.length || text.startsWith(SEPARATOR, at + part.length))) return at;
  }
  return -1;
}

/**
 * `guidance` without the parts admission recorded as this turn's, and those
 * parts. A part counts only where it stands whole between separators, found
 * in the order admission appended the parts. One not found (a system prompt
 * replaced since) stays out of both: it is neither cut nor sent twice.
 */
export function splitTurnGuidance(guidance: string, parts: readonly string[] | undefined): Readonly<{
  chat: string;
  turn: readonly string[];
}> {
  let chat = guidance;
  let from = 0;
  const turn: string[] = [];
  for (const part of parts ?? []) {
    if (!part.trim()) continue;
    const at = wholePartAt(chat, part, from);
    if (at < 0) continue;
    // The part leaves with the separator before it, or the one after it when it comes first.
    const start = at === 0 ? 0 : at - SEPARATOR.length;
    const end = at === 0 && at + part.length < chat.length ? part.length + SEPARATOR.length : at + part.length;
    chat = chat.slice(0, start) + chat.slice(end);
    from = start;
    turn.push(part);
  }
  return { chat: chat.trim(), turn };
}

export type NativeSystemPromptInput = Readonly<{
  /** The run's start: the environment's date and the turn's time. */
  now: Date;
  /** The request admission froze. */
  request: ProviderRunRequest;
  /** The main agent's run could research but was not asked to: the harness names the Deep research control (`HarnessPromptInput`). */
  researchControl?: boolean;
  scope: RunSecretScope;
  /** The saved secrets `read_secret` reads; they go into the environment when the tool is offered. */
  secrets?: RunSecretSource;
  /** In place of the AIQSA self-description: a sub-agent's role (`SUBAGENT_ROLE_SECTION`). */
  selfService?: string;
  /** What the main agent's "# Sub-agents" section lists when `call_subagent` is offered. */
  subagents?: SubagentPromptFacts;
  /** The admitted answer route, which picks the family prompt. */
  snapshot: Pick<ProviderExecutionSnapshot, "providerFamily"> & Readonly<{ model: Readonly<{ upstreamModelId: string }> }>;
  /** The run's tools as its registry offers them. */
  tools: readonly Pick<RunTool, "name">[];
}>;

export type NativeSystemPrompt = Readonly<{
  /** The request with its native system prompt; its prompt keeps no turn guidance. */
  request: ProviderRunRequest;
  /** What holds only for this run, for the run context item before its input (`conversation.ts`). */
  turnContext: string;
}>;

async function savedSecrets(input: NativeSystemPromptInput, offered: ReadonlySet<string>): Promise<readonly SavedSecretFact[] | undefined> {
  if (!input.secrets || !offered.has(READ_SECRET_TOOL_NAME)) return undefined;
  try {
    const entries = await input.secrets.list(input.scope);
    // A Workspace run lists its admitted revisions, so these are the variables its guest derives from them.
    const variables = input.request.workspace?.enabled === true ? workspaceSecretVariables(entries) : null;
    return entries.map((entry, index) => ({ kind: entry.kind, name: entry.name, variables: variables?.[index] ?? [] }));
  } catch (error) {
    // The prompt goes without the names; `read_secret` itself says what it cannot read.
    logEvent("service_operation", { action: "degrade", code: "secret_unreadable", error, outcome: "degraded", run_id: input.scope.runId,
      stage: "read", subsystem: "database" });
    return undefined;
  }
}

/** The run's request with its native system prompt, and its turn context. */
export async function withNativeSystemPrompt(input: NativeSystemPromptInput): Promise<NativeSystemPrompt> {
  const { request } = input;
  const tools = input.tools.map((tool) => tool.name);
  const secrets = await savedSecrets(input, new Set(tools));
  const timeZone = request.prompt.baseline?.timeZone ?? STANDARD_CHAT_FALLBACK_TIME_ZONE;
  const prompt = systemPromptFor({ modelId: request.modelId, provider: input.snapshot.providerFamily,
    upstreamModelId: input.snapshot.model.upstreamModelId }, {
    environment: { now: input.now, timeZone, ...(secrets ? { secrets } : {}) },
    ...(input.researchControl ? { researchControl: true } : {}),
    ...(request.memory?.offers === true ? { memoryOffers: true } : {}),
    ...(input.selfService !== undefined ? { selfService: input.selfService } : {}),
    ...(input.subagents ? { subagents: input.subagents } : {}),
    tools,
    webSearch: request.searchPlan.options.length > 0,
    ...(request.searchPlan.options.length === 0 && request.searchPlan.unavailable
      ? { webSearchUnavailable: request.searchPlan.unavailable } : {}),
    workspace: request.workspace?.enabled === true
  });
  // The Workspace's record only tells a sub-agent without it what to leave out (`subagentRequest`): its text stays in the system.
  const { turnGuidance, workspaceGuidance: _workspace, ...admitted } = request.prompt;
  void _workspace;
  const guidance = splitTurnGuidance(admittedRunGuidance(request.prompt), turnGuidance);
  const system = [prompt.stable, guidance.chat, prompt.environment].filter((part) => part.trim()).join("\n\n");
  return {
    request: { ...request, prompt: { ...admitted, system } },
    turnContext: turnContextText({ guidance: guidance.turn, now: input.now, timeZone })
  };
}
