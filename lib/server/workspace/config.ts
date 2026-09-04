export const WORKSPACE_RUNTIME_VERSION = "0.6.16";
export const WORKSPACE_MCP_VERSION = "0.6.16";

export type WorkspaceConfig = Readonly<{
  cpus: number;
  diskMiB: number;
  idleTtlSeconds: number;
  imageRef: string;
  maxToolCalls: number;
  maxToolRounds: number;
  mcpVersion: string;
  memoryMiB: number;
  outputFileMaxBytes: number;
  outputMaxFiles: number;
  outputTotalMaxBytes: number;
  retentionSeconds: number;
  runnerToken?: string;
  runnerUrl?: URL;
  runtimeMode: "deterministic" | "remote" | "unconfigured";
  syncToolTimeoutSeconds: number;
  toolOutputMaxBytes: number;
  turnTimeoutSeconds: number;
}>;

export type WorkspaceConfigErrorCode =
  | "workspace_config_invalid"
  | "workspace_deterministic_runtime_forbidden"
  | "workspace_runner_configuration_incomplete";

export class WorkspaceConfigError extends Error {
  readonly code: WorkspaceConfigErrorCode;

  constructor(code: WorkspaceConfigErrorCode) {
    super(code);
    this.code = code;
    this.name = "WorkspaceConfigError";
  }
}

type IntegerSetting = Readonly<{
  defaultValue: number;
  maximum: number;
  minimum: number;
  name: string;
}>;

const integerSettings = Object.freeze({
  cpus: { defaultValue: 2, maximum: 8, minimum: 1, name: "AIQSA_WORKSPACE_CPUS" },
  diskMiB: {
    defaultValue: 10_240,
    maximum: 131_072,
    minimum: 1_024,
    name: "AIQSA_WORKSPACE_DISK_MIB"
  },
  idleTtlSeconds: {
    defaultValue: 1_800,
    maximum: 86_400,
    minimum: 60,
    name: "AIQSA_WORKSPACE_IDLE_TTL_SECONDS"
  },
  maxToolCalls: {
    defaultValue: 80,
    maximum: 200,
    minimum: 1,
    name: "AIQSA_WORKSPACE_MAX_TOOL_CALLS"
  },
  maxToolRounds: {
    defaultValue: 40,
    maximum: 100,
    minimum: 1,
    name: "AIQSA_WORKSPACE_MAX_TOOL_ROUNDS"
  },
  memoryMiB: {
    defaultValue: 4_096,
    maximum: 32_768,
    minimum: 512,
    name: "AIQSA_WORKSPACE_MEMORY_MIB"
  },
  outputFileMaxBytes: {
    defaultValue: 256 * 1_024 * 1_024,
    maximum: 1_073_741_824,
    minimum: 1_024,
    name: "AIQSA_WORKSPACE_OUTPUT_FILE_MAX_BYTES"
  },
  outputMaxFiles: {
    defaultValue: 25,
    maximum: 100,
    minimum: 1,
    name: "AIQSA_WORKSPACE_OUTPUT_MAX_FILES"
  },
  outputTotalMaxBytes: {
    defaultValue: 512 * 1_024 * 1_024,
    maximum: 2_147_483_647,
    minimum: 1_024,
    name: "AIQSA_WORKSPACE_OUTPUT_TOTAL_MAX_BYTES"
  },
  retentionSeconds: {
    defaultValue: 86_400,
    maximum: 2_592_000,
    minimum: 300,
    name: "AIQSA_WORKSPACE_RETENTION_SECONDS"
  },
  syncToolTimeoutSeconds: {
    defaultValue: 120,
    maximum: 300,
    minimum: 1,
    name: "AIQSA_WORKSPACE_SYNC_TOOL_TIMEOUT_SECONDS"
  },
  toolOutputMaxBytes: {
    defaultValue: 128 * 1_024,
    maximum: 1_048_576,
    minimum: 1_024,
    name: "AIQSA_WORKSPACE_TOOL_OUTPUT_MAX_BYTES"
  },
  turnTimeoutSeconds: {
    defaultValue: 1_800,
    maximum: 3_600,
    minimum: 60,
    name: "AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS"
  }
} satisfies Record<string, IntegerSetting>);

function integerValue(
  env: Readonly<Record<string, string | undefined>>,
  setting: IntegerSetting
): number {
  const raw = env[setting.name];
  if (raw === undefined || raw === "") return setting.defaultValue;
  if (!/^\d+$/u.test(raw)) throw new WorkspaceConfigError("workspace_config_invalid");
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < setting.minimum ||
    parsed > setting.maximum
  ) {
    throw new WorkspaceConfigError("workspace_config_invalid");
  }
  return parsed;
}

function boundedText(value: string | undefined, fallback: string, maximum: number): string {
  const candidate = value?.trim() || fallback;
  if (
    new TextEncoder().encode(candidate).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new WorkspaceConfigError("workspace_config_invalid");
  }
  return candidate;
}

function runnerUrl(value: string | undefined): URL | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      new TextEncoder().encode(candidate).byteLength > 2_048
    ) {
      throw new Error("invalid");
    }
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url;
  } catch {
    throw new WorkspaceConfigError("workspace_config_invalid");
  }
}

function runnerToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (token.length < 32 || token.length > 1_024 || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new WorkspaceConfigError("workspace_config_invalid");
  }
  return token;
}

export function getWorkspaceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkspaceConfig {
  const deterministicRequested = env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME === "1";
  if (
    deterministicRequested &&
    (env.NODE_ENV === "production" || env.AIQSA_TEST_MODE !== "1")
  ) {
    throw new WorkspaceConfigError("workspace_deterministic_runtime_forbidden");
  }

  const url = runnerUrl(env.AIQSA_WORKSPACE_RUNNER_URL);
  const token = runnerToken(env.AIQSA_WORKSPACE_RUNNER_TOKEN);
  if (Boolean(url) !== Boolean(token)) {
    throw new WorkspaceConfigError("workspace_runner_configuration_incomplete");
  }

  const config = {
    cpus: integerValue(env, integerSettings.cpus),
    diskMiB: integerValue(env, integerSettings.diskMiB),
    idleTtlSeconds: integerValue(env, integerSettings.idleTtlSeconds),
    imageRef: boundedText(env.AIQSA_WORKSPACE_IMAGE, "aiqsa-workspace:0.1.25", 512),
    maxToolCalls: integerValue(env, integerSettings.maxToolCalls),
    maxToolRounds: integerValue(env, integerSettings.maxToolRounds),
    mcpVersion: boundedText(env.AIQSA_WORKSPACE_MCP_VERSION, WORKSPACE_MCP_VERSION, 64),
    memoryMiB: integerValue(env, integerSettings.memoryMiB),
    outputFileMaxBytes: integerValue(env, integerSettings.outputFileMaxBytes),
    outputMaxFiles: integerValue(env, integerSettings.outputMaxFiles),
    outputTotalMaxBytes: integerValue(env, integerSettings.outputTotalMaxBytes),
    retentionSeconds: integerValue(env, integerSettings.retentionSeconds),
    ...(token ? { runnerToken: token } : {}),
    ...(url ? { runnerUrl: url } : {}),
    runtimeMode: deterministicRequested ? "deterministic" as const : url ? "remote" as const : "unconfigured" as const,
    syncToolTimeoutSeconds: integerValue(env, integerSettings.syncToolTimeoutSeconds),
    toolOutputMaxBytes: integerValue(env, integerSettings.toolOutputMaxBytes),
    turnTimeoutSeconds: integerValue(env, integerSettings.turnTimeoutSeconds)
  };

  if (
    config.retentionSeconds < config.idleTtlSeconds ||
    config.outputTotalMaxBytes < config.outputFileMaxBytes ||
    config.maxToolCalls < config.maxToolRounds
  ) {
    throw new WorkspaceConfigError("workspace_config_invalid");
  }
  if (config.mcpVersion !== WORKSPACE_MCP_VERSION) {
    throw new WorkspaceConfigError("workspace_config_invalid");
  }

  return Object.freeze(config);
}
