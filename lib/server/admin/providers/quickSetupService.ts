import {
  createHmac,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS,
  type AdminProviderQuickSetupErrorCode,
  type AdminProviderQuickSetupReadyResult,
  type AdminProviderQuickSetupRequest,
  type AdminProviderQuickSetupResult,
  type AdminProviderQuickSetupSnapshot
} from "../../../contracts/adminProviderQuickSetup";
import {
  adminSearchExecutionDefaults,
  type AdminSearchDraft,
  type AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import {
  ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID,
  DEEPSEEK_PROVIDER_SEARCH_INTEGRATION_ID,
  GEMINI_PROVIDER_SEARCH_INTEGRATION_ID,
  OPENAI_PROVIDER_SEARCH_INTEGRATION_ID
} from "../../../domain/search";
import {
  encryptProviderCredentialSecret,
  normalizeProviderCredentialSecret
} from "../../providers/credentialSecrets";
import {
  normalizeProviderConnectionConfiguration,
  providerResponseTimeoutMsFromSeconds,
  type ProviderConnectionConfiguration
} from "../../providers/providerConfiguration";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type { AdminProviderCredentialTester } from "./credentialTester";
import {
  adminProviderQuickSetupPolicy,
  decideAdminProviderQuickSetupModel,
  type AdminProviderQuickSetupPolicyCandidate
} from "./quickSetupPolicy";
import {
  ADMIN_PROVIDER_SETUP_CREDENTIAL_LABEL,
  type AdminProviderQuickSetupActor,
  type AdminProviderQuickSetupCommitPlan,
  type AdminProviderQuickSetupInspection,
  type AdminProviderQuickSetupRepository
} from "./quickSetupRepositoryContract";
import type { AdminProviderQuickSetupSearchTester } from "./quickSetupSearchTester";
import { searchDraftHash } from "../../search/configuration";
import type { ProviderPdfInputProbe } from "../../providers/pdfInputProbe";
import type { AdminProviderDraftTester } from "./tester";
import { approvedRerankerDeployments } from "./approvedRerankers";

export class AdminProviderQuickSetupServiceError extends Error {
  readonly code: AdminProviderQuickSetupErrorCode;

  constructor(code: AdminProviderQuickSetupErrorCode) {
    super(code);
    this.code = code;
    this.name = "AdminProviderQuickSetupServiceError";
  }
}

const STATE_TOKEN_KEY_DERIVATION_DOMAIN =
  "aiqsa:provider-quick-setup-state-token-key:v1";

export function deriveAdminProviderQuickSetupStateTokenKey(
  sessionSecret: string
): Buffer {
  if (!sessionSecret) {
    throw new Error("provider_quick_setup_state_token_key_unavailable");
  }
  return createHmac("sha256", Buffer.from(sessionSecret, "utf8"))
    .update(STATE_TOKEN_KEY_DERIVATION_DOMAIN, "utf8")
    .digest();
}

function stateToken(key: Buffer, inspection: AdminProviderQuickSetupInspection): string {
  return createHmac("sha256", key)
    .update(`aiqsa:provider-quick-setup-state:v1:${inspection.fingerprint}`, "utf8")
    .digest("base64url");
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function providerSnapshot(
  inspection: AdminProviderQuickSetupInspection,
  key: Buffer
): AdminProviderQuickSetupSnapshot["providers"][number] {
  const policy = adminProviderQuickSetupPolicy(inspection.provider);
  return {
    candidateModels: policy.candidates.map(({ displayName }) => ({ displayName })),
    ...(inspection.state === "ready" && inspection.model
      ? { model: { displayName: inspection.model.displayName } }
      : {}),
    provider: inspection.provider,
    providerDisplayName: policy.connection.displayName,
    state: inspection.state,
    stateToken: stateToken(key, inspection)
  };
}

function replacementCandidate(
  inspection: AdminProviderQuickSetupInspection
): AdminProviderQuickSetupPolicyCandidate | null {
  if ((inspection.mode !== "replacement" && inspection.mode !== "recovery") ||
    !inspection.model) {
    return null;
  }
  return adminProviderQuickSetupPolicy(inspection.provider).candidates.find(
    (candidate) => candidate.templateKey === inspection.model?.templateKey
  ) ?? null;
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export type AdminProviderSetupCompletion = Readonly<{
  connectionId: string;
  credentialId: string;
}>;

export function createAdminProviderQuickSetupService(input: Readonly<{
  credentialTester: AdminProviderCredentialTester;
  encryptionKey?: () => Buffer;
  idFactory?: () => string;
  now?: () => Date;
  /** Runs after a committed setup (PRD B3 trigger); its failures never reach the caller. */
  onCompleted?(completion: AdminProviderSetupCompletion): void;
  pdfInputProbe: ProviderPdfInputProbe;
  rerankerTester?: AdminProviderDraftTester;
  searchTester?: AdminProviderQuickSetupSearchTester;
  repository: AdminProviderQuickSetupRepository;
  stateTokenKey: () => Buffer;
}>) {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;
  const idFactory = input.idFactory ?? randomUUID;
  const now = input.now ?? (() => new Date());
  const stateTokenKey = input.stateTokenKey;

  function testedSecret(raw: string): string {
    try {
      return normalizeProviderCredentialSecret(raw).trim();
    } catch {
      throw new AdminProviderQuickSetupServiceError("provider_credential_test_failed");
    }
  }

  async function catalogModelIds(value: Readonly<{
    connection: ProviderConnectionConfiguration;
    provider: AdminProviderQuickSetupRequest["provider"];
    secret: string;
    signal?: AbortSignal;
  }>): Promise<string[]> {
    try {
      const outcome = await input.credentialTester.test({
        connection: value.connection,
        family: value.provider,
        secret: value.secret,
        signal: value.signal
      });
      return outcome.modelIds;
    } catch {
      throw new AdminProviderQuickSetupServiceError("provider_credential_test_failed");
    }
  }

  /** Catalog evidence per candidate, with the direct-PDF probe where the model declares it. */
  async function modelEvidence(value: Readonly<{
    candidates: readonly AdminProviderQuickSetupPolicyCandidate[];
    connection: ProviderConnectionConfiguration;
    connectionDisplayName: string;
    connectionId: string;
    credentialId: string;
    credentialVersionId: string;
    modelIdOf(candidate: AdminProviderQuickSetupPolicyCandidate): string;
    provider: AdminProviderQuickSetupRequest["provider"];
    secret: string;
    signal?: AbortSignal;
  }>): Promise<Map<string, AdminProviderTestEvidence>> {
    const evidence = new Map<string, AdminProviderTestEvidence>();
    for (const candidate of value.candidates) {
      let pdfInput = null;
      if (candidate.configuration.capabilities.nativePdfInput) {
        try {
          pdfInput = await input.pdfInputProbe.probe({
            connection: value.connection,
            connectionDisplayName: value.connectionDisplayName,
            connectionId: value.connectionId,
            credentialId: value.credentialId,
            credentialVersionId: value.credentialVersionId,
            model: candidate.configuration,
            modelDisplayName: candidate.displayName,
            providerFamily: value.provider,
            providerModelId: value.modelIdOf(candidate),
            secret: value.secret,
            ...(value.signal ? { signal: value.signal } : {})
          });
        } catch {
          if (value.signal?.aborted) {
            throw new AdminProviderQuickSetupServiceError("provider_credential_test_failed");
          }
          // A failed capability probe must not turn a catalog-verified text
          // deployment into an unavailable model.
          pdfInput = null;
        }
      }
      evidence.set(candidate.candidateId, {
        detail: "ok",
        method: "models_catalog",
        ...(pdfInput ? { pdfInput } : {}),
        selectedProviders: candidate.configuration.openRouterRouting?.providers ?? [],
        upstreamModelId: candidate.configuration.upstreamModelId
      });
    }
    return evidence;
  }

  /** A separate connection of the family (PRD 5.3): fresh ids, no Search or reranker presets. */
  async function setupAdditional(inputValue: Readonly<{
    actor: AdminProviderQuickSetupActor;
    inspection: AdminProviderQuickSetupInspection;
    request: AdminProviderQuickSetupRequest;
    signal?: AbortSignal;
  }>): Promise<AdminProviderQuickSetupReadyResult> {
    const { inspection, request } = inputValue;
    const policy = adminProviderQuickSetupPolicy(request.provider);
    if (request.selectedModel) {
      throw new AdminProviderQuickSetupServiceError("provider_quick_setup_selection_invalid");
    }
    const displayName = request.connectionDisplayName?.trim() ?? "";
    if (!displayName || inspection.connectionNames.some((name) => sameName(name, displayName))) {
      throw new AdminProviderQuickSetupServiceError("provider_quick_setup_name_taken");
    }
    const connection: ProviderConnectionConfiguration = request.configuration
      ? normalizeProviderConnectionConfiguration({
          allowPrivateNetwork: request.configuration.allowPrivateNetwork,
          apiRoot: request.configuration.apiRoot,
          authenticationMode: "bearer",
          responseTimeoutMs: providerResponseTimeoutMsFromSeconds(
            request.configuration.responseTimeoutSeconds
          )
        })
      : policy.connection.configuration;
    const secret = testedSecret(request.secret);
    const modelIds = await catalogModelIds({
      connection,
      provider: policy.provider,
      secret,
      signal: inputValue.signal
    });
    const checkedAt = now();
    const remotelyAvailable = new Set(modelIds);
    const candidates = policy.candidates.filter((candidate) =>
      remotelyAvailable.has(candidate.configuration.upstreamModelId)
    );
    if (candidates.length === 0) {
      throw new AdminProviderQuickSetupServiceError("provider_quick_setup_unsupported_catalog");
    }
    const connectionId = idFactory();
    const credentialId = idFactory();
    const versionId = idFactory();
    const modelIdByCandidate = new Map(candidates.map((candidate) => [candidate.candidateId, idFactory()]));
    const evidence = await modelEvidence({
      candidates,
      connection,
      connectionDisplayName: displayName,
      connectionId,
      credentialId,
      credentialVersionId: versionId,
      modelIdOf: (candidate) => modelIdByCandidate.get(candidate.candidateId)!,
      provider: policy.provider,
      secret,
      signal: inputValue.signal
    });
    const commit = await input.repository.commitAdditional({
      actor: inputValue.actor,
      checkedAt,
      connection: { configuration: connection, displayName, id: connectionId },
      credential: {
        id: credentialId,
        label: ADMIN_PROVIDER_SETUP_CREDENTIAL_LABEL,
        versionEnvelope: encryptProviderCredentialSecret({
          credentialId,
          key: encryptionKey(),
          secret,
          valueId: versionId
        }),
        versionId
      },
      expectedFingerprint: inspection.fingerprint,
      models: candidates.map((candidate) => ({
        candidate,
        evidence: evidence.get(candidate.candidateId)!,
        grantId: idFactory(),
        id: modelIdByCandidate.get(candidate.candidateId)!
      })),
      now: now(),
      provider: policy.provider
    });
    if (commit === "stale") {
      throw new AdminProviderQuickSetupServiceError("provider_draft_stale");
    }
    if (commit === "advanced_required") {
      throw new AdminProviderQuickSetupServiceError("provider_quick_setup_advanced_required");
    }
    if (commit === "catalog_unavailable") {
      throw new AdminProviderQuickSetupServiceError("provider_quick_setup_unsupported_catalog");
    }
    try {
      input.onCompleted?.({ connectionId, credentialId });
    } catch {
      // Background checks are best effort; the setup itself is complete.
    }
    return {
      checkedAt: checkedAt.toISOString(),
      connectionId,
      defaultCredentialChanged: true,
      defaultChanged: false,
      model: { displayName: candidates[0]!.displayName },
      models: candidates.map(({ displayName: modelName }) => ({ displayName: modelName })),
      outcome: "ready",
      provider: policy.provider,
      providerDisplayName: policy.connection.displayName,
      search: null
    };
  }

  return {
    async getSnapshot(actor: AdminProviderQuickSetupActor): Promise<AdminProviderQuickSetupSnapshot> {
      const inspectedAt = now();
      const inspections = await Promise.all(ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS.map((provider) =>
        input.repository.inspect({ ...actor, now: inspectedAt, provider })
      ));
      const configuredConnections = inspections.every((inspection) => inspection.authorized)
        ? await input.repository.listConfiguredConnections({ ...actor, now: inspectedAt })
        : [];
      const key = stateTokenKey();
      const readyDefaults = inspections.filter(
        (inspection) => inspection.state === "ready" && inspection.actingUserDefault
      );
      const simpleConfigured = inspections.filter(
        (inspection) => inspection.configured && inspection.state !== "advanced_required"
      );
      const suggestedProvider = readyDefaults.length === 1
        ? readyDefaults[0].provider
        : simpleConfigured.length === 1
          ? simpleConfigured[0].provider
          : null;
      return {
        configuredConnections,
        providers: inspections.map((inspection) => providerSnapshot(inspection, key)),
        suggestedProvider
      };
    },

    async setup(inputValue: Readonly<{
      actor: AdminProviderQuickSetupActor;
      request: AdminProviderQuickSetupRequest;
      signal?: AbortSignal;
    }>): Promise<AdminProviderQuickSetupResult> {
      const policy = adminProviderQuickSetupPolicy(inputValue.request.provider);
      const inspectedAt = now();
      const inspection = await input.repository.inspect({
        ...inputValue.actor,
        now: inspectedAt,
        provider: inputValue.request.provider
      });
      if (!inspection.authorized) {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_advanced_required"
        );
      }
      const additional = inputValue.request.configuration !== undefined || (
        inputValue.request.connectionDisplayName !== undefined &&
        (inspection.canonicalConnection || inspection.mode === null)
      );
      if (!additional && (inspection.state === "advanced_required" || inspection.mode === null)) {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_advanced_required"
        );
      }
      if (!sameToken(inputValue.request.expectedState, stateToken(stateTokenKey(), inspection))) {
        throw new AdminProviderQuickSetupServiceError("provider_draft_stale");
      }
      if (additional) {
        return setupAdditional({
          actor: inputValue.actor,
          inspection,
          request: inputValue.request,
          signal: inputValue.signal
        });
      }
      // The canonical path was guarded above; this only narrows the type for the commit plan.
      const mode = inspection.mode;
      if (mode === null) {
        throw new AdminProviderQuickSetupServiceError("provider_quick_setup_advanced_required");
      }

      const existingCandidate = replacementCandidate(inspection);
      if (inspection.mode === "replacement" && !existingCandidate) {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_advanced_required"
        );
      }
      if (existingCandidate && inputValue.request.selectedModel) {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_selection_invalid"
        );
      }
      if (inputValue.request.selectedModel && (
        inputValue.request.selectedModel.policyVersion !== policy.version ||
        !policy.candidates.some(
          ({ candidateId }) => candidateId === inputValue.request.selectedModel?.candidateId
        )
      )) {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_selection_invalid"
        );
      }
      const connectionDisplayName = inputValue.request.connectionDisplayName?.trim();
      if (connectionDisplayName !== undefined && (!connectionDisplayName ||
        inspection.connectionNames.some((name) => sameName(name, connectionDisplayName)))) {
        throw new AdminProviderQuickSetupServiceError("provider_quick_setup_name_taken");
      }

      const secret = testedSecret(inputValue.request.secret);
      const modelIds = await catalogModelIds({
        connection: policy.connection.configuration,
        provider: policy.provider,
        secret,
        signal: inputValue.signal
      });
      const checkedAt = now();
      const remotelyAvailableModelIds = new Set(modelIds);
      const availableCandidates = policy.candidates.filter((candidate) =>
        remotelyAvailableModelIds.has(candidate.configuration.upstreamModelId)
      );
      if (inspection.preservedModels.some(
        ({ upstreamModelId }) => !remotelyAvailableModelIds.has(upstreamModelId)
      )) {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_unsupported_catalog"
        );
      }

      let candidate: AdminProviderQuickSetupPolicyCandidate;
      if (existingCandidate) {
        if (!modelIds.includes(existingCandidate.configuration.upstreamModelId)) {
          throw new AdminProviderQuickSetupServiceError(
            "provider_quick_setup_unsupported_catalog"
          );
        }
        candidate = existingCandidate;
      } else {
        const decision = decideAdminProviderQuickSetupModel({
          modelIds,
          policy,
          ...(inputValue.request.selectedModel
            ? { selectedModel: inputValue.request.selectedModel }
            : {})
        });
        if (decision.kind === "selection_invalid") {
          throw new AdminProviderQuickSetupServiceError(
            "provider_quick_setup_selection_invalid"
          );
        }
        if (decision.kind === "unsupported_catalog") {
          throw new AdminProviderQuickSetupServiceError(
            "provider_quick_setup_unsupported_catalog"
          );
        }
        if (decision.kind === "selection_required") {
          return {
            candidates: decision.candidates,
            checkedAt: checkedAt.toISOString(),
            expectedState: stateToken(stateTokenKey(), inspection),
            outcome: "selection_required",
            policyVersion: policy.version,
            provider: policy.provider,
            providerDisplayName: policy.connection.displayName
          };
        }
        candidate = decision.candidate;
      }

      const credentialId = inspection.quickSetupCredential?.id ?? idFactory();
      const draftVersion = inspection.quickSetupCredential
        ? inspection.quickSetupCredential.draftVersion + 1
        : 1;
      if (!Number.isSafeInteger(draftVersion) || draftVersion < 1) {
        throw new AdminProviderQuickSetupServiceError("provider_draft_stale");
      }
      const versionId = idFactory();
      const evidence = await modelEvidence({
        candidates: availableCandidates,
        connection: policy.connection.configuration,
        connectionDisplayName: policy.connection.displayName,
        connectionId: policy.connection.id,
        credentialId,
        credentialVersionId: versionId,
        modelIdOf: ({ modelId }) => modelId,
        provider: policy.provider,
        secret,
        signal: inputValue.signal
      });
      const modelChecks: Array<AdminProviderQuickSetupCommitPlan["modelChecks"][number]> =
        availableCandidates.map((availableCandidate) => ({
          evidence: evidence.get(availableCandidate.candidateId)!,
          modelId: availableCandidate.modelId
        }));
      const rerankerChecks: Array<
        AdminProviderQuickSetupCommitPlan["rerankerChecks"][number]
      > = [];
      if (policy.provider === "openrouter" && input.rerankerTester) {
        for (const deployment of approvedRerankerDeployments) {
          try {
            const outcome = await input.rerankerTester.test({
              connection: policy.connection.configuration,
              connectionDisplayName: policy.connection.displayName,
              connectionId: policy.connection.id,
              credentialId,
              credentialVersionIdentity: versionId,
              mode: "tiny_generation",
              model: deployment.configuration,
              modelDisplayName: deployment.displayName,
              providerFamily: policy.provider,
              providerModelId: deployment.providerModelId,
              secret,
              ...(inputValue.signal ? { signal: inputValue.signal } : {})
            });
            rerankerChecks.push({
              evidence: outcome.evidence,
              providerModelId: deployment.providerModelId,
              status: outcome.status
            });
          } catch {
            if (inputValue.signal?.aborted) {
              throw new AdminProviderQuickSetupServiceError(
                "provider_credential_test_failed"
              );
            }
            rerankerChecks.push({
              evidence: {
                detail: "model_missing",
                method: "tiny_generation",
                selectedProviders: [],
                upstreamModelId: deployment.configuration.upstreamModelId
              },
              providerModelId: deployment.providerModelId,
              status: "unavailable"
            });
          }
        }
      }
      let search: AdminProviderQuickSetupCommitPlan["search"];
      if ((policy.provider === "anthropic" || policy.provider === "deepseek" || policy.provider === "openai" ||
        policy.provider === "gemini") &&
        candidate.configuration.capabilities.nativeSearch) {
        const anthropic = policy.provider === "anthropic";
        const deepseek = policy.provider === "deepseek";
        const gemini = policy.provider === "gemini";
        const draft: AdminSearchDraft = {
          adapterKind: "provider_model_client",
          credentialMode: "provider_model",
          maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
          maxResults: 8,
          maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
          protocol: anthropic
            ? "anthropic_web_search"
            : deepseek
              ? "deepseek_responses_web_search"
            : gemini
              ? "gemini_google_search"
              : "openai_responses_web_search",
          providerModelId: candidate.modelId,
          queryMaxCharacters: 500,
          reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
          timeoutMs: 300_000
        };
        const searchEvidence: AdminSearchTestEvidence = {
          checkedAt: checkedAt.toISOString(),
          method: "configuration",
          normalizedSourceCount: 0,
          protocol: draft.protocol,
          status: "available"
        };
        search = {
          draft,
          draftHash: searchDraftHash(draft),
          evidence: searchEvidence,
          grantId: idFactory(),
          integrationId: anthropic
            ? ANTHROPIC_PROVIDER_SEARCH_INTEGRATION_ID
            : deepseek
              ? DEEPSEEK_PROVIDER_SEARCH_INTEGRATION_ID
            : gemini
              ? GEMINI_PROVIDER_SEARCH_INTEGRATION_ID
              : OPENAI_PROVIDER_SEARCH_INTEGRATION_ID,
          revisionId: idFactory()
        };
      }
      const commit = await input.repository.commit({
        actor: inputValue.actor,
        candidate,
        candidates: availableCandidates,
        checkedAt,
        ...(connectionDisplayName && !inspection.canonicalConnection
          ? { connectionDisplayName }
          : {}),
        credential: {
          draftVersion,
          id: credentialId,
          isNew: inspection.quickSetupCredential === null,
          versionEnvelope: encryptProviderCredentialSecret({
            credentialId,
            key: encryptionKey(),
            secret,
            valueId: versionId
          }),
          versionId
        },
        expectedFingerprint: inspection.fingerprint,
        grants: availableCandidates.map(({ modelId }) => ({
          id: idFactory(),
          modelId
        })),
        mode,
        modelChecks,
        now: now(),
        preservedModels: inspection.preservedModels,
        provider: policy.provider,
        rerankerChecks,
        ...(search ? { search } : {})
      });
      if (commit === "stale") {
        throw new AdminProviderQuickSetupServiceError("provider_draft_stale");
      }
      if (commit === "advanced_required") {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_advanced_required"
        );
      }
      if (commit === "catalog_unavailable") {
        throw new AdminProviderQuickSetupServiceError(
          "provider_quick_setup_unsupported_catalog"
        );
      }
      try {
        input.onCompleted?.({ connectionId: policy.connection.id, credentialId });
      } catch {
        // Background checks are best effort; the setup itself is complete.
      }
      return {
        checkedAt: checkedAt.toISOString(),
        connectionId: policy.connection.id,
        defaultCredentialChanged: commit.defaultCredentialChanged,
        defaultChanged: commit.defaultChanged,
        model: { displayName: candidate.displayName },
        models: availableCandidates.map(({ displayName }) => ({ displayName })),
        outcome: "ready",
        provider: policy.provider,
        providerDisplayName: policy.connection.displayName,
        search: commit.search
          ? {
              displayName: policy.provider === "anthropic"
                ? "Anthropic Search"
                : policy.provider === "deepseek"
                  ? "DeepSeek Search"
                : policy.provider === "gemini"
                  ? "Google Search"
                  : "OpenAI Search",
              status: commit.search
            }
          : null
      };
    }
  };
}

export type AdminProviderQuickSetupService = ReturnType<
  typeof createAdminProviderQuickSetupService
>;
