import { CLAUDE_FAMILY_PROMPT } from "./claude";
import { GPT_FAMILY_PROMPT } from "./gpt";
import {
  environmentPromptSection,
  harnessPromptSection,
  type EnvironmentPromptInput,
  type HarnessPromptInput
} from "./harness";
import { NEUTRAL_FAMILY_PROMPT } from "./neutral";
import { selfServicePromptSection } from "./selfService";

export {
  HARNESS_SEARCH_TOOL,
  HARNESS_TOOL_NAMES,
  turnContextText,
  type EnvironmentPromptInput,
  type HarnessPromptInput,
  type SavedSecretFact,
  type TurnContextInput
} from "./harness";
export {
  AIQSA_GUIDE_TOPICS,
  SELF_SERVICE_TOOL_NAMES,
  aiqsaGuideText,
  selfServicePromptSection,
  type AiqsaGuideTopic,
  type SelfServicePromptInput
} from "./selfService";

export type SystemPromptFamily = "claude" | "gpt" | "neutral";

/** The admitted route and model, as the run bindings name them. */
export type SystemPromptModel = Readonly<{
  /** Provider id (`openai`, `anthropic`, `openrouter`, `openai_compatible`, ...). */
  provider: string;
  /** Model id as configured, for example `codex-lb:gpt-5.5` or `anthropic/claude-sonnet-5-5`. */
  modelId: string;
  /** The upstream model id when the configured id is an alias. */
  upstreamModelId?: string | null;
}>;

/** OpenAI model identifiers (GPT, o-series, Codex), as `tokenEstimateProfileFor` reads them. */
const OPENAI_MODEL = /^(?:gpt-|chatgpt-|codex-|o[1-9](?:$|[-.]))/iu;
const CLAUDE_MODEL = /^claude(?:$|[-.])/iu;

/** The last path or alias segment: `openrouter`'s `anthropic/claude-x`, codex-lb's `codex-lb:gpt-x`. */
function bareModelName(id: string): string {
  return id.trim().split(/[/:]/u).at(-1) ?? "";
}

export function systemPromptFamily(model: SystemPromptModel): SystemPromptFamily {
  if (model.provider === "anthropic") return "claude";
  if (model.provider === "openai") return "gpt";
  const names = [model.upstreamModelId, model.modelId].filter((id): id is string => typeof id === "string").map(bareModelName);
  if (names.some((name) => CLAUDE_MODEL.test(name))) return "claude";
  if (names.some((name) => OPENAI_MODEL.test(name))) return "gpt";
  return "neutral";
}

const FAMILY_PROMPTS: Readonly<Record<SystemPromptFamily, string>> = {
  claude: CLAUDE_FAMILY_PROMPT,
  gpt: GPT_FAMILY_PROMPT,
  neutral: NEUTRAL_FAMILY_PROMPT
};

export type SystemPrompt = Readonly<{
  family: SystemPromptFamily;
  /** Family prompt and AIQSA harness section; identical across turns of a run's bindings, so provider caches can reuse it. */
  stable: string;
  /** Date, language and saved secrets, the same across a day's turns; place it after `stable`. */
  environment: string;
  /** `stable` followed by `environment`. */
  text: string;
}>;

/**
 * The system prompt for one request: the model family's prompt, AIQSA's
 * harness section (tools on this request, Workspace, when to stop and ask,
 * the self-service section, by default `selfServicePromptSection` for the
 * request's tools), then the user's environment facts. Nothing in it changes
 * within a day of a chat's turns; the time rides with the turn (`turnContextText`).
 */
export function systemPromptFor(model: SystemPromptModel, input: HarnessPromptInput & Readonly<{
  environment: EnvironmentPromptInput;
}>): SystemPrompt {
  const family = systemPromptFamily(model);
  const harness = harnessPromptSection({ ...input, selfService: input.selfService ?? selfServicePromptSection(input) });
  const stable = `${FAMILY_PROMPTS[family]}\n\n${harness}`;
  const environment = environmentPromptSection(input.environment);
  return { environment, family, stable, text: `${stable}\n\n${environment}` };
}
