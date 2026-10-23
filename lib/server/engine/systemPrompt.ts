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
import type { RunSecretScope, RunSecretSource } from "../workspace/secrets/runSecrets";
import { systemPromptFor } from "./prompts";

/**
 * The system prompt of a native run's requests (`systemPromptFor`): the
 * model family's prompt and AIQSA's harness section first, then what
 * admission froze into `prompt.system` for this run (the Workspace contract,
 * the MCP tool index, artifact context, image guidance, an Assistant's own
 * instructions), then the environment: date and time in the admitted zone and
 * the names of the saved secrets `read_secret` reads. The baseline sentence
 * admission rendered for the old core ("You are a helpful AI assistant. Today
 * is ...") gives way: the family prompt is the persona and the environment
 * carries the date. Personal instructions, the answer rules and Memory stay
 * where the adapters render them, after this text, as on the old core.
 * Computed once per run from the run's tools, so every request of the run
 * repeats the same text and provider caches reuse it.
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

export type NativeSystemPromptInput = Readonly<{
  /** The run's start: the environment's date and time. */
  now: Date;
  /** The request admission froze. */
  request: ProviderRunRequest;
  scope: RunSecretScope;
  /** The saved secrets `read_secret` reads; their names go into the environment when the tool is offered. */
  secrets?: RunSecretSource;
  /** The admitted answer route, which picks the family prompt. */
  snapshot: Pick<ProviderExecutionSnapshot, "providerFamily"> & Readonly<{ model: Readonly<{ upstreamModelId: string }> }>;
  /** The run's tools as its registry offers them. */
  tools: readonly Pick<RunTool, "name">[];
}>;

async function secretNames(input: NativeSystemPromptInput, offered: ReadonlySet<string>): Promise<readonly string[] | undefined> {
  if (!input.secrets || !offered.has(READ_SECRET_TOOL_NAME)) return undefined;
  try {
    return (await input.secrets.list(input.scope)).map((entry) => entry.name);
  } catch (error) {
    // The prompt goes without the names; `read_secret` itself says what it cannot read.
    logEvent("service_operation", { action: "degrade", code: "secret_unreadable", error, outcome: "degraded", run_id: input.scope.runId,
      stage: "read", subsystem: "database" });
    return undefined;
  }
}

/** The run's request with its native system prompt. */
export async function withNativeSystemPrompt(input: NativeSystemPromptInput): Promise<ProviderRunRequest> {
  const { request } = input;
  const tools = input.tools.map((tool) => tool.name);
  const names = await secretNames(input, new Set(tools));
  const prompt = systemPromptFor({ modelId: request.modelId, provider: input.snapshot.providerFamily,
    upstreamModelId: input.snapshot.model.upstreamModelId }, {
    environment: { now: input.now, timeZone: request.prompt.baseline?.timeZone ?? STANDARD_CHAT_FALLBACK_TIME_ZONE,
      ...(names ? { secretNames: names } : {}) },
    tools,
    workspace: request.workspace?.enabled === true
  });
  const system = [prompt.stable, admittedRunGuidance(request.prompt), prompt.environment].filter((part) => part.trim()).join("\n\n");
  return { ...request, prompt: { ...request.prompt, system } };
}
