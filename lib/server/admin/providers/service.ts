import { decodeImageVerificationEvidence } from "../../providers/imageGenerationEvidence";
import { createImageModelDiscovery } from "../../providers/imageModelDiscovery";
import { hasVerifiedDedicatedProtocol } from "../../providers/systemRoleEvidence";
import type { AdminProviderSetupProgress } from "../../../contracts/adminProviderSetupProgress";
import { withTimeoutSignal } from "../../providers/network";
import { decodeParallelToolCallVerificationEvidence } from "../../providers/parallelToolCallEvidence";
import { capabilitySetupIncomplete, decodeCapabilitySetupEvidence, initiallyVerifiedModelConfiguration,
  initialModelConfiguration,
  INITIAL_CAPABILITY_BATCH_TIMEOUT_MS, reusableCapabilitySetupEvidence, settledUnsupportedImageCapabilities } from "./initialCapabilitySetup";
import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
import { createHash, randomUUID } from "node:crypto";
import type {
  AdminProviderActiveCheck,
  AdminProviderCheckRun,
  AdminProviderCheckRunReason,
  AdminProviderConnection,
  AdminProviderConnectionConfiguration,
  AdminProviderDeleteResult,
  AdminProviderFamily,
  AdminProviderModelConfiguration,
  AdminProviderModelEditGuard,
  AdminProviderModelRename,
  AdminProviderModel,
  AdminProviderTestEvidence,
  AdminProviderUnassignedPolicy
} from "../../../contracts/adminProviders";
import {
  createCapabilityCheckRunner,
  type CapabilityCheckOutcome,
  type CapabilityCheckRequest,
  type InitialCapabilityCheck
} from "./capabilityCheckRuns";
import {
  decryptProviderCredentialSecret,
  encryptProviderCredentialSecret
} from "../../providers/credentialSecrets";
import {
  adminProviderModelConfiguration,
  normalizeAdminProviderConnectionConfiguration,
  normalizeAdminProviderModelConfiguration
} from "./adminConfiguration";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS, type AdminProviderQuickSetupProviderId } from "../../../contracts/adminProviderQuickSetup";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import { providerSetupModels } from "./setupModels";
import {
  effectiveProviderResponseTimeoutMs,
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import type { ProviderCredentialSource } from "../../providers/providerCredentialSource";
import {
  createOpenRouterDiscoveryClient,
  type OpenRouterDiscoveryClient
} from "../../providers/openRouterDiscovery";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type {
  AdminProviderCredentialTester,
  AdminProviderCredentialTestOutcome
} from "./credentialTester";
import type {
  AdminProviderRepository,
  ProviderActivationCandidate,
  ProviderActivationWrite,
  ProviderActiveRefreshCandidate,
  ProviderCatalogAccessCheck,
  ProviderCatalogCredentialCheck,
  ProviderConnectionSettingsWrite,
  ProviderCredentialActivationWrite,
  ProviderCredentialSecretSource,
  ProviderDisableTarget,
  ProviderDraftMutationResult,
  StoredProviderDraftCheck
} from "./repositoryContract";
import type {
  AdminProviderDraftTester,
  AdminProviderDraftTestMode,
  AdminProviderDraftTestOutcome
} from "./tester";
import { decodeStructuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { decodeForcedToolCallVerificationEvidence } from
  "../../providers/forcedToolCallEvidence";
import { decodePdfInputVerificationEvidence } from "../../providers/pdfInputEvidence";
import { decodeVisionInputVerificationEvidence } from "../../providers/visionInputEvidence";
import { decodeAdminProviderCompatibilityEvidence } from "./compatibilityEvidence";
import { isApprovedRerankerProviderModelId } from "./approvedRerankers";

const MAX_NAME_LENGTH = 160;

export type AdminProviderServiceErrorCode =
  | "provider_active_tuple_not_found"
  | "provider_activation_empty"
  | "provider_activation_evidence_missing"
  | "provider_activation_unavailable_confirmation_required"
  | "provider_check_run_not_found"
  | "provider_connection_not_found"
  | "provider_endpoint_keys_required"
  | "provider_credential_label_taken"
  | "provider_credential_not_found"
  | "provider_credential_test_failed"
  | "provider_delete_confirmation_required"
  | "provider_discovery_failed"
  | "provider_discovery_unsupported"
  | "provider_draft_stale"
  | "provider_draft_test_failed"
  | "provider_family_adapter_mismatch"
  | "provider_group_not_found"
  | "provider_model_class_immutable"
  | "provider_model_not_found"
  | "provider_name_invalid"
  | "provider_paid_test_confirmation_required"
  | "provider_revoke_confirmation_required"
  | "provider_refresh_failed"
  | "provider_test_evidence_invalid"
  | "provider_test_mode_invalid";

export class AdminProviderServiceError extends Error {
  readonly code: AdminProviderServiceErrorCode;
  readonly resourceIds: string[];

  constructor(code: AdminProviderServiceErrorCode, resourceIds: string[] = []) {
    super(code);
    this.code = code;
    this.name = "AdminProviderServiceError";
    this.resourceIds = [...new Set(resourceIds)].sort();
  }
}

export type AdminProviderService = ReturnType<typeof createAdminProviderService>;

function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new AdminProviderServiceError("provider_name_invalid");
  }
  return value.trim();
}

function requireUpdated(result: ProviderDraftMutationResult): void {
  if (result === "stale") {
    throw new AdminProviderServiceError("provider_draft_stale");
  }
  if (result === "not_found") {
    throw new AdminProviderServiceError("provider_connection_not_found");
  }
}

function expectedFamily(model: ProviderModelConfiguration): AdminProviderFamily {
  if (model.modelClass === "embedding") {
    return model.embedding!.providerFamily;
  }
  if (model.modelClass === "reranker") return "openrouter";
  switch (model.adapterKind) {
    case "anthropic_messages":
      return "anthropic";
    case "deepseek_responses_native":
      return "deepseek";
    case "gemini_images_native":
    case "gemini_interactions_native":
      return "gemini";
    case "openai_images_compatible":
    case "openai_chat_completions_compatible":
    case "openai_responses_compatible":
      return "openai_compatible";
    case "openai_images_native":
    case "openai_responses_native":
      return "openai";
    case "openai_embeddings_compatible":
      throw new AdminProviderServiceError("provider_family_adapter_mismatch");
    case "openrouter_images":
    case "openrouter_chat_completions":
      return "openrouter";
    case "openrouter_rerank":
      throw new AdminProviderServiceError("provider_family_adapter_mismatch");
  }
}

function validateFamily(family: string, model: ProviderModelConfiguration): void {
  if (family !== expectedFamily(model)) {
    throw new AdminProviderServiceError("provider_family_adapter_mismatch");
  }
}

function realProviderFamily(value: string): AdminProviderFamily {
  if (
    value === "anthropic" ||
    value === "deepseek" ||
    value === "gemini" ||
    value === "openai" ||
    value === "openai_compatible" ||
    value === "openrouter"
  ) {
    return value;
  }
  throw new AdminProviderServiceError("provider_credential_test_failed");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function catalogAccessChecks(
  connection: { models: readonly Pick<AdminProviderModel, "activeConfig" | "activeVersion" | "id">[] },
  outcome: AdminProviderCredentialTestOutcome
): ProviderCatalogAccessCheck[] {
  return connection.models.flatMap((model) => {
    if (!model.activeConfig || model.activeVersion < 1) return [];
    const configuration = model.activeConfig;
    const available = (outcome.modelIdsByClass?.[configuration.modelClass] ?? outcome.modelIds)
      .includes(configuration.upstreamModelId);
    return [{
      evidence: {
        detail: available ? "ok" as const : "model_missing" as const,
        method: "models_catalog" as const,
        selectedProviders: configuration.openRouterRouting?.providers ?? [],
        upstreamModelId: configuration.upstreamModelId
      },
      modelVersion: model.activeVersion,
      providerModelId: model.id,
      status: available ? "available" as const : "unavailable" as const
    }];
  });
}

export function providerCredentialDraftValueId(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AdminProviderServiceError("provider_draft_stale");
  }
  return `draft:${version}`;
}

function secretValueId(source: ProviderCredentialSecretSource): string {
  return source.kind === "draft"
    ? providerCredentialDraftValueId(source.draftVersion)
    : source.versionId;
}

function validateEvidence(
  outcome: AdminProviderDraftTestOutcome,
  mode: AdminProviderDraftTestMode,
  model: ProviderModelConfiguration
): AdminProviderTestEvidence {
  const expectedMethod = mode === "account_catalog"
    ? "openrouter_account_catalog"
    : "tiny_generation";
  const expectedProviders = model.openRouterRouting?.providers ?? [];
  const evidence = outcome.evidence;
  const structuredOutput = decodeStructuredOutputVerificationEvidence(
    evidence.structuredOutput
  );
  const forcedToolCall = decodeForcedToolCallVerificationEvidence(
    evidence.forcedToolCall
  );
  const pdfInput = decodePdfInputVerificationEvidence(evidence.pdfInput);
  const visionInput = decodeVisionInputVerificationEvidence(evidence.visionInput);
  const imageGeneration = decodeImageVerificationEvidence(evidence.imageGeneration);
  const imageEditing = decodeImageVerificationEvidence(evidence.imageEditing);
  const invalidImageProof = (["imageGeneration", "imageEditing"] as const).some((key) => {
    const proof = decodeImageVerificationEvidence(evidence[key]);
    return evidence[key] !== undefined && (model.modelClass !== "image" || !proof || proof.adapterKind !== model.adapterKind || proof.upstreamModelId !== model.upstreamModelId);
  });
  const hasPdfInput = Object.prototype.hasOwnProperty.call(evidence, "pdfInput");
  const compatibility = decodeAdminProviderCompatibilityEvidence(evidence.compatibility);
  const capabilitySetup = decodeCapabilitySetupEvidence(evidence.capabilitySetup);
  const parallelToolCalls = decodeParallelToolCallVerificationEvidence(evidence.parallelToolCalls);
  const hasCompatibility = Object.prototype.hasOwnProperty.call(evidence, "compatibility");
  if (
    invalidImageProof ||
    evidence.method !== expectedMethod ||
    evidence.upstreamModelId !== model.upstreamModelId ||
    evidence.selectedProviders.length !== expectedProviders.length ||
    evidence.selectedProviders.some((provider, index) => provider !== expectedProviders[index]) ||
    (outcome.status === "available") !== (evidence.detail === "ok") ||
    (evidence.embedding !== undefined && model.modelClass !== "embedding") ||
    (evidence.reranking !== undefined && model.modelClass !== "reranker") ||
    ((evidence.embedding !== undefined || evidence.reranking !== undefined) &&
      !hasVerifiedDedicatedProtocol(evidence, model)) ||
    (hasCompatibility && !compatibility) ||
    (evidence.capabilitySetup !== undefined && !capabilitySetup) ||
    (evidence.parallelToolCalls !== undefined && (!parallelToolCalls ||
      parallelToolCalls.adapterKind !== model.adapterKind || parallelToolCalls.upstreamModelId !== model.upstreamModelId)) ||
    (compatibility && (
      compatibility.modelAccess !== (outcome.status === "available"
        ? "verified"
        : "not_supported") ||
      (compatibility.directPdf === "verified") !== Boolean(pdfInput) ||
      (compatibility.vision === "verified") !== Boolean(visionInput) ||
      (compatibility.forcedToolCall === "verified") !== Boolean(forcedToolCall) ||
      (compatibility.structuredOutput === "verified") !== Boolean(structuredOutput) ||
      (outcome.status === "unavailable" && (
        compatibility.streaming === "verified" || compatibility.usage === "verified" ||
        compatibility.toolCalling === "verified"
      )) ||
      (model.modelClass !== "answer" && (
        compatibility.directPdf === "verified" ||
        compatibility.toolCalling === "verified" ||
        compatibility.forcedToolCall === "verified" ||
        compatibility.streaming === "verified" ||
        compatibility.structuredOutput === "verified"
      ))
    )) ||
    (Object.hasOwn(evidence, "visionInput") &&
      (!visionInput || visionInput.adapterKind !== model.adapterKind ||
        visionInput.upstreamModelId !== model.upstreamModelId || model.modelClass !== "answer")) ||
    (hasPdfInput && (!pdfInput ||
      pdfInput.adapterKind !== model.adapterKind ||
      pdfInput.upstreamModelId !== model.upstreamModelId)) ||
    (forcedToolCall !== null && (
      forcedToolCall.adapterKind !== model.adapterKind ||
      forcedToolCall.upstreamModelId !== model.upstreamModelId
    )) ||
    (structuredOutput !== null && (
      structuredOutput.adapterKind !== model.adapterKind ||
      structuredOutput.upstreamModelId !== model.upstreamModelId
    ))
  ) {
    throw new AdminProviderServiceError("provider_test_evidence_invalid");
  }
  return {
    ...(capabilitySetup ? { capabilitySetup } : {}),
    ...(imageGeneration ? { imageGeneration } : {}),
    ...(imageEditing ? { imageEditing } : {}),
    ...(parallelToolCalls ? { parallelToolCalls } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(evidence.embedding && hasVerifiedDedicatedProtocol(evidence, model) ? { embedding: {
      probeVersion: 1 as const, document: true as const, query: true as const, dimensions: evidence.embedding.dimensions
    } } : {}),
    ...(evidence.reranking && hasVerifiedDedicatedProtocol(evidence, model) ? { reranking: {
      probeVersion: 1 as const, completeScores: true as const
    } } : {}),
    detail: evidence.detail,
    method: evidence.method,
    selectedProviders: [...evidence.selectedProviders],
    ...(pdfInput ? { pdfInput } : {}),
    ...(visionInput ? { visionInput } : {}),
    ...(forcedToolCall ? { forcedToolCall } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
    upstreamModelId: evidence.upstreamModelId
  };
}

function activationFingerprint(input: {
  connectionId: string;
  connectionVersion: number;
  credentialDraftVersion: number | null;
  credentialId: string;
  credentialVersionId: string | null;
  modelId: string;
  modelVersion: number;
}): string {
  return createHash("sha256").update(canonicalJson({ ...input, version: 1 }), "utf8").digest("hex");
}

type ActiveCheckResult =
  | { check: AdminProviderActiveCheck; kind: "stored" }
  | { check?: AdminProviderActiveCheck; kind: "cancelled" | "failed" | "save_failed" | "stale" };

class ActiveCheckpointError extends Error {
  constructor(readonly kind: "save_failed" | "stale") { super("provider_checkpoint_failed"); }
}

export function createAdminProviderService(input: Readonly<{
  completeSetup?(input: {
    connectionId: string; credentialId: string; signal: AbortSignal; userId: string;
  }): Promise<import("../../../contracts/adminProviders").AdminProviderBootstrapResult>;
  /** Parallel background checks per connection (PRD decision: 3). */
  checkConcurrency?: number;
  checkRunIdFactory?: () => string;
  credentialTester: AdminProviderCredentialTester;
  createDiscoveryClient?: (input: {
    allowPrivateNetwork: boolean;
    apiRoot: string;
    bearerToken: ProviderCredentialSource;
    responseTimeoutMs: number;
  }) => OpenRouterDiscoveryClient;
  encryptionKey?: () => Buffer;
  idFactory?: () => string;
  now?: () => Date;
  repository: AdminProviderRepository;
  tester: AdminProviderDraftTester;
}>) {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;
  const idFactory = input.idFactory ?? randomUUID;
  const now = input.now ?? (() => new Date());
  const pendingSetupChecks = new Map<string, { complete: boolean; expiresAt: number; outcome: AdminProviderDraftTestOutcome }>();
  const checkRuns = createCapabilityCheckRunner({
    check: (request) => checkActiveModel(request),
    concurrency: input.checkConcurrency,
    idFactory: input.checkRunIdFactory,
    now
  });

  async function activeCredentialSecret(
    credentialId: string,
    versionId: string,
    missingCode: AdminProviderServiceErrorCode = "provider_credential_not_found"
  ): Promise<string> {
    const secret = await input.repository.withLockedCredential(
      credentialId,
      versionId,
      (version) => {
        if (
          version.credentialId !== credentialId || version.id !== versionId ||
          version.revokedAt || !version.secretEnvelope
        ) {
          throw new AdminProviderServiceError(missingCode);
        }
        return decryptProviderCredentialSecret({
          credentialId,
          envelope: version.secretEnvelope,
          key: encryptionKey(),
          valueId: version.id
        });
      }
    );
    if (!secret) throw new AdminProviderServiceError(missingCode);
    return secret;
  }

  function credentialSecretSource(
    credentialId: string,
    source: ProviderCredentialSecretSource,
    missingCode: AdminProviderServiceErrorCode = "provider_credential_not_found"
  ): ProviderCredentialSource {
    if (source.kind === "draft") {
      return decryptProviderCredentialSecret({
        credentialId,
        envelope: source.envelope,
        key: encryptionKey(),
        valueId: providerCredentialDraftValueId(source.draftVersion)
      });
    }
    return () => activeCredentialSecret(credentialId, source.versionId, missingCode);
  }

  async function testCredentialCatalog(value: {
    connection: AdminProviderConnectionConfiguration | ProviderConnectionConfiguration;
    family: string;
    modelClasses?: readonly ProviderModelConfiguration["modelClass"][];
    secret: ProviderCredentialSource | null;
    signal?: AbortSignal;
  }): Promise<AdminProviderCredentialTestOutcome> {
    try {
      const connection = "responseTimeoutSeconds" in value.connection
        ? normalizeAdminProviderConnectionConfiguration(value.connection)
        : normalizeProviderConnectionConfiguration(value.connection);
      return await input.credentialTester.test({
        connection,
        family: realProviderFamily(value.family),
        ...(value.modelClasses ? { modelClasses: value.modelClasses } : {}),
        secret: value.secret,
        signal: value.signal
      });
    } catch {
      throw new AdminProviderServiceError("provider_credential_test_failed");
    }
  }

  async function discoveryClient(value: { connectionId: string; credentialId: string }) {
    const candidate = await input.repository.loadDiscoveryCandidate(value);
    if (!candidate) {
      throw new AdminProviderServiceError("provider_credential_not_found");
    }
    if (candidate.connection.family !== "openrouter") {
      throw new AdminProviderServiceError("provider_discovery_unsupported");
    }
    const configuration = normalizeProviderConnectionConfiguration(
      candidate.connection.configuration
    );
    const source = candidate.credential.source;
    if (!source) {
      throw new AdminProviderServiceError("provider_credential_not_found");
    }
    const bearerToken = credentialSecretSource(candidate.credential.id, source);
    return (input.createDiscoveryClient ?? createOpenRouterDiscoveryClient)({
      allowPrivateNetwork: configuration.allowPrivateNetwork,
      apiRoot: configuration.apiRoot,
      bearerToken,
      responseTimeoutMs: effectiveProviderResponseTimeoutMs(configuration)
    });
  }

  /**
   * One-step key save (PRD B1): the plaintext secret is tested against the
   * connection's active configuration (the draft only while nothing was ever
   * activated), then written as an immutable active version of exactly one
   * credential. A rejected key writes nothing.
   */
  async function activateCredentialSecret(value: {
    userId?: string;
    connectionId: string;
    credential:
      | { kind: "new"; label: string }
      | { credentialId: string; expectedDraftVersion: number; kind: "rotate" };
    secret: string;
    signal?: AbortSignal;
    startChecks?: boolean;
  }): Promise<{ credentialId: string; versionId: string }> {
    const connection = (await input.repository.listConnections())
      .find(({ id }) => id === value.connectionId);
    if (!connection) {
      throw new AdminProviderServiceError("provider_connection_not_found");
    }
    const label = value.credential.kind === "new" ? name(value.credential.label) : null;
    if (value.credential.kind === "rotate") {
      const credentialId = value.credential.credentialId;
      const credential = connection.credentials.find(({ id }) => id === credentialId);
      if (!credential) {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
      if (credential.draftVersion !== value.credential.expectedDraftVersion) {
        throw new AdminProviderServiceError("provider_draft_stale");
      }
    }
    const initialSetup = connection.activeVersion === 0;
    const setupPolicy = ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(connection.family as AdminProviderQuickSetupProviderId)
      ? adminProviderQuickSetupPolicy(connection.family as AdminProviderQuickSetupProviderId) : null;
    const setupModels = providerSetupModels(connection.family, (connection.activeConfig ?? connection.draftConfig).apiRoot);
    const modelClasses = [...new Set([
      ...connection.models.filter((model) => initialSetup || model.enabled)
        .map((model) => model.modelClass ?? model.draftConfig.modelClass),
      ...setupModels.map((candidate) => candidate.configuration.modelClass)
    ])];
    const outcome = await testCredentialCatalog({
      connection: connection.activeConfig ?? connection.draftConfig,
      family: connection.family,
      modelClasses: modelClasses.length ? modelClasses : ["answer"],
      secret: value.secret,
      signal: value.signal
    });
    const credentialId = value.credential.kind === "new" ? idFactory() : value.credential.credentialId;
    const versionId = idFactory();
    const models = initialSetup ? connection.models.map((model) => {
      const configuration = normalizeAdminProviderModelConfiguration(model.draftConfig);
      validateFamily(connection.family, configuration);
      return {
        configuration,
        draftVersion: model.draftVersion,
        enabled: (outcome.modelIdsByClass?.[configuration.modelClass] ?? outcome.modelIds)
          .includes(configuration.upstreamModelId),
        expectedEnabled: model.enabled,
        id: model.id
      };
    }) : [];
    const additions = setupModels.filter((candidate) =>
      (outcome.modelIdsByClass?.[candidate.configuration.modelClass] ?? outcome.modelIds)
        .includes(candidate.configuration.upstreamModelId) && !connection.models.some((model) =>
        model.draftConfig.upstreamModelId === candidate.configuration.upstreamModelId))
      .map((candidate) => ({
        configuration: candidate.configuration.modelClass === "image" ? { ...candidate.configuration,
          image: outcome.imageModels?.find((entry) => entry.id === candidate.configuration.upstreamModelId)?.image ?? candidate.configuration.image } : candidate.configuration,
        displayName: candidate.displayName,
        id: connection.id === setupPolicy?.connection.id ? candidate.modelId : idFactory(),
        inputTokenPriceMicros: candidate.inputTokenPriceMicros,
        outputTokenPriceMicros: candidate.outputTokenPriceMicros,
        templateKey: connection.id === setupPolicy?.connection.id ? candidate.templateKey : null
      }));
    const checkedConnection = {
      models: [...connection.models.map((model) => initialSetup ? ({
        ...model,
        activeConfig: model.draftConfig,
        activeVersion: model.draftVersion
      }) : model), ...additions.map((model) => ({
        id: model.id, activeConfig: adminProviderModelConfiguration(model.configuration), activeVersion: 1
      }))]
    };
    let isolationRefresh: ProviderCredentialActivationWrite["isolationRefresh"];
    const activeConfiguration = connection.activeConfig
      ? normalizeAdminProviderConnectionConfiguration(connection.activeConfig) : null;
    if (activeConfiguration && connection.family === "openai_compatible" &&
      activeConfiguration.responsesRequestIsolation !== undefined) {
      const catalogDetections = [outcome.responsesRequestIsolationDetected === true];
      const credentials: ProviderCatalogCredentialCheck[] = [];
      for (const current of connection.credentials) {
        if (!current.activeVersion || current.activeVersion.revokedAt) continue;
        // The rotated key's candidate catalog replaces its old catalog. Other
        // keys use their active secret, including disabled/unreferenced keys.
        const currentOutcome = current.id === credentialId ? outcome : await testCredentialCatalog({
          connection: activeConfiguration,
          family: connection.family,
          modelClasses: modelClasses.length ? modelClasses : ["answer"],
          secret: () => activeCredentialSecret(current.id, current.activeVersion!.id),
          signal: value.signal
        });
        catalogDetections.push(currentOutcome.responsesRequestIsolationDetected === true);
        credentials.push({
          credentialId: current.id,
          expectedDraftVersion: current.draftVersion,
          expectedVersionId: current.activeVersion.id,
          modelChecks: catalogAccessChecks(checkedConnection, currentOutcome)
        });
      }
      isolationRefresh = {
        configuration: { ...activeConfiguration, responsesRequestIsolationDetected: catalogDetections.every(Boolean) },
        credentials
      };
    }
    const result = await input.repository.activateCredentialCas({
      ...(isolationRefresh ? { isolationRefresh } : {}),
      catalogAdditions: additions,
      ...(initialSetup ? { bootstrap: {
        configuration: {
          ...normalizeAdminProviderConnectionConfiguration(connection.draftConfig),
          ...(connection.family === "openai_compatible" && connection.draftConfig.responsesRequestIsolation !== undefined
            ? { responsesRequestIsolationDetected: outcome.responsesRequestIsolationDetected === true } : {})
        },
        models
      } } : {}),
      checkedAt: now(),
      connectionId: connection.id,
      expectedConnectionDraftVersion: connection.draftVersion,
      expectedConnectionVersion: connection.activeVersion,
      credential: value.credential.kind === "new"
        ? { id: credentialId, kind: "new", label: label! }
        : {
            expectedDraftVersion: value.credential.expectedDraftVersion,
            id: credentialId,
            kind: "rotate"
          },
      now: now(),
      modelChecks: catalogAccessChecks(checkedConnection, outcome),
      testEvidence: {
        method: outcome.method,
        modelCount: outcome.modelIds.length,
        version: 1
      },
      versionEnvelope: encryptProviderCredentialSecret({
        credentialId,
        key: encryptionKey(),
        secret: value.secret,
        valueId: versionId
      }),
      versionId
    });
    if (result === "connection_not_found") {
      throw new AdminProviderServiceError("provider_connection_not_found");
    }
    if (result === "credential_not_found") {
      throw new AdminProviderServiceError("provider_credential_not_found");
    }
    if (result === "label_taken") {
      throw new AdminProviderServiceError("provider_credential_label_taken");
    }
    if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
    if (value.startChecks !== false) {
      const changed = isolationRefresh && activeConfiguration?.responsesRequestIsolationDetected !==
        isolationRefresh.configuration.responsesRequestIsolationDetected;
      const credentialIds = new Set([credentialId, ...(changed ? connection.credentials.filter((current) =>
        current.enabled && current.activeVersion && !current.activeVersion.revokedAt).map(({ id }) => id) : [])]);
      for (const id of credentialIds) {
        await startBackgroundChecks({ connectionId: connection.id, credentialId: id, reason: "credential", userId: value.userId });
      }
    }
    return { credentialId, versionId };
  }

  /** Each checkpoint is a guarded durable write. Only revisions produced by
   * this setup may advance its next CAS; external edits and cancellation fence it. */
  async function executeActiveCheck(value: {
    candidate: ProviderActiveRefreshCandidate;
    capabilityRole?: SystemModelVerificationRole;
    mode: AdminProviderDraftTestMode;
    signal?: AbortSignal;
    initialSetup?: InitialCapabilityCheck;
    onCapabilityProgress?: CapabilityCheckRequest["onCapabilityProgress"];
    onSavedCheckpoint?(check: AdminProviderActiveCheck): void;
  }): Promise<ActiveCheckResult> {
    let candidate = value.candidate;
    const connection = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
    let model = normalizeProviderModelConfiguration(candidate.model.configuration);
    const exactSetup = value.initialSetup && value.initialSetup.connectionVersion === candidate.connection.version &&
      value.initialSetup.modelVersion === candidate.model.version && value.initialSetup.credentialVersionId === candidate.credential.versionId;
    const initialSetup = Boolean(exactSetup && value.initialSetup?.activateCapabilities !== false);
    const cacheKey = () => createHash("sha256").update(canonicalJson({
      connection: candidate.connection, model: candidate.model, credentialId: candidate.credential.id,
      credentialVersionId: candidate.credential.versionId, checkEvidence: candidate.checkEvidence, policyVersion: 2
    })).digest("hex");
    for (const [key, cached] of pendingSetupChecks) if (cached.expiresAt <= Date.now()) pendingSetupChecks.delete(key);
    validateFamily(candidate.connection.family, model);
    const keyless = connection.authenticationMode === "none" && candidate.connection.family === "openai_compatible";
    if ((candidate.credential.envelope === null) !== keyless) throw new AdminProviderServiceError("provider_active_tuple_not_found");
    const secret = candidate.credential.envelope === null ? null : credentialSecretSource(candidate.credential.id, {
      envelope: candidate.credential.envelope, kind: "active", versionId: candidate.credential.versionId
    }, "provider_active_tuple_not_found");
    let lastSaved: AdminProviderActiveCheck | undefined;
    async function persist(outcome: AdminProviderDraftTestOutcome, complete: boolean): Promise<AdminProviderActiveCheck> {
      value.signal?.throwIfAborted();
      const activatedModel = initialSetup ? initiallyVerifiedModelConfiguration(model, outcome.evidence) : model;
      const activatedConfiguration = canonicalJson(activatedModel) !== canonicalJson(model) ? activatedModel : undefined;
      const evidence = validateEvidence(outcome, value.mode, activatedModel);
      if (lastSaved?.status === outcome.status && canonicalJson(lastSaved.evidence) === canonicalJson(evidence)) return lastSaved;
      const key = cacheKey();
      if (!value.capabilityRole) {
        if (pendingSetupChecks.size >= 256) pendingSetupChecks.delete(pendingSetupChecks.keys().next().value!);
        pendingSetupChecks.set(key, { complete, expiresAt: Date.now() + INITIAL_CAPABILITY_BATCH_TIMEOUT_MS,
          outcome: { evidence, status: outcome.status } });
      }
      const checkedAt = now();
      let stored: "stored" | "stale";
      try { stored = await input.repository.storeActiveRefreshCas({ candidate, capabilityRole: value.capabilityRole, checkedAt, evidence,
        status: outcome.status, signal: value.signal, ...(activatedConfiguration ? { activatedConfiguration } : {}) }); }
      catch { value.signal?.throwIfAborted(); throw new ActiveCheckpointError("save_failed"); }
      if (stored === "stale") { pendingSetupChecks.delete(key); throw new ActiveCheckpointError("stale"); }
      pendingSetupChecks.delete(key);
      if (activatedConfiguration) {
        model = activatedConfiguration;
        candidate = { ...candidate, model: { ...candidate.model, configuration: model,
          version: candidate.model.version + 1, draftVersion: candidate.model.version + 1 } };
      }
      if (!value.capabilityRole) candidate = { ...candidate, checkEvidence: { evidence, status: outcome.status } };
      lastSaved = { checkedAt: checkedAt.toISOString(), connectionVersion: candidate.connection.version,
        credentialId: candidate.credential.id, credentialVersionId: candidate.credential.versionId, evidence,
        latestRefreshError: null, modelVersion: candidate.model.version, providerModelId: candidate.model.id,
        refreshFailedAt: null, status: outcome.status };
      value.onSavedCheckpoint?.(lastSaved);
      return lastSaved;
    }
    try {
      const cached = value.capabilityRole ? undefined : pendingSetupChecks.get(cacheKey());
      const outcome = cached?.complete ? cached.outcome : await input.tester.test({
        ...(initialSetup ? { initialSetup: true } : {}),
        ...(candidate.priorEvidence ? { priorEvidence: candidate.priorEvidence } : {}),
        ...(!value.capabilityRole ? {
          reuseSetupEvidence: cached?.outcome.evidence ?? (exactSetup ? value.initialSetup?.reuseEvidence : undefined),
          onCapabilityProgress: value.onCapabilityProgress,
          onSetupCheckpoint: async (checkpoint: AdminProviderDraftTestOutcome) => { await persist(checkpoint, false); }
        } : { capabilityRole: value.capabilityRole }),
        connection, connectionDisplayName: candidate.connection.displayName, connectionId: candidate.connection.id,
        credentialId: candidate.credential.id, credentialVersionIdentity: candidate.credential.versionId,
        mode: value.mode, model, modelDisplayName: candidate.model.displayName,
        providerFamily: candidate.connection.family, providerModelId: candidate.model.id, secret, signal: value.signal
      });
      value.signal?.throwIfAborted();
      return { kind: "stored", check: await persist(outcome, true) };
    } catch (error) {
      const saved = lastSaved ? { check: lastSaved } : {};
      if (value.signal?.aborted) return { kind: "cancelled", ...saved };
      if (error instanceof ActiveCheckpointError) return { kind: error.kind, ...saved };
      if (error instanceof AdminProviderServiceError && error.code === "provider_test_evidence_invalid") throw error;
      if (await input.repository.recordActiveRefreshFailureCas({ candidate, failedAt: now() }) === "stale") return { kind: "stale", ...saved };
      return { kind: "failed", ...saved };
    }
  }

  /**
   * Background check of one enabled active model with one key (PRD B3):
   * `tiny_generation` for answer models, the embed round-trip for embedding
   * models and the rerank probe for rerankers, bounded by the model's own
   * response deadline. Never throws for provider outcomes.
   */
  async function checkActiveModel(value: Omit<CapabilityCheckRequest, "signal"> & { signal?: AbortSignal }): Promise<CapabilityCheckOutcome> {
    const candidate = await input.repository.loadActiveRefreshCandidate(value);
    if (!candidate) return "skipped";
    const connection = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
    const model = normalizeProviderModelConfiguration(candidate.model.configuration);
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort("capability_check_deadline"),
      model.modelClass === "answer" ? Math.min(INITIAL_CAPABILITY_BATCH_TIMEOUT_MS,
        Math.min(120_000, effectiveProviderResponseTimeoutMs(connection, model)) * 8 + 5_000)
        : effectiveProviderResponseTimeoutMs(connection, model)
    );
    const forward = () => controller.abort(value.signal?.reason);
    if (value.signal?.aborted) forward();
    else value.signal?.addEventListener("abort", forward, { once: true });
    try {
      const result = await executeActiveCheck({
        candidate,
        initialSetup: value.initialSetup,
        onCapabilityProgress: value.onCapabilityProgress,
        onSavedCheckpoint: (check) => value.onResult?.({ providerModelId: value.providerModelId,
          state: "partial", checks: check.evidence?.capabilitySetup?.checks, attempts: check.evidence?.capabilitySetup?.attempts }),
        mode: "tiny_generation",
        signal: controller.signal
      });
      if (result.kind === "stored") {
        const complete = Boolean(result.check.evidence && settledUnsupportedImageCapabilities(result.check.evidence)) ||
          result.check.status === "available" && (!result.check.evidence?.capabilitySetup || !capabilitySetupIncomplete(result.check.evidence));
        value.onResult?.({ providerModelId: value.providerModelId,
          state: result.check.status !== "available" ? "unavailable" : complete ? "saved" : "partial",
          checks: result.check.evidence?.capabilitySetup?.checks, attempts: result.check.evidence?.capabilitySetup?.attempts });
        return complete ? "stored" : "failed";
      }
      value.onResult?.({ providerModelId: value.providerModelId,
        state: result.kind === "failed" ? "check_failed" : result.kind === "save_failed" ? "save_failed"
          : result.kind === "cancelled" ? "cancelled" : "stale",
        ...(result.check?.evidence?.capabilitySetup ? { checks: result.check.evidence.capabilitySetup.checks,
          attempts: result.check.evidence.capabilitySetup.attempts } : {}) });
      if (result.kind === "stale") return "skipped";
      return result.kind === "save_failed" ? "failed" : result.kind;
    } finally {
      clearTimeout(deadline);
      value.signal?.removeEventListener("abort", forward);
    }
  }

  function usableCredential(
    connection: AdminProviderConnection,
    credentialId: string
  ): AdminProviderConnection["credentials"][number] | null {
    const credential = connection.credentials.find(({ id }) => id === credentialId);
    return credential && credential.enabled && credential.activeVersion &&
      credential.activeVersion.revokedAt === null
      ? credential
      : null;
  }

  function checkableModelIds(
    connection: AdminProviderConnection,
    requested: readonly string[] | undefined
  ): string[] {
    const wanted = requested ? new Set(requested) : null;
    return connection.models
      .filter((model) =>
        model.enabled && model.activeConfig !== null && model.activeVersion >= 1 &&
        (!wanted || wanted.has(model.id)))
      .map(({ id }) => id);
  }

  async function startCheckRun(value: {
    /** Internal setup continuation; explicit rechecks always probe again. */
    reuseCurrentChecks?: boolean;
    retryUnresolved?: boolean;
    initialModelIds?: readonly string[];
    onProgress?(value: AdminProviderCheckRun): void;
    signal?: AbortSignal;
    userId?: string;
    connectionId: string;
    credentialId: string;
    modelIds?: readonly string[];
    reason: AdminProviderCheckRunReason;
  }): Promise<AdminProviderCheckRun> {
    value.signal?.throwIfAborted();
    let connection = (await input.repository.listConnections())
      .find(({ id }) => id === value.connectionId);
    if (!connection) throw new AdminProviderServiceError("provider_connection_not_found");
    const credential = usableCredential(connection, value.credentialId);
    if (!credential) {
      throw new AdminProviderServiceError("provider_credential_not_found");
    }
    if (connection.activeVersion === 0 && value.reason === "requested") {
      // Recover only the unchanged first-setup endpoint. A changed draft
      // needs a fresh explicit key through Test & Save before external I/O.
      const initialPolicy = ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(connection.family as AdminProviderQuickSetupProviderId)
        ? adminProviderQuickSetupPolicy(connection.family as AdminProviderQuickSetupProviderId) : null;
      if (connection.draftVersion !== 1 || !initialPolicy ||
        connection.draftConfig.apiRoot !== initialPolicy.connection.configuration.apiRoot) {
        throw new AdminProviderServiceError("provider_endpoint_keys_required");
      }
      const secret = await activeCredentialSecret(credential.id, credential.activeVersion!.id);
      await activateCredentialSecret({
        connectionId: connection.id,
        credential: { credentialId: credential.id, expectedDraftVersion: credential.draftVersion, kind: "rotate" },
        secret,
        startChecks: false
      });
      connection = (await input.repository.listConnections()).find(({ id }) => id === value.connectionId);
      if (!connection) throw new AdminProviderServiceError("provider_connection_not_found");
    }
    const running = checkRuns.running(connection.id, value.credentialId);
    if (running) return running;
    if ((value.reason === "requested" || value.reason === "setup") && !value.modelIds && connection.enabled &&
      connection.activeConfig && connection.defaultCredentialId === credential.id) {
      const missing = providerSetupModels(connection.family, (connection.activeConfig ?? connection.draftConfig).apiRoot).filter((candidate) =>
        !connection!.models.some((model) => [model.draftConfig, model.activeConfig].some((config) =>
          config?.upstreamModelId === candidate.configuration.upstreamModelId)));
      if (missing.length) {
        const outcome = await testCredentialCatalog({
          connection: connection.activeConfig, family: connection.family,
          modelClasses: [...new Set(missing.map((model) => model.configuration.modelClass))],
          secret: () => activeCredentialSecret(credential.id, credential.activeVersion!.id),
          signal: value.signal
        });
        const policy = ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.includes(connection.family as AdminProviderQuickSetupProviderId)
          ? adminProviderQuickSetupPolicy(connection.family as AdminProviderQuickSetupProviderId) : null;
        const additions = missing.filter((candidate) =>
          (outcome.modelIdsByClass?.[candidate.configuration.modelClass] ?? outcome.modelIds)
            .includes(candidate.configuration.upstreamModelId)).map((candidate) => ({
          configuration: initialModelConfiguration(candidate.configuration.modelClass === "image" ? { ...candidate.configuration,
            image: outcome.imageModels?.find((entry) => entry.id === candidate.configuration.upstreamModelId)?.image ?? candidate.configuration.image } : candidate.configuration), displayName: candidate.displayName,
          id: connection!.id === policy?.connection.id ? candidate.modelId : idFactory(),
          inputTokenPriceMicros: candidate.inputTokenPriceMicros, outputTokenPriceMicros: candidate.outputTokenPriceMicros,
          templateKey: connection!.id === policy?.connection.id ? candidate.templateKey : null
        }));
        if (additions.length && await input.repository.addSetupModelsCas({
          connectionId: connection.id, connectionVersion: connection.activeVersion,
          credentialId: credential.id, credentialVersionId: credential.activeVersion!.id, models: additions, now: now()
        }) !== "updated") throw new AdminProviderServiceError("provider_draft_stale");
        connection = (await input.repository.listConnections()).find(({ id }) => id === value.connectionId);
        if (!connection) throw new AdminProviderServiceError("provider_connection_not_found");
      }
    }
    const modelIds = checkableModelIds(connection, value.modelIds);
    const initialSetup: Record<string, InitialCapabilityCheck> = {};
    for (const id of modelIds) {
      const model = connection.models.find((candidate) => candidate.id === id)!;
      const current = connection.activeChecks.find((check) => check.providerModelId === id &&
        check.connectionVersion === connection!.activeVersion && check.modelVersion === model.activeVersion &&
        check.credentialId === credential.id && check.credentialVersionId === credential.activeVersion!.id);
      // A changed key/endpoint invalidates all reusable proof, but does not
      // turn an unfinished initial model into an administrator override.
      // Model revisions still fence the initial activation authority.
      const currentSetup = decodeCapabilitySetupEvidence(current?.evidence?.capabilitySetup);
      const initialMarker = currentSetup ? currentSetup.activation !== "preserve" : value.retryUnresolved &&
        connection.activeChecks.some((check) => check.providerModelId === id && check.modelVersion === model.activeVersion &&
          Boolean(decodeCapabilitySetupEvidence(check.evidence?.capabilitySetup)) &&
          decodeCapabilitySetupEvidence(check.evidence?.capabilitySetup)?.activation !== "preserve");
      const activateCapabilities = Boolean(value.initialModelIds?.includes(id) || initialMarker &&
        model.draftVersion === model.activeVersion && (value.reason === "setup" || value.retryUnresolved));
      if (activateCapabilities || value.retryUnresolved || value.reuseCurrentChecks) {
        initialSetup[id] = { activateCapabilities, connectionVersion: connection.activeVersion,
          credentialVersionId: credential.activeVersion!.id, modelVersion: model.activeVersion,
          ...(value.reuseCurrentChecks || value.retryUnresolved ? {
            reuseEvidence: reusableCapabilitySetupEvidence(current?.evidence ?? undefined,
              normalizeProviderModelConfiguration(model.activeConfig))
          } : {}) };
      }
    }
    const completedModelIds = (value.reason === "setup" && value.reuseCurrentChecks || value.retryUnresolved)
      ? modelIds.filter((id) => {
          const model = connection!.models.find((candidate) => candidate.id === id)!;
          return connection!.activeChecks.some((check) =>
            check.providerModelId === id && check.connectionVersion === connection!.activeVersion &&
            check.modelVersion === model.activeVersion && check.credentialId === credential.id &&
            check.credentialVersionId === credential.activeVersion!.id &&
            check.latestRefreshError === null && Boolean(check.evidence) &&
            ["tiny_generation", "openrouter_account_catalog"].includes(check.evidence?.method ?? "") &&
            (check.status === "available" && check.evidence?.detail === "ok" && check.evidence.compatibility?.modelAccess === "verified" ||
              check.evidence && settledUnsupportedImageCapabilities(check.evidence)) &&
            ((model.modelClass ?? model.activeConfig?.modelClass ?? "answer") !== "answer" && !check.evidence!.capabilitySetup ||
              !capabilitySetupIncomplete(reusableCapabilitySetupEvidence(check.evidence!,
                normalizeProviderModelConfiguration(model.activeConfig)) ?? check.evidence!)));
        })
      : [];
    const run = checkRuns.start({
      signal: value.signal,
      initialSetup,
      onProgress: value.onProgress,
      completedModelIds,
      ...(value.userId && input.completeSetup ? {
        completeSetup: (signal: AbortSignal) => input.completeSetup!({
          connectionId: value.connectionId, credentialId: value.credentialId, userId: value.userId!, signal
        })
      } : {}),
      connectionId: connection.id,
      credentialId: value.credentialId,
      modelIds,
      reason: value.reason
    });
    return checkRuns.get(run.id)!;
  }

  /** Return once progress exists; the probes continue in the background. */
  async function startBackgroundChecks(value: {
    userId?: string;
    connectionId: string;
    credentialId: string;
    reason: AdminProviderCheckRunReason;
  }): Promise<void> {
    await startCheckRun(value).catch(() => undefined);
  }

  async function finishInitialSetup(value: { connectionId: string; credentialId: string; userId?: string;
    modelIds?: readonly string[]; signal?: AbortSignal; onProgress?(value: AdminProviderSetupProgress): void }): Promise<AdminProviderCheckRun> {
    const timeout = withTimeoutSignal(value.signal, INITIAL_CAPABILITY_BATCH_TIMEOUT_MS);
    let runId: string | undefined;
    const cancel = () => { if (runId) checkRuns.cancel(runId); };
    timeout.signal.addEventListener("abort", cancel, { once: true });
    try {
      const run = await startCheckRun({ ...value, reason: "setup", reuseCurrentChecks: true,
        signal: timeout.signal,
        onProgress: (current) => value.onProgress?.({ phase: "checking", completed: current.done,
          total: current.total || null, connectionId: value.connectionId, credentialId: value.credentialId,
          runId: current.id, ...(current.capabilityProgress ? { capability: current.capabilityProgress.capability } : {}) }) });
      runId = run.id;
      if (timeout.signal.aborted) cancel();
      await checkRuns.settled(run.id);
      return checkRuns.get(run.id)!;
    } finally {
      timeout.signal.removeEventListener("abort", cancel);
      timeout.clear();
    }
  }

  return {
    /** Test the complete settings change before publishing any of it. */
    async saveConnectionSettings(value: {
      configuration: AdminProviderConnectionConfiguration;
      connectionId: string;
      credentialSecrets: readonly { credentialId: string; secret: string }[];
      displayName: string;
      expectedDraftVersion: number;
      signal?: AbortSignal;
      unassignedPolicy: AdminProviderUnassignedPolicy;
    }) {
      const connection = (await input.repository.listConnections()).find(({ id }) => id === value.connectionId);
      if (!connection) throw new AdminProviderServiceError("provider_connection_not_found");
      if (connection.draftVersion !== value.expectedDraftVersion) throw new AdminProviderServiceError("provider_draft_stale");
      const displayName = name(value.displayName);
      let configuration = normalizeAdminProviderConnectionConfiguration(value.configuration);
      const previous = normalizeAdminProviderConnectionConfiguration(connection.activeConfig ?? connection.draftConfig);
      const endpointChanged = configuration.apiRoot !== previous.apiRoot;
      const keyless = configuration.authenticationMode === "none" && connection.family === "openai_compatible";
      // Authentication mode is owned by the setup flow; this form changes only its listed settings.
      if (configuration.authenticationMode !== previous.authenticationMode) {
        throw new AdminProviderServiceError("provider_family_adapter_mismatch");
      }
      const credentials = connection.credentials.filter((credential) =>
        credential.activeVersion !== null && credential.activeVersion.revokedAt === null);
      const secrets = new Map(value.credentialSecrets.map((entry) => [entry.credentialId, entry.secret]));
      if (secrets.size !== value.credentialSecrets.length || [...secrets.keys()].some((id) =>
        !credentials.some((credential) => credential.id === id)) ||
        keyless && secrets.size > 0 || !endpointChanged && secrets.size > 0 ||
        endpointChanged && !keyless && credentials.some((credential) => !secrets.get(credential.id)?.trim())) {
        throw new AdminProviderServiceError("provider_endpoint_keys_required");
      }
      const writes: ProviderConnectionSettingsWrite["credentials"][number][] = [];
      const catalogDetections: boolean[] = [];
      const modelClasses = [...new Set(connection.models.map((model) =>
        (model.activeConfig ?? model.draftConfig).modelClass))];
      for (const credential of credentials) {
        const replacementSecret = endpointChanged && !keyless ? secrets.get(credential.id)! : null;
        const secret: ProviderCredentialSource | null = keyless ? null : replacementSecret ??
          (() => activeCredentialSecret(credential.id, credential.activeVersion!.id));
        const outcome = await testCredentialCatalog({
          connection: configuration,
          family: connection.family,
          modelClasses: modelClasses.length ? modelClasses : ["answer"],
          secret,
          signal: value.signal
        });
        catalogDetections.push(outcome.responsesRequestIsolationDetected === true);
        const versionId = replacementSecret === null ? null : idFactory();
        writes.push({
          credentialId: credential.id,
          expectedDraftVersion: credential.draftVersion,
          expectedVersionId: credential.activeVersion!.id,
          modelChecks: catalogAccessChecks(connection, outcome),
          replacement: replacementSecret === null ? null : {
            envelope: encryptProviderCredentialSecret({
              credentialId: credential.id, key: encryptionKey(), secret: replacementSecret, valueId: versionId!
            }),
            versionId: versionId!
          },
          testEvidence: { method: outcome.method, modelCount: outcome.modelIds.length, version: 1 }
        });
      }
      if (connection.family === "openai_compatible" && configuration.responsesRequestIsolation !== undefined) {
        configuration = { ...configuration,
          responsesRequestIsolationDetected: catalogDetections.length > 0 && catalogDetections.every(Boolean) };
      }
      if (value.signal?.aborted) throw new AdminProviderServiceError("provider_credential_test_failed");
      const result = await input.repository.saveConnectionSettingsCas({
        configuration,
        connectionId: connection.id,
        credentials: writes,
        displayName,
        expectedActiveVersion: connection.activeVersion,
        expectedDraftVersion: value.expectedDraftVersion,
        now: now(),
        unassignedPolicy: value.unassignedPolicy
      });
      requireUpdated(result);
      if (connection.defaultCredentialId) {
        await startBackgroundChecks({ connectionId: connection.id, credentialId: connection.defaultCredentialId, reason: "requested" });
      }
    },

    listConnections: async () => (await input.repository.listConnections()).map((connection) => ({
      ...connection,
      checkRun: checkRuns.latest(connection.id)
    })),

    /** Progress of one background check; an id this process never saw reads as interrupted. */
    checkRun(value: { connectionId: string; runId: string }): AdminProviderCheckRun {
      const run = checkRuns.get(value.runId);
      return run && checkRuns.connectionOf(value.runId) === value.connectionId
        ? run
        : checkRuns.interrupted(value.runId);
    },

    startCheckRun,
    finishInitialSetup,

    cancelCheckRun(value: { connectionId: string; runId: string }): AdminProviderCheckRun {
      if (checkRuns.connectionOf(value.runId) !== value.connectionId) {
        throw new AdminProviderServiceError("provider_check_run_not_found");
      }
      checkRuns.cancel(value.runId);
      return checkRuns.get(value.runId)!;
    },

    /**
     * Model `Test & Save` (PRD B2): the model draft goes live through the
     * narrow CAS, then the default key checks it inline within the model's
     * deadline. A temporary check failure keeps the activation and shows up
     * as `Check failed` through the catalog's check-run projection.
     */
    async activateModel(value: {
      connectionId: string;
      modelId: string;
      expectedDraftVersion?: number;
      signal?: AbortSignal;
      onProgress?(value: AdminProviderSetupProgress): void;
      onActivated?(): void;
    }): Promise<{ check: "checked" | "failed" | "skipped" }> {
      const candidate = await input.repository.loadModelActivationCandidate(value);
      if (!candidate) throw new AdminProviderServiceError("provider_model_not_found");
      if (value.expectedDraftVersion !== undefined && candidate.model.draftVersion !== value.expectedDraftVersion) {
        throw new AdminProviderServiceError("provider_draft_stale");
      }
      let model = normalizeProviderModelConfiguration(candidate.model.configuration);
      const initial = candidate.model.activeVersion === 0;
      if (initial && model.modelClass === "answer") model = { ...model, capabilities: {
        ...model.capabilities, toolCalling: false, parallelToolCalls: false, vision: false,
        nativePdfInput: false, streaming: false
      } };
      validateFamily(candidate.connection.family, model);
      const result = await input.repository.activateModelCas({
        initialSetup: initial,
        signal: value.signal,
        connection: {
          activateDraft: candidate.connection.activeVersion === 0
            ? {
                configuration: normalizeProviderConnectionConfiguration(
                  candidate.connection.draftConfiguration
                ),
                draftVersion: candidate.connection.draftVersion
              }
            : null,
          id: candidate.connection.id
        },
        enable: true,
        model: {
          configuration: model,
          draftVersion: candidate.model.draftVersion,
          id: candidate.model.id
        },
        now: now()
      });
      if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result === "not_found") throw new AdminProviderServiceError("provider_model_not_found");
      value.onActivated?.();
      const credential = candidate.connection.defaultCredential;
      if (!credential?.usable) return { check: "skipped" };
      const run = await startCheckRun({
        signal: value.signal,
        ...(initial ? { initialModelIds: [candidate.model.id] } : {}),
        onProgress: (current) => value.onProgress?.({ phase: "checking", completed: current.done,
          total: current.total || null, connectionId: candidate.connection.id, credentialId: credential.id,
          runId: current.id, ...(current.capabilityProgress ? { capability: current.capabilityProgress.capability } : {}) }),
        connectionId: candidate.connection.id,
        credentialId: credential.id,
        modelIds: [candidate.model.id],
        reason: "model"
      });
      const cancel = () => checkRuns.cancel(run.id);
      value.signal?.addEventListener("abort", cancel, { once: true });
      if (value.signal?.aborted) cancel();
      value.onProgress?.({ phase: "checking", completed: 0, total: 1,
        connectionId: candidate.connection.id, credentialId: credential.id, runId: run.id });
      try { await checkRuns.settled(run.id); }
      finally { value.signal?.removeEventListener("abort", cancel); }
      const failed = checkRuns.get(run.id)?.failed.includes(candidate.model.id) ?? false;
      return { check: failed || checkRuns.get(run.id)?.state === "cancelled" ? "failed" : "checked" };
    },

    activateNewCredential: (value: {
      userId?: string;
      connectionId: string;
      label: string;
      secret: string;
      signal?: AbortSignal;
    }) => activateCredentialSecret({
      userId: value.userId,
      connectionId: value.connectionId,
      credential: { kind: "new", label: value.label },
      secret: value.secret,
      signal: value.signal
    }),

    activateRotatedCredential: (value: {
      userId?: string;
      connectionId: string;
      credentialId: string;
      expectedDraftVersion: number;
      secret: string;
      signal?: AbortSignal;
    }) => activateCredentialSecret({
      userId: value.userId,
      connectionId: value.connectionId,
      credential: {
        credentialId: value.credentialId,
        expectedDraftVersion: value.expectedDraftVersion,
        kind: "rotate"
      },
      secret: value.secret,
      signal: value.signal
    }),

    async discoverOpenRouterModels(value: {
      connectionId: string;
      credentialId: string;
      signal?: AbortSignal;
    }) {
      const client = await discoveryClient(value);
      try {
        return await client.listModels({ signal: value.signal });
      } catch {
        throw new AdminProviderServiceError("provider_discovery_failed");
      }
    },

    async discoverImageModels(value: { connectionId: string; credentialId: string; modelId?: string; signal?: AbortSignal }) {
      const candidate = await input.repository.loadDiscoveryCandidate(value);
      if (!candidate) throw new AdminProviderServiceError("provider_credential_not_found");
      if (!["openai", "openai_compatible", "gemini", "openrouter"].includes(candidate.connection.family)) {
        throw new AdminProviderServiceError("provider_discovery_unsupported");
      }
      const configuration = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
      if ((configuration.authenticationMode === "none") !== (candidate.credential.source === null)) {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
      const client = createImageModelDiscovery({ connection: configuration, family: candidate.connection.family,
        secret: candidate.credential.source ? credentialSecretSource(candidate.credential.id, candidate.credential.source) : null });
      try {
        return value.modelId ? { endpoints: await client.endpoints(value.modelId, value.signal) } : { models: await client.models(value.signal) };
      } catch { throw new AdminProviderServiceError("provider_discovery_failed"); }
    },

    async discoverCompatibleModels(value: {
      connectionId: string;
      credentialId: string;
      signal?: AbortSignal;
    }) {
      const candidate = await input.repository.loadDiscoveryCandidate(value);
      if (!candidate) {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
      if (candidate.connection.family !== "openai_compatible") {
        throw new AdminProviderServiceError("provider_discovery_unsupported");
      }
      const configuration = normalizeProviderConnectionConfiguration(
        candidate.connection.configuration
      );
      const authenticationMode = configuration.authenticationMode;
      if ((authenticationMode === "none") !== (candidate.credential.source === null)) {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
      try {
        const outcome = await testCredentialCatalog({
          connection: configuration,
          family: "openai_compatible",
          secret: candidate.credential.source === null
            ? null
            : credentialSecretSource(
                candidate.credential.id,
                candidate.credential.source
              ),
          signal: value.signal
        });
        return outcome.models ?? outcome.modelIds.map((id) => ({ capabilities: {}, id }));
      } catch {
        throw new AdminProviderServiceError("provider_discovery_failed");
      }
    },

    async discoverOpenRouterEndpoints(value: {
      connectionId: string;
      credentialId: string;
      modelId: string;
      signal?: AbortSignal;
    }) {
      const client = await discoveryClient(value);
      try {
        return await client.listModelEndpoints(value.modelId, { signal: value.signal });
      } catch {
        throw new AdminProviderServiceError("provider_discovery_failed");
      }
    },

    async refreshActive(value: {
      capabilityRole?: SystemModelVerificationRole;
      confirmPaidRequest?: boolean;
      connectionId: string;
      credentialId: string;
      providerModelId: string;
      signal?: AbortSignal;
    }) {
      const candidate = await input.repository.loadActiveRefreshCandidate(value);
      if (!candidate) {
        throw new AdminProviderServiceError("provider_active_tuple_not_found");
      }
      validateFamily(
        candidate.connection.family,
        normalizeProviderModelConfiguration(candidate.model.configuration)
      );
      const mode: AdminProviderDraftTestMode = !value.capabilityRole && candidate.connection.family === "openrouter"
        ? "account_catalog"
        : "tiny_generation";
      if (value.confirmPaidRequest !== true) {
        throw new AdminProviderServiceError("provider_paid_test_confirmation_required");
      }
      const result = await executeActiveCheck({
        candidate,
        capabilityRole: value.capabilityRole,
        mode,
        signal: value.signal
      });
      if (result.kind === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result.kind !== "stored") throw new AdminProviderServiceError("provider_refresh_failed");
      return result.check;
    },

    async createConnectionDraft(value: {
      configuration: AdminProviderConnectionConfiguration;
      displayName: string;
      family: AdminProviderFamily;
      unassignedPolicy?: AdminProviderUnassignedPolicy;
    }) {
      const id = idFactory();
      await input.repository.createConnection({
        configuration: normalizeAdminProviderConnectionConfiguration(value.configuration),
        displayName: name(value.displayName),
        family: value.family,
        id,
        unassignedPolicy: value.unassignedPolicy ?? "use_default"
      });
      return { id };
    },

    async createModelDraft(value: {
      configuration: AdminProviderModelConfiguration;
      connectionId: string;
      displayName: string;
    }) {
      const configuration = normalizeAdminProviderModelConfiguration(value.configuration);
      const id = idFactory();
      const displayName = name(value.displayName);
      const result = await input.repository.createModel({
        configuration,
        connectionId: value.connectionId,
        displayName,
        family: expectedFamily(configuration),
        id
      });
      if (result === "connection_not_found") {
        throw new AdminProviderServiceError("provider_connection_not_found");
      }
      if (result === "family_mismatch") {
        throw new AdminProviderServiceError("provider_family_adapter_mismatch");
      }
      return { id, displayName, draftVersion: 1 };
    },

    async renameModel(value: AdminProviderModelRename & { connectionId: string; modelId: string }) {
      const displayName = name(value.displayName);
      const result = await input.repository.renameModelCas({
        ...value,
        displayName,
        expectedUpdatedAt: new Date(value.expectedUpdatedAt),
        now: now()
      });
      if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result === "not_found") throw new AdminProviderServiceError("provider_model_not_found");
      return { displayName, draftVersion: value.expectedDraftVersion };
    },

    async updateModelDraft(value: AdminProviderModelEditGuard & {
      configuration: AdminProviderModelConfiguration;
      displayName: string;
      modelId: string;
    }) {
      const configuration = normalizeAdminProviderModelConfiguration(value.configuration);
      const displayName = name(value.displayName);
      const result = await input.repository.updateModelDraft({
        configuration,
        displayName,
        expectedActiveVersion: value.expectedActiveVersion,
        expectedDisplayName: value.expectedDisplayName,
        expectedDraftVersion: value.expectedDraftVersion,
        expectedUpdatedAt: new Date(value.expectedUpdatedAt),
        family: expectedFamily(configuration),
        modelId: value.modelId
      });
      if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result === "not_found") throw new AdminProviderServiceError("provider_model_not_found");
      if (result === "model_class_mismatch") {
        throw new AdminProviderServiceError("provider_model_class_immutable");
      }
      if (result === "family_mismatch") {
        throw new AdminProviderServiceError("provider_family_adapter_mismatch");
      }
      return { displayName, draftVersion: value.expectedDraftVersion + 1 };
    },

    async renameCredential(value: { credentialId: string; label: string }) {
      const result = await input.repository.renameCredential({
        credentialId: value.credentialId,
        label: name(value.label)
      });
      if (result === "not_found") {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
    },

    async activateConnection(value: {
      confirmUnavailable: boolean;
      connectionId: string;
      enableConnection: boolean;
      signal?: AbortSignal;
    }) {
      const candidate = await input.repository.loadActivationCandidate(value.connectionId);
      if (!candidate) {
        throw new AdminProviderServiceError("provider_connection_not_found");
      }
      if (candidate.models.length === 0 || candidate.credentials.length === 0) {
        throw new AdminProviderServiceError("provider_activation_empty");
      }
      let connection = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
      if (candidate.connection.activeConfiguration &&
        normalizeProviderConnectionConfiguration(candidate.connection.activeConfiguration).apiRoot !== connection.apiRoot) {
        // Only the atomic settings operation can collect replacements for every saved key.
        throw new AdminProviderServiceError("provider_endpoint_keys_required");
      }
      const models = candidate.models.map((model) => {
        const configuration = normalizeProviderModelConfiguration(model.configuration);
        validateFamily(candidate.connection.family, configuration);
        return { ...model, configuration };
      });
      const unusableCredentials = candidate.credentials
        .filter((credential) =>
          !credential.enabled ||
          (credential.draftSecretEnvelope === null && credential.activeVersion === null)
        )
        .map(({ id }) => id);
      if (unusableCredentials.length) {
        throw new AdminProviderServiceError(
          "provider_activation_evidence_missing",
          unusableCredentials
        );
      }

      const testedCredentials: Array<{
        checkedAt: Date;
        credential: ProviderActivationCandidate["credentials"][number];
        outcome: AdminProviderCredentialTestOutcome;
        secret: ProviderCredentialSource;
        source: ProviderCredentialSecretSource;
      }> = [];
      for (const credential of candidate.credentials) {
        const source: ProviderCredentialSecretSource = credential.draftSecretEnvelope !== null
          ? {
              draftVersion: credential.draftVersion,
              envelope: credential.draftSecretEnvelope,
              kind: "draft"
            }
          : {
              envelope: credential.activeVersion!.envelope,
              kind: "active",
              versionId: credential.activeVersion!.id
            };
        const secret = credentialSecretSource(credential.id, source);
        try {
          testedCredentials.push({
            checkedAt: now(),
            credential,
            outcome: await testCredentialCatalog({
              connection,
              family: candidate.connection.family,
              modelClasses: [...new Set(models.map(({ configuration }) =>
                configuration.modelClass))],
              secret,
              signal: value.signal
            }),
            secret,
            source
          });
        } catch {
          throw new AdminProviderServiceError("provider_credential_test_failed", [credential.id]);
        }
      }

      let isolationRefresh: ProviderActivationWrite["isolationRefresh"];
      if (candidate.connection.family === "openai_compatible" && connection.responsesRequestIsolation !== undefined) {
        if (!candidate.catalogCredentials || candidate.connection.activeVersion === undefined) {
          throw new AdminProviderServiceError("provider_draft_stale");
        }
        const catalogDetections = testedCredentials.map(({ outcome }) => outcome.responsesRequestIsolationDetected === true);
        const catalogCredentials: ProviderCatalogCredentialCheck[] = [];
        const checkedModels = { models: models.map((model) => ({
          activeConfig: adminProviderModelConfiguration(model.configuration), activeVersion: model.draftVersion, id: model.id
        })) };
        for (const current of candidate.catalogCredentials) {
          const referenced = testedCredentials.find(({ credential }) => credential.id === current.credentialId);
          const outcome = referenced?.outcome ?? await testCredentialCatalog({
            connection,
            family: candidate.connection.family,
            modelClasses: [...new Set(models.map(({ configuration }) => configuration.modelClass))],
            secret: () => activeCredentialSecret(current.credentialId, current.expectedVersionId),
            signal: value.signal
          });
          catalogDetections.push(outcome.responsesRequestIsolationDetected === true);
          catalogCredentials.push({ ...current, modelChecks: catalogAccessChecks(checkedModels, outcome) });
        }
        connection = { ...connection, responsesRequestIsolationDetected: catalogDetections.every(Boolean) };
        const configurationChanged = !candidate.connection.activeConfiguration || canonicalJson(connection) !==
          canonicalJson(normalizeProviderConnectionConfiguration(candidate.connection.activeConfiguration));
        isolationRefresh = {
          activeVersion: Math.max(candidate.connection.draftVersion,
            candidate.connection.activeVersion + (configurationChanged ? 1 : 0)),
          expectedActiveVersion: candidate.connection.activeVersion,
          credentials: catalogCredentials
        };
      }
      const credentials: ProviderActivationWrite["credentials"] = testedCredentials.map((tested) => {
        const { checkedAt, credential, outcome } = tested;
        const testEvidence = {
          method: outcome.method,
          modelCount: outcome.modelIds.length,
          version: 1
        };
        if (credential.draftSecretEnvelope !== null) {
          const versionId = idFactory();
          const secret = decryptProviderCredentialSecret({
            credentialId: credential.id,
            envelope: credential.draftSecretEnvelope,
            key: encryptionKey(),
            valueId: providerCredentialDraftValueId(credential.draftVersion)
          });
          return {
            checkedAt,
            draftVersion: credential.draftVersion,
            id: credential.id,
            kind: "draft" as const,
            testEvidence,
            versionEnvelope: encryptProviderCredentialSecret({
              credentialId: credential.id,
              key: encryptionKey(),
              secret,
              valueId: versionId
            }),
            versionId
          };
        }
        return {
          checkedAt,
          id: credential.id,
          kind: "active" as const,
          testEvidence,
          versionId: credential.activeVersion!.id
        };
      });

      const checks: StoredProviderDraftCheck[] = [];
      for (const model of models) {
        for (const { checkedAt, credential, outcome, secret, source } of testedCredentials) {
          const write = credentials.find(({ id }) => id === credential.id)!;
          const catalogAvailable = (
            outcome.modelIdsByClass?.[model.configuration.modelClass] ?? outcome.modelIds
          ).includes(model.configuration.upstreamModelId);
          const storedDirectRerankerAvailable = model.configuration.modelClass === "reranker" &&
            candidate.draftChecks.some((check) =>
              check.status === "available" &&
              check.connectionDraftVersion === candidate.connection.draftVersion &&
              check.providerModelId === model.id &&
              check.modelDraftVersion === model.draftVersion &&
              check.credentialId === credential.id &&
              check.credentialDraftVersion === (write.kind === "draft"
                ? write.draftVersion
                : null) &&
              check.credentialVersionId === (write.kind === "active"
                ? write.versionId
                : null) &&
              check.evidence.upstreamModelId === model.configuration.upstreamModelId &&
              (check.evidence.method === "tiny_generation" ||
                check.evidence.method === "openrouter_account_catalog")
            );
          let directOutcome: AdminProviderDraftTestOutcome | null = null;
          if (model.configuration.modelClass === "reranker") {
            try {
              directOutcome = await input.tester.test({
                connection,
                connectionDisplayName: candidate.connection.displayName,
                connectionId: candidate.connection.id,
                credentialId: credential.id,
                credentialVersionIdentity: secretValueId(source),
                mode: "tiny_generation",
                model: model.configuration,
                modelDisplayName: model.displayName,
                providerFamily: candidate.connection.family,
                providerModelId: model.id,
                secret,
                signal: value.signal
              });
            } catch {
              if (value.signal?.aborted) {
                throw new AdminProviderServiceError("provider_credential_test_failed");
              }
              directOutcome = null;
            }
          }
          const directRerankerAvailable = directOutcome
            ? directOutcome.status === "available"
            : storedDirectRerankerAvailable;
          const available = model.configuration.modelClass === "reranker"
            ? directRerankerAvailable
            : catalogAvailable;
          const credentialDraftVersion = write.kind === "draft" ? write.draftVersion : null;
          const credentialVersionId = write.kind === "active" ? write.versionId : null;
          checks.push({
            checkedAt,
            connectionDraftVersion: candidate.connection.draftVersion,
            credentialDraftVersion,
            credentialId: credential.id,
            credentialVersionId,
            evidence: directOutcome
              ? validateEvidence(directOutcome, "tiny_generation", model.configuration)
              : {
                  detail: available ? "ok" as const : "model_missing" as const,
                  method: storedDirectRerankerAvailable
                    ? "tiny_generation" as const
                    : "models_catalog" as const,
                  selectedProviders: model.configuration.openRouterRouting?.providers ?? [],
                  upstreamModelId: model.configuration.upstreamModelId
                },
            fingerprint: activationFingerprint({
              connectionId: candidate.connection.id,
              connectionVersion: candidate.connection.draftVersion,
              credentialDraftVersion,
              credentialId: credential.id,
              credentialVersionId,
              modelId: model.id,
              modelVersion: model.draftVersion
            }),
            modelDraftVersion: model.draftVersion,
            providerModelId: model.id,
            status: available ? "available" as const : "unavailable" as const
          });
        }
      }
      const unavailable = checks
        .filter(({ providerModelId, status }) =>
          status === "unavailable" &&
          !isApprovedRerankerProviderModelId(providerModelId))
        .map((check) => `${check.providerModelId}:${check.credentialId}`);
      if (unavailable.length && !value.confirmUnavailable) {
        throw new AdminProviderServiceError(
          "provider_activation_unavailable_confirmation_required",
          unavailable
        );
      }
      const result = await input.repository.activateConnectionCas({
        ...(isolationRefresh ? { isolationRefresh } : {}),
        checks,
        connection: {
          configuration: connection,
          draftVersion: candidate.connection.draftVersion,
          enable: value.enableConnection,
          id: candidate.connection.id
        },
        credentials,
        models,
        now: now()
      });
      if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result === "not_found") throw new AdminProviderServiceError("provider_connection_not_found");
      return {
        activatedCredentialCount: credentials.length,
        activatedModelCount: models.length,
        connectionVersion: isolationRefresh?.activeVersion ?? candidate.connection.draftVersion
      };
    },

    async assignGroupCredential(value: {
      connectionId: string;
      credentialId: string;
      groupId: string;
    }) {
      const result = await input.repository.assignGroupCredential(value);
      if (result === "credential_not_found") {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
      if (result === "group_not_found") {
        throw new AdminProviderServiceError("provider_group_not_found");
      }
    },

    revokeGroupCredential: (value: { connectionId: string; groupId: string }) =>
      input.repository.revokeGroupCredential(value),

    async setDefaultCredential(value: { connectionId: string; credentialId: string | null }) {
      const result = await input.repository.setDefaultCredential(value);
      if (result === "not_found") {
        throw new AdminProviderServiceError("provider_connection_not_found");
      }
      if (result === "credential_not_found") {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
    },

    disable: (target: ProviderDisableTarget, id: string) => input.repository.disable(target, id),
    enable: (target: ProviderDisableTarget, id: string) => input.repository.enable(target, id),

    async revokeCredentialVersion(value: {
      clearSecret: boolean;
      confirmed: boolean;
      credentialId: string;
      versionId: string;
    }) {
      if (!value.confirmed) {
        throw new AdminProviderServiceError("provider_revoke_confirmation_required");
      }
      const result = await input.repository.revokeCredentialVersion({
        clearSecret: value.clearSecret,
        credentialId: value.credentialId,
        now: now(),
        versionId: value.versionId
      });
      if (result === "not_found") {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
    },

    async deleteConnection(value: { confirmed: boolean; connectionId: string }): Promise<AdminProviderDeleteResult> {
      if (!value.confirmed) {
        throw new AdminProviderServiceError("provider_delete_confirmation_required");
      }
      return input.repository.deleteConnection(value.connectionId);
    },

    async deleteModel(value: { confirmed: boolean; modelId: string }): Promise<AdminProviderDeleteResult> {
      if (!value.confirmed) {
        throw new AdminProviderServiceError("provider_delete_confirmation_required");
      }
      return input.repository.deleteModel(value.modelId);
    },

    async deleteCredential(value: { confirmed: boolean; credentialId: string }): Promise<AdminProviderDeleteResult> {
      if (!value.confirmed) {
        throw new AdminProviderServiceError("provider_delete_confirmation_required");
      }
      return input.repository.deleteCredential(value.credentialId);
    }
  };
}
