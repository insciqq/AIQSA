import {
  decodeMemorySettingsResponse,
  MEMORY_SETTINGS_PATCH_KEYS,
  type MemorySettingsPatch,
  type MemorySettingsResponse
} from "../../../contracts/memory";
import type { ResolvedMemoryUtilityPolicy } from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import {
  MemoryPersistenceError,
  type MemoryPersistenceErrorCode
} from "../persistence/errors";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";

export type MemorySettingsCapabilities = MemorySettingsResponse["capabilities"];

export const DEFAULT_MEMORY_SETTINGS_CAPABILITIES: MemorySettingsCapabilities =
  Object.freeze({
    administratorSetupRequired: false,
    automaticLearning: true,
    automaticLearningAvailable: true,
    decayAvailable: true,
    explicitMemory: true,
    historyRecall: true,
    managementAvailable: true,
    naturalLanguageActionsAvailable: true,
    pastChatIndexingAvailable: true,
    permanentChatDeletion: false,
    retrievalAvailable: true,
    synthesisAvailable: true,
    temporaryChats: true
  });

export type MemorySettingsRepository = Readonly<{
  get(userId: string): Promise<MemorySettingsPersistenceSnapshot>;
  patch(
    userId: string,
    input: MemorySettingsPatch
  ): Promise<MemorySettingsPersistenceSnapshot>;
}>;

export type MemorySettingsServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_embedding_unavailable"
  | "memory_version_stale";

export class MemorySettingsServiceError extends Error {
  readonly code: MemorySettingsServiceErrorCode;

  constructor(code: MemorySettingsServiceErrorCode) {
    super(code);
    this.code = code;
    this.name = "MemorySettingsServiceError";
  }
}

export type MemorySettingsService = Readonly<{
  get(userId: string): Promise<MemorySettingsResponse>;
  patch(userId: string, input: MemorySettingsPatch): Promise<MemorySettingsResponse>;
}>;

function serviceFailure(code: MemorySettingsServiceErrorCode): never {
  throw new MemorySettingsServiceError(code);
}

function publicPersistenceCode(
  code: MemoryPersistenceErrorCode
): MemorySettingsServiceErrorCode {
  switch (code) {
    case "memory_revision_conflict":
    case "memory_settings_conflict":
      return "memory_version_stale";
    case "memory_embedding_unavailable":
      return "memory_embedding_unavailable";
    case "memory_input_invalid":
      return "memory_contract_invalid";
    default:
      return "memory_action_failed";
  }
}

async function persist<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MemoryPersistenceError) {
      return serviceFailure(publicPersistenceCode(error.code));
    }
    throw error;
  }
}

function boundedLabel(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const candidate = trimmed.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/u.test(candidate)
    ? candidate.slice(0, -1)
    : candidate;
}

function target(
  policy: ResolvedMemoryUtilityPolicy,
  role: MemoryExecutionRole
) {
  return policy.targets.get(role) ?? null;
}

function responseProjection(
  settings: MemorySettingsPersistenceSnapshot,
  policy: ResolvedMemoryUtilityPolicy,
  capabilities: MemorySettingsCapabilities,
  historyIndexing: MemorySettingsResponse["historyIndexing"]
): MemorySettingsResponse {
  const embedding = target(policy, "MEMORY_DOCUMENT_EMBED");
  const candidate = {
    capabilities,
    historyIndexing,
    settings: {
      decayEnabled: settings.decayEnabled,
      embeddingDeployment: embedding
        ? {
            connectionDisplayName: boundedLabel(
              embedding.snapshot.connectionDisplayName,
              128
            ),
            id: embedding.snapshot.providerModelId,
            modelDisplayName: boundedLabel(embedding.snapshot.modelDisplayName, 128)
          }
        : null,
      learnAutomatically: settings.learnAutomatically,
      memoryGeneration: settings.memoryGeneration,
      memoryRevision: settings.memoryRevision,
      referenceChatHistory: settings.referenceChatHistory,
      sensitiveAutomaticPolicy: settings.sensitiveAutomaticPolicy,
      settingsRevision: settings.settingsRevision,
      // Dream synthesis is retired; one release keeps the field for stale tabs.
      synthesisEnabled: false,
      updatedAt: settings.updatedAt.toISOString(),
      useMemoryFacts: settings.useMemoryFacts
    }
  } satisfies MemorySettingsResponse;
  const decoded = decodeMemorySettingsResponse(candidate);
  if (!decoded.ok) return serviceFailure("memory_action_failed");
  return decoded.value;
}

/** Stale tabs may still send the retired Dream toggle for one release. It is
 * accepted and ignored; a patch that carries nothing else changes nothing. */
function withoutRetiredSettings(patch: MemorySettingsPatch): MemorySettingsPatch | null {
  const { synthesisEnabled: _retired, ...effective } = patch;
  return MEMORY_SETTINGS_PATCH_KEYS.some((key) => Object.hasOwn(effective, key))
    ? effective
    : null;
}

export function createMemorySettingsService(input: Readonly<{
  capabilities?: MemorySettingsCapabilities;
  kick?: () => void;
  readHistoryIndexing?: (
    userId: string,
    settings: MemorySettingsPersistenceSnapshot
  ) => Promise<MemorySettingsResponse["historyIndexing"]>;
  repository: MemorySettingsRepository;
  resolveCapabilities?: (
    settings: MemorySettingsPersistenceSnapshot,
    policy: ResolvedMemoryUtilityPolicy
  ) => MemorySettingsCapabilities | Promise<MemorySettingsCapabilities>;
  resolveCurrentUtilityPolicy(
    userId: string,
    settings: MemorySettingsPersistenceSnapshot
  ): Promise<ResolvedMemoryUtilityPolicy>;
}>): MemorySettingsService {
  const staticCapabilities = Object.freeze({
    ...(input.capabilities ?? DEFAULT_MEMORY_SETTINGS_CAPABILITIES)
  });
  const readHistoryIndexing = input.readHistoryIndexing ?? (async (_userId, settings) => ({
    completedChats: 0,
    state: settings.useMemoryFacts && settings.referenceChatHistory
      ? "READY" as const
      : "DISABLED" as const,
    totalChats: 0
  }));

  function kick(): void {
    try {
      input.kick?.();
    } catch {
      // The durable queue and coordinator timer remain authoritative.
    }
  }

  async function project(
    userId: string,
    settings: MemorySettingsPersistenceSnapshot
  ): Promise<MemorySettingsResponse> {
    const [policy, historyIndexing] = await Promise.all([
      input.resolveCurrentUtilityPolicy(userId, settings),
      readHistoryIndexing(userId, settings)
    ]);
    const capabilities = input.resolveCapabilities
      ? await input.resolveCapabilities(settings, policy)
      : staticCapabilities;
    return responseProjection(
      settings,
      policy,
      capabilities,
      historyIndexing
    );
  }

  async function get(userId: string): Promise<MemorySettingsResponse> {
    const settings = await persist(() => input.repository.get(userId));
    return project(userId, settings);
  }

  return Object.freeze({
    get,

    async patch(userId, patch) {
      const effective = withoutRetiredSettings(patch);
      // No mutation, revision increment or wake: return the current settings.
      if (!effective) return get(userId);
      const settings = await persist(() => input.repository.patch(userId, effective));
      // Enabling the subordinate history toggle is allowed to wake ordinary
      // forward work only while the master is already on.  A combined master
      // resume patch must not trigger a retroactive backfill.
      if (
        effective.referenceChatHistory === true &&
        effective.useMemoryFacts !== true &&
        settings.useMemoryFacts
      ) kick();
      return project(userId, settings);
    }
  });
}
