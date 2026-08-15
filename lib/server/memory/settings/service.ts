import {
  decodeMemorySettingsResponse,
  type MemoryConsentInput,
  type MemoryEgressConsentMode,
  type MemorySettingsPatch,
  type MemorySettingsResponse
} from "../../../contracts/memory";
import type { ResolvedMemoryUtilityPolicy } from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import { resolveMemoryEgressConsentMode } from "../execution/consentMode";
import {
  MemoryPersistenceError,
  type MemoryPersistenceErrorCode
} from "../persistence/errors";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";

export type MemorySettingsCapabilities = MemorySettingsResponse["capabilities"];

export const DEFAULT_MEMORY_SETTINGS_CAPABILITIES: MemorySettingsCapabilities =
  Object.freeze({
    automaticLearning: true,
    explicitMemory: true,
    historyRecall: true,
    permanentChatDeletion: false,
    temporaryChats: true
  });

export type MemorySettingsRepository = Readonly<{
  acceptUtilityEgress(
    userId: string,
    input: MemoryConsentInput
  ): Promise<MemorySettingsPersistenceSnapshot>;
  get(userId: string): Promise<MemorySettingsPersistenceSnapshot>;
  patch(
    userId: string,
    input: MemorySettingsPatch
  ): Promise<MemorySettingsPersistenceSnapshot>;
}>;

export type MemorySettingsServiceErrorCode =
  | "memory_action_failed"
  | "memory_contract_invalid"
  | "memory_egress_admin_owned"
  | "memory_egress_consent_required"
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
  acceptUtilityEgress(
    userId: string,
    input: MemoryConsentInput
  ): Promise<MemorySettingsResponse>;
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
    case "memory_consent_conflict":
    case "memory_revision_conflict":
    case "memory_settings_conflict":
      return "memory_version_stale";
    case "memory_consent_policy_changed":
      return "memory_egress_consent_required";
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

function destinationLabel(
  policy: ResolvedMemoryUtilityPolicy,
  role: MemoryExecutionRole
): string | null {
  const resolved = target(policy, role);
  if (!resolved) return null;
  const connection = boundedLabel(resolved.snapshot.connectionDisplayName, 126);
  const model = boundedLabel(resolved.snapshot.modelDisplayName, 126);
  return `${connection} / ${model}`;
}

function responseProjection(
  settings: MemorySettingsPersistenceSnapshot,
  policy: ResolvedMemoryUtilityPolicy,
  capabilities: MemorySettingsCapabilities,
  consentMode: MemoryEgressConsentMode,
  historyIndexing: MemorySettingsResponse["historyIndexing"]
): MemorySettingsResponse {
  const embedding = target(policy, "MEMORY_DOCUMENT_EMBED");
  const acceptedFingerprint = settings.acceptedUtilityEgressFingerprint;
  const acceptedPolicyVersion = settings.acceptedUtilityPolicyVersion;
  const reviewRequired = consentMode === "PER_USER" && (
    !settings.acceptedUtilityEgressAt ||
    acceptedFingerprint !== policy.fingerprint ||
    acceptedPolicyVersion !== policy.policyVersion
  );
  const candidate = {
    capabilities,
    egress: {
      acceptedAt: settings.acceptedUtilityEgressAt?.toISOString() ?? null,
      acceptedUtilityEgressFingerprint: acceptedFingerprint,
      acceptedUtilityPolicyVersion: acceptedPolicyVersion,
      consentMode,
      currentUtilityEgressFingerprint: policy.fingerprint,
      currentUtilityPolicyVersion: policy.policyVersion,
      embeddingDestination: destinationLabel(policy, "MEMORY_DOCUMENT_EMBED"),
      remoteRerankerDestination: destinationLabel(policy, "MEMORY_RERANK"),
      reviewRequired,
      systemModelDestination: destinationLabel(policy, "MEMORY_FACT_EXTRACT")
    },
    historyIndexing,
    settings: {
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
      memoryConsentRevision: settings.memoryConsentRevision,
      memoryGeneration: settings.memoryGeneration,
      memoryRevision: settings.memoryRevision,
      referenceChatHistory: settings.referenceChatHistory,
      sensitiveAutomaticPolicy: settings.sensitiveAutomaticPolicy,
      settingsRevision: settings.settingsRevision,
      updatedAt: settings.updatedAt.toISOString(),
      useMemoryFacts: settings.useMemoryFacts
    }
  } satisfies MemorySettingsResponse;
  const decoded = decodeMemorySettingsResponse(candidate);
  if (!decoded.ok) return serviceFailure("memory_action_failed");
  return decoded.value;
}

export function createMemorySettingsService(input: Readonly<{
  capabilities?: MemorySettingsCapabilities;
  egressConsentMode?: MemoryEgressConsentMode;
  kick?: () => void;
  readHistoryIndexing?: (
    userId: string,
    settings: MemorySettingsPersistenceSnapshot
  ) => Promise<MemorySettingsResponse["historyIndexing"]>;
  repository: MemorySettingsRepository;
  resolveCapabilities?: (
    settings: MemorySettingsPersistenceSnapshot,
    policy: ResolvedMemoryUtilityPolicy
  ) => MemorySettingsCapabilities;
  resolveCurrentUtilityPolicy(
    userId: string,
    settings: MemorySettingsPersistenceSnapshot
  ): Promise<ResolvedMemoryUtilityPolicy>;
}>): MemorySettingsService {
  const staticCapabilities = Object.freeze({
    ...(input.capabilities ?? DEFAULT_MEMORY_SETTINGS_CAPABILITIES)
  });
  const egressConsentMode = input.egressConsentMode ?? resolveMemoryEgressConsentMode();
  const readHistoryIndexing = input.readHistoryIndexing ?? (async (_userId, settings) => ({
    completedChats: 0,
    state: settings.referenceChatHistory ? "READY" as const : "DISABLED" as const,
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
      ? input.resolveCapabilities(settings, policy)
      : staticCapabilities;
    return responseProjection(
      settings,
      policy,
      capabilities,
      egressConsentMode,
      historyIndexing
    );
  }

  return Object.freeze({
    async acceptUtilityEgress(userId, consent) {
      if (egressConsentMode === "ADMIN") return serviceFailure("memory_egress_admin_owned");
      const settings = await persist(() =>
        input.repository.acceptUtilityEgress(userId, consent)
      );
      return project(userId, settings);
    },

    async get(userId) {
      const settings = await persist(() => input.repository.get(userId));
      return project(userId, settings);
    },

    async patch(userId, patch) {
      const settings = await persist(() => input.repository.patch(userId, patch));
      if (patch.referenceChatHistory === true) kick();
      return project(userId, settings);
    }
  });
}
