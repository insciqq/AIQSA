import { hasVerifiedDedicatedProtocol } from "../../providers/systemRoleEvidence";
import type { SystemModelVerificationRole } from "../../../contracts/adminSystemModelPolicy";
import { createHash, randomUUID } from "node:crypto";
import type {
  AdminProviderConnectionConfiguration,
  AdminProviderCredentialTestResult,
  AdminProviderDeleteResult,
  AdminProviderDraftCheck,
  AdminProviderFamily,
  AdminProviderModelConfiguration,
  AdminProviderTestEvidence,
  AdminProviderUnassignedPolicy
} from "../../../contracts/adminProviders";
import {
  decryptProviderCredentialSecret,
  encryptProviderCredentialSecret
} from "../../providers/credentialSecrets";
import {
  normalizeAdminProviderConnectionConfiguration,
  normalizeAdminProviderModelConfiguration
} from "./adminConfiguration";
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
  ProviderCredentialSecretSource,
  ProviderDisableTarget,
  ProviderDraftMutationResult,
  ProviderDraftTestCandidate,
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
import { decodeVisionInputVerificationEvidence, hasVerifiedVisionInput } from "../../providers/visionInputEvidence";
import { decodeAdminProviderCompatibilityEvidence } from "./compatibilityEvidence";
import { isApprovedRerankerProviderModelId } from "./approvedRerankers";

const MAX_NAME_LENGTH = 160;

export type AdminProviderServiceErrorCode =
  | "provider_active_tuple_not_found"
  | "provider_activation_empty"
  | "provider_activation_evidence_missing"
  | "provider_activation_unavailable_confirmation_required"
  | "provider_connection_not_found"
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
    case "gemini_interactions_native":
      return "gemini";
    case "openai_chat_completions_compatible":
    case "openai_responses_compatible":
      return "openai_compatible";
    case "openai_responses_native":
      return "openai";
    case "openai_embeddings_compatible":
      throw new AdminProviderServiceError("provider_family_adapter_mismatch");
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

function fingerprint(candidate: ProviderDraftTestCandidate): string {
  const source = candidate.credential.source;
  return createHash("sha256").update(canonicalJson({
    connectionDraftVersion: candidate.connection.draftVersion,
    connectionId: candidate.connection.id,
    credentialDraftVersion: source.kind === "draft" ? source.draftVersion : null,
    credentialId: candidate.credential.id,
    credentialVersionId: source.kind === "active" ? source.versionId : null,
    modelDraftVersion: candidate.model.draftVersion,
    providerModelId: candidate.model.id,
    version: 1
  }), "utf8").digest("hex");
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
  const hasPdfInput = Object.prototype.hasOwnProperty.call(evidence, "pdfInput");
  const compatibility = decodeAdminProviderCompatibilityEvidence(evidence.compatibility);
  const hasCompatibility = Object.prototype.hasOwnProperty.call(evidence, "compatibility");
  if (
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
    (compatibility && (
      compatibility.modelAccess !== (outcome.status === "available"
        ? "verified"
        : "not_supported") ||
      (compatibility.directPdf === "verified") !== Boolean(pdfInput) ||
      (compatibility.vision === "verified") !== Boolean(visionInput) ||
      (compatibility.forcedToolCall === "verified") !== Boolean(forcedToolCall) ||
      (compatibility.structuredOutput === "verified") !== Boolean(structuredOutput) ||
      (outcome.status === "unavailable" && (
        compatibility.streaming === "verified" || compatibility.usage === "verified"
      )) ||
      (model.modelClass !== "answer" && (
        compatibility.directPdf === "verified" ||
        compatibility.forcedToolCall === "verified" ||
        compatibility.streaming === "verified" ||
        compatibility.structuredOutput === "verified"
      ))
    )) ||
    (Object.hasOwn(evidence, "visionInput") &&
      (!visionInput || !hasVerifiedVisionInput(evidence, model) || model.modelClass !== "answer")) ||
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

export function createAdminProviderService(input: Readonly<{
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

  return {
    listConnections: () => input.repository.listConnections(),

    async testCredential(value: {
      connectionId: string;
      expectedConnectionDraftVersion: number;
      secret: string;
      signal?: AbortSignal;
    }): Promise<AdminProviderCredentialTestResult> {
      const connection = (await input.repository.listConnections())
        .find(({ id }) => id === value.connectionId);
      if (!connection) {
        throw new AdminProviderServiceError("provider_connection_not_found");
      }
      if (connection.draftVersion !== value.expectedConnectionDraftVersion) {
        throw new AdminProviderServiceError("provider_draft_stale");
      }
      const outcome = await testCredentialCatalog({
        connection: connection.draftConfig,
        family: connection.family,
        secret: value.secret,
        signal: value.signal
      });
      return {
        checkedAt: now().toISOString(),
        connectionDraftVersion: connection.draftVersion,
        modelCount: outcome.modelIds.length,
        status: "valid"
      };
    },

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
      const connection = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
      const model = normalizeProviderModelConfiguration(candidate.model.configuration);
      validateFamily(candidate.connection.family, model);
      const mode: AdminProviderDraftTestMode = !value.capabilityRole && candidate.connection.family === "openrouter"
        ? "account_catalog"
        : "tiny_generation";
      if (value.confirmPaidRequest !== true) {
        throw new AdminProviderServiceError("provider_paid_test_confirmation_required");
      }
      const secret = credentialSecretSource(candidate.credential.id, {
        envelope: candidate.credential.envelope,
        kind: "active",
        versionId: candidate.credential.versionId
      }, "provider_active_tuple_not_found");
      let outcome: AdminProviderDraftTestOutcome;
      try {
        outcome = await input.tester.test({
          ...(value.capabilityRole ? { capabilityRole: value.capabilityRole } : {}),
          connection,
          connectionDisplayName: candidate.connection.displayName,
          connectionId: candidate.connection.id,
          credentialId: candidate.credential.id,
          credentialVersionIdentity: candidate.credential.versionId,
          mode,
          model,
          modelDisplayName: candidate.model.displayName,
          providerFamily: candidate.connection.family,
          providerModelId: candidate.model.id,
          secret,
          signal: value.signal
        });
      } catch {
        const failedAt = now();
        if (await input.repository.recordActiveRefreshFailureCas({ candidate, failedAt }) === "stale") {
          throw new AdminProviderServiceError("provider_draft_stale");
        }
        throw new AdminProviderServiceError("provider_refresh_failed");
      }
      const checkedAt = now();
      const check = {
        candidate,
        checkedAt,
        evidence: validateEvidence(outcome, mode, model),
        status: outcome.status
      };
      if (await input.repository.storeActiveRefreshCas({ ...check, capabilityRole: value.capabilityRole }) === "stale") {
        throw new AdminProviderServiceError("provider_draft_stale");
      }
      return {
        checkedAt: checkedAt.toISOString(),
        connectionVersion: candidate.connection.version,
        credentialId: candidate.credential.id,
        credentialVersionId: candidate.credential.versionId,
        evidence: check.evidence,
        latestRefreshError: null,
        modelVersion: candidate.model.version,
        providerModelId: candidate.model.id,
        refreshFailedAt: null,
        status: outcome.status
      };
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

    async updateConnectionDraft(value: {
      configuration: AdminProviderConnectionConfiguration;
      connectionId: string;
      displayName: string;
      expectedDraftVersion: number;
      unassignedPolicy: AdminProviderUnassignedPolicy;
    }) {
      const result = await input.repository.updateConnectionDraft({
        configuration: normalizeAdminProviderConnectionConfiguration(value.configuration),
        connectionId: value.connectionId,
        displayName: name(value.displayName),
        expectedDraftVersion: value.expectedDraftVersion,
        unassignedPolicy: value.unassignedPolicy
      });
      requireUpdated(result);
      return { draftVersion: value.expectedDraftVersion + 1 };
    },

    async createModelDraft(value: {
      configuration: AdminProviderModelConfiguration;
      connectionId: string;
      displayName: string;
    }) {
      const configuration = normalizeAdminProviderModelConfiguration(value.configuration);
      const id = idFactory();
      const result = await input.repository.createModel({
        configuration,
        connectionId: value.connectionId,
        displayName: name(value.displayName),
        family: expectedFamily(configuration),
        id
      });
      if (result === "connection_not_found") {
        throw new AdminProviderServiceError("provider_connection_not_found");
      }
      if (result === "family_mismatch") {
        throw new AdminProviderServiceError("provider_family_adapter_mismatch");
      }
      return { id };
    },

    async updateModelDraft(value: {
      configuration: AdminProviderModelConfiguration;
      displayName: string;
      expectedDraftVersion: number;
      modelId: string;
    }) {
      const configuration = normalizeAdminProviderModelConfiguration(value.configuration);
      const result = await input.repository.updateModelDraft({
        configuration,
        displayName: name(value.displayName),
        expectedDraftVersion: value.expectedDraftVersion,
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
      return { draftVersion: value.expectedDraftVersion + 1 };
    },

    async createCredentialDraft(value: {
      connectionId: string;
      label: string;
      secret: string;
    }) {
      const id = idFactory();
      const draftSecretEnvelope = encryptProviderCredentialSecret({
        credentialId: id,
        key: encryptionKey(),
        secret: value.secret,
        valueId: providerCredentialDraftValueId(1)
      });
      const result = await input.repository.createCredential({
        connectionId: value.connectionId,
        draftSecretEnvelope,
        id,
        label: name(value.label)
      });
      if (result === "connection_not_found") {
        throw new AdminProviderServiceError("provider_connection_not_found");
      }
      return { id };
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

    async rotateCredential(value: {
      credentialId: string;
      expectedDraftVersion: number;
      secret: string;
    }) {
      const nextVersion = value.expectedDraftVersion + 1;
      const result = await input.repository.updateCredentialDraft({
        credentialId: value.credentialId,
        draftSecretEnvelope: encryptProviderCredentialSecret({
          credentialId: value.credentialId,
          key: encryptionKey(),
          secret: value.secret,
          valueId: providerCredentialDraftValueId(nextVersion)
        }),
        expectedDraftVersion: value.expectedDraftVersion
      });
      if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result === "not_found") throw new AdminProviderServiceError("provider_credential_not_found");
      return { draftVersion: nextVersion };
    },

    async clearCredentialDraft(value: {
      confirmed: boolean;
      credentialId: string;
      expectedDraftVersion: number;
    }) {
      if (!value.confirmed) {
        throw new AdminProviderServiceError("provider_revoke_confirmation_required");
      }
      const result = await input.repository.updateCredentialDraft({
        credentialId: value.credentialId,
        draftSecretEnvelope: null,
        expectedDraftVersion: value.expectedDraftVersion
      });
      if (result === "stale") throw new AdminProviderServiceError("provider_draft_stale");
      if (result === "not_found") throw new AdminProviderServiceError("provider_credential_not_found");
      return { draftVersion: value.expectedDraftVersion + 1 };
    },

    async testDraft(value: {
      confirmPaidRequest?: boolean;
      connectionId: string;
      credentialId: string;
      mode: AdminProviderDraftTestMode;
      providerModelId: string;
      signal?: AbortSignal;
    }): Promise<AdminProviderDraftCheck> {
      if (value.confirmPaidRequest !== true) {
        throw new AdminProviderServiceError("provider_paid_test_confirmation_required");
      }
      const candidate = await input.repository.loadDraftTestCandidate(value);
      if (!candidate) {
        throw new AdminProviderServiceError("provider_credential_not_found");
      }
      const connection = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
      const model = normalizeProviderModelConfiguration(candidate.model.configuration);
      validateFamily(candidate.connection.family, model);
      if (value.mode === "account_catalog" && candidate.connection.family !== "openrouter") {
        throw new AdminProviderServiceError("provider_test_mode_invalid");
      }
      const source = candidate.credential.source;
      const secret = credentialSecretSource(candidate.credential.id, source);
      let outcome: AdminProviderDraftTestOutcome;
      try {
        outcome = await input.tester.test({
          connection,
          connectionDisplayName: candidate.connection.displayName,
          connectionId: candidate.connection.id,
          credentialId: candidate.credential.id,
          credentialVersionIdentity: secretValueId(source),
          mode: value.mode,
          model,
          modelDisplayName: candidate.model.displayName,
          providerFamily: candidate.connection.family,
          providerModelId: candidate.model.id,
          secret,
          signal: value.signal
        });
      } catch {
        throw new AdminProviderServiceError("provider_draft_test_failed");
      }
      const checkedAt = now();
      const check: StoredProviderDraftCheck = {
        checkedAt,
        connectionDraftVersion: candidate.connection.draftVersion,
        credentialDraftVersion: source.kind === "draft" ? source.draftVersion : null,
        credentialId: candidate.credential.id,
        credentialVersionId: source.kind === "active" ? source.versionId : null,
        evidence: validateEvidence(outcome, value.mode, model),
        fingerprint: fingerprint(candidate),
        modelDraftVersion: candidate.model.draftVersion,
        providerModelId: candidate.model.id,
        status: outcome.status
      };
      if (await input.repository.storeDraftCheckCas(candidate, check) === "stale") {
        throw new AdminProviderServiceError("provider_draft_stale");
      }
      return {
        ...check,
        checkedAt: check.checkedAt.toISOString()
      };
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
      const connection = normalizeProviderConnectionConfiguration(candidate.connection.configuration);
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
        connectionVersion: candidate.connection.draftVersion
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
