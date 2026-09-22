import { WORKSPACE_PROJECT_DIRECTORY } from "@/lib/domain/workspace";

export const CODEX_VERSION = "0.154.0";
/** Bump when managed profile semantics change; accepted thread compatibility includes it. */
export const CODEX_MANAGED_PROFILE_VERSION = 3;
export const CODEX_PROVIDER_MAX_RETRIES = 2;
export const CODEX_HOME_DIRECTORY = "/workspace/.aiqsa/codex";
export const CODEX_RUN_TOKEN_ENV = "AIQSA_AGENT_TOKEN";

export type CodexManagedProfile = Readonly<{
  /** A trusted installation gateway origin, never a model-selected upstream. */
  gatewayOrigin: string;
  modelId: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** Enabled only by the admitted provider capability. */
  nativeWebSearch?: boolean;
  standaloneWebSearch?: boolean;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-owned instructions only. Selected Skills belong in the stdin prompt. */
  developerInstructions: string;
  mcpMode: "auto" | "all" | "off";
  aiqsaSearch?: boolean;
  artifacts?: boolean;
  mcpTimeoutSeconds: number;
}>;

function invalid(): never {
  throw new Error("agent_profile_invalid");
}

function checkedGatewayOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") ||
      url.origin === "null") return invalid();
    return url.origin;
  } catch {
    return invalid();
  }
}

/** No provider key or run bearer is serialized into this on-disk profile. */
export function renderCodexManagedProfile(input: CodexManagedProfile): string {
  const gateway = checkedGatewayOrigin(input.gatewayOrigin);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/u.test(input.modelId) ||
    !Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 4096 ||
    input.contextWindowTokens > 4_194_304 ||
    !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 ||
    input.maxOutputTokens >= input.contextWindowTokens ||
    (input.standaloneWebSearch !== undefined && typeof input.standaloneWebSearch !== "boolean") ||
    (input.aiqsaSearch !== undefined && typeof input.aiqsaSearch !== "boolean") ||
    (input.artifacts !== undefined && typeof input.artifacts !== "boolean") ||
    (input.nativeWebSearch !== undefined && typeof input.nativeWebSearch !== "boolean") ||
    !Number.isSafeInteger(input.mcpTimeoutSeconds) || input.mcpTimeoutSeconds < 1 ||
    !["auto", "all", "off"].includes(input.mcpMode) ||
    Buffer.byteLength(input.developerInstructions) > 256 * 1024 ||
    (input.reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.reasoningEffort))) {
    return invalid();
  }
  // Configure the model envelope; the compaction algorithm remains Codex's.
  const compactAt = Math.min(Math.floor(input.contextWindowTokens * 0.8), input.contextWindowTokens - input.maxOutputTokens);
  const lines = [
    `model = ${JSON.stringify(input.modelId)}`,
    'model_provider = "aiqsa"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    `web_search = "${input.nativeWebSearch === true || input.standaloneWebSearch === true ? "live" : "disabled"}"`,
    'check_for_update_on_startup = false',
    `model_context_window = ${input.contextWindowTokens}`,
    `model_auto_compact_token_limit = ${compactAt}`,
    `developer_instructions = ${JSON.stringify(input.developerInstructions)}`,
    ...(input.reasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(input.reasoningEffort)}`] : []),
    "",
    "[model_providers.aiqsa]",
    'name = "AIQSA"',
    `base_url = ${JSON.stringify(`${gateway}/v1`)}`,
    `env_key = ${JSON.stringify(CODEX_RUN_TOKEN_ENV)}`,
    'wire_api = "responses"',
    'supports_websockets = false',
    `supports_standalone_web_search = ${input.standaloneWebSearch === true}`,
    // One retry owner: Codex retains completed tool results when reconnecting.
    // Nested HTTP retries would multiply physical dispatches behind this bound.
    'request_max_retries = 0',
    `stream_max_retries = ${CODEX_PROVIDER_MAX_RETRIES}`,
    "",
    "[shell_environment_policy]",
    'inherit = "all"',
    // Default exclusions otherwise remove the intentionally supplied *_KEY
    // Workspace secrets. App/provider keys never enter the guest environment.
    'ignore_default_excludes = true',
    "",
    "[features]",
    `standalone_web_search = ${input.standaloneWebSearch === true}`,
    'apps = false',
    'hooks = false',
    'memories = false',
    "",
    "[agents]",
    'enabled = false',
    "",
    "[skills.bundled]",
    'enabled = false',
    "",
    "[analytics]",
    'enabled = false',
    "",
    "[feedback]",
    'enabled = false'
  ];
  if (input.mcpMode !== "off" || input.aiqsaSearch || input.artifacts) {
    lines.push("", "[mcp_servers.aiqsa]",
      `url = ${JSON.stringify(`${gateway}/mcp`)}`,
      `bearer_token_env_var = ${JSON.stringify(CODEX_RUN_TOKEN_ENV)}`,
      'required = true',
      'startup_timeout_sec = 20',
      `tool_timeout_sec = ${input.mcpTimeoutSeconds}`,
      ...(input.mcpMode !== "all" ? [`enabled_tools = ${JSON.stringify([
        ...(input.mcpMode === "auto" ? ["find_tools", "call_tool"] : []), ...(input.aiqsaSearch ? ["aiqsa_search"] : []),
        ...(input.artifacts ? ["create_artifact", "read_artifact"] : [])])}`] : [])
    );
  }
  return lines.join("\n") + "\n";
}

/** argv, not shell source. Prompt and scoped bearer travel separately. */
export function codexExecArguments(threadId?: string): string[] {
  if (threadId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(threadId)) return invalid();
  return [
    "exec", "--json", "--skip-git-repo-check", "--color", "never", "--ignore-rules",
    "--cd", WORKSPACE_PROJECT_DIRECTORY,
    ...(threadId ? ["resume", threadId] : []), "-"
  ];
}
