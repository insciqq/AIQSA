import { randomUUID } from "node:crypto";
import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
  MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS,
  type AdminProviderCustomSetupErrorCode,
  type AdminProviderCustomSetupReadyResult,
  type AdminProviderCustomSetupRequest
} from "../../../contracts/adminProviderCustomSetup";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { decodeStructuredOutputVerificationEvidence } from "../../providers/structuredOutputEvidence";
import { decodePdfInputVerificationEvidence } from "../../providers/pdfInputEvidence";
import {
  adminSearchExecutionDefaults,
  type AdminSearchDraft,
  type AdminSearchTestEvidence
} from "../../../contracts/adminSearch";
import {
  encryptProviderCredentialSecret,
  normalizeProviderCredentialSecret
} from "../../providers/credentialSecrets";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  providerResponseTimeoutMsFromSeconds,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import { searchDraftHash } from "../../search/configuration";
import type { AdminProviderQuickSetupSearchTester } from "./quickSetupSearchTester";
import type { AdminProviderDraftTestOutcome } from "./tester";
import type {
  AdminProviderCustomConnectionConfiguration,
  AdminProviderCustomSetupActor,
  AdminProviderCustomSetupRepository
} from "./customSetupRepositoryContract";

const MAX_DISPLAY_NAME_LENGTH = 160;

export class AdminProviderCustomSetupServiceError extends Error {
  readonly code: AdminProviderCustomSetupErrorCode;

  constructor(code: AdminProviderCustomSetupErrorCode) {
    super(code);
    this.code = code;
    this.name = "AdminProviderCustomSetupServiceError";
  }
}

export type AdminProviderCustomSetupTester = Readonly<{
  test(input: Readonly<{
    connection: AdminProviderCustomConnectionConfiguration;
    connectionDisplayName: string;
    connectionId: string;
    credentialId: string;
    credentialVersionIdentity: string;
    model: ProviderModelConfiguration;
    modelDisplayName: string;
    providerFamily: "openai_compatible";
    providerModelId: string;
    secret: string | null;
    signal?: AbortSignal;
  }>): Promise<AdminProviderDraftTestOutcome>;
}>;

function displayName(value: unknown, fallback: string): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (
    !candidate ||
    candidate.length > MAX_DISPLAY_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new Error("provider_custom_setup_name_invalid");
  }
  return candidate;
}

function defaultConnectionDisplayName(apiRoot: string): string {
  const hostname = new URL(apiRoot).hostname;
  const value = `Custom · ${hostname}`;
  return value.length <= MAX_DISPLAY_NAME_LENGTH
    ? value
    : value.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function searchDisplayName(connectionName: string): string {
  const suffix = " Search";
  return `${connectionName.slice(0, MAX_DISPLAY_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

function connectionConfiguration(
  request: AdminProviderCustomSetupRequest
): AdminProviderCustomConnectionConfiguration {
  const normalized = normalizeProviderConnectionConfiguration({
    allowPrivateNetwork: request.allowPrivateNetwork,
    apiRoot: request.apiRoot,
    authenticationMode: request.authenticationMode,
    responseTimeoutMs: providerResponseTimeoutMsFromSeconds(
      request.responseTimeoutSeconds
    )
  });
  if (request.authenticationMode === "none") {
    const url = new URL(normalized.apiRoot);
    if (!request.allowPrivateNetwork || url.protocol !== "http:") {
      throw new Error("provider_custom_setup_authentication_invalid");
    }
  }
  return {
    ...normalized,
    authenticationMode: request.authenticationMode
  };
}

function modelConfiguration(
  request: AdminProviderCustomSetupRequest,
  upstreamModelId: string
): ProviderModelConfiguration {
  const protocol = request.protocol;
  const configuration = normalizeProviderModelConfiguration({
    adapterKind: protocol === "responses"
      ? "openai_responses_compatible"
      : "openai_chat_completions_compatible",
    answerSelectable: true,
    capabilities: {
      ...(request.capabilities ?? ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES),
      // Local PDF extraction is an AIQSA capability, not an upstream claim.
      pdf: true
    },
    defaultParams: request.defaultParams ?? {},
    modelClass: "answer",
    ...(request.reasoningRequestMapping
      ? { reasoningRequestMapping: request.reasoningRequestMapping }
      : {}),
    upstreamModelId
  });
  if (
    ((configuration.capabilities.nativeSearch ||
      configuration.capabilities.nativeImageGeneration) && protocol !== "responses")
  ) {
    throw new Error("provider_custom_setup_protocol_invalid");
  }
  return configuration;
}

function requestedModelIds(request: AdminProviderCustomSetupRequest): string[] {
  const hasManualModel = request.modelId !== undefined;
  const hasDiscoveredModels = request.modelIds !== undefined;
  if (hasManualModel === hasDiscoveredModels) {
    throw new Error("provider_custom_setup_models_invalid");
  }
  const candidates = hasDiscoveredModels ? request.modelIds! : [request.modelId!];
  if (
    candidates.length < 1 ||
    candidates.length > MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS
  ) {
    throw new Error("provider_custom_setup_models_invalid");
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = typeof candidate === "string" ? candidate.trim() : "";
    if (
      !normalized ||
      normalized.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(normalized) ||
      seen.has(normalized)
    ) {
      throw new Error("provider_custom_setup_models_invalid");
    }
    seen.add(normalized);
    output.push(normalized);
  }
  if (output.length > 1 && request.modelDisplayName !== undefined) {
    throw new Error("provider_custom_setup_models_invalid");
  }
  return output;
}

function validatedEvidence(
  outcome: AdminProviderDraftTestOutcome,
  model: ProviderModelConfiguration
): AdminProviderTestEvidence {
  const structuredOutput = decodeStructuredOutputVerificationEvidence(
    outcome.evidence.structuredOutput
  );
  const pdfInput = decodePdfInputVerificationEvidence(outcome.evidence.pdfInput);
  const hasPdfInput = Object.prototype.hasOwnProperty.call(outcome.evidence, "pdfInput");
  if (
    outcome.status !== "available" ||
    outcome.evidence.detail !== "ok" ||
    outcome.evidence.method !== "tiny_generation" ||
    outcome.evidence.upstreamModelId !== model.upstreamModelId ||
    outcome.evidence.selectedProviders.length !== 0 ||
    (hasPdfInput && (!pdfInput || !model.capabilities.nativePdfInput ||
      pdfInput.adapterKind !== model.adapterKind ||
      pdfInput.upstreamModelId !== model.upstreamModelId)) ||
    (structuredOutput !== null && (
      structuredOutput.adapterKind !== model.adapterKind ||
      structuredOutput.upstreamModelId !== model.upstreamModelId
    ))
  ) {
    throw new AdminProviderCustomSetupServiceError(
      "provider_custom_setup_test_failed"
    );
  }
  return {
    detail: "ok",
    method: "tiny_generation",
    selectedProviders: [],
    ...(pdfInput ? { pdfInput } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
    upstreamModelId: model.upstreamModelId
  };
}

export function createAdminProviderCustomSetupService(input: Readonly<{
  encryptionKey?: () => Buffer;
  idFactory?: () => string;
  now?: () => Date;
  repository: AdminProviderCustomSetupRepository;
  searchTester?: AdminProviderQuickSetupSearchTester;
  tester: AdminProviderCustomSetupTester;
}>) {
  const encryptionKey = input.encryptionKey ?? getSecretEncryptionKey;
  const idFactory = input.idFactory ?? randomUUID;
  const now = input.now ?? (() => new Date());

  return {
    async setup(inputValue: Readonly<{
      actor: AdminProviderCustomSetupActor;
      request: AdminProviderCustomSetupRequest;
      signal?: AbortSignal;
    }>): Promise<AdminProviderCustomSetupReadyResult> {
      const request = inputValue.request;
      const connection = connectionConfiguration(request);
      const upstreamModelIds = requestedModelIds(request);
      const modelConfigurations = upstreamModelIds.map((upstreamModelId) =>
        modelConfiguration(request, upstreamModelId)
      );
      const connectionName = displayName(
        request.connectionDisplayName,
        defaultConnectionDisplayName(connection.apiRoot)
      );
      const modelNames = modelConfigurations.map((model, index) => displayName(
        index === 0 && modelConfigurations.length === 1
          ? request.modelDisplayName
          : undefined,
        model.upstreamModelId.slice(0, MAX_DISPLAY_NAME_LENGTH)
      ));

      let secret: string | null;
      if (request.authenticationMode === "bearer") {
        if (request.secret === undefined) {
          throw new Error("provider_credential_secret_invalid");
        }
        secret = normalizeProviderCredentialSecret(request.secret).trim();
      } else {
        if (request.secret !== undefined) {
          throw new Error("provider_custom_setup_authentication_invalid");
        }
        secret = null;
      }

      const connectionId = idFactory();
      const providerModelIds = modelConfigurations.map(() => idFactory());
      const credentialId = idFactory();
      const credentialVersionId = idFactory();
      const grantIds = modelConfigurations.map(() => idFactory());
      const primaryModel = modelConfigurations[0]!;
      const supportsSearch = primaryModel.adapterKind === "openai_responses_compatible" &&
        primaryModel.capabilities.nativeSearch;
      const searchGrantId = supportsSearch
        ? idFactory()
        : undefined;

      const evidence: AdminProviderTestEvidence[] = [];
      for (const [index, model] of modelConfigurations.entries()) {
        let testOutcome: AdminProviderDraftTestOutcome;
        try {
          testOutcome = await input.tester.test({
            connection,
            connectionDisplayName: connectionName,
            connectionId,
            credentialId,
            credentialVersionIdentity: credentialVersionId,
            model,
            modelDisplayName: modelNames[index]!,
            providerFamily: "openai_compatible",
            providerModelId: providerModelIds[index]!,
            secret,
            signal: inputValue.signal
          });
        } catch {
          throw new AdminProviderCustomSetupServiceError(
            "provider_custom_setup_test_failed"
          );
        }
        evidence.push(validatedEvidence(testOutcome, model));
      }

      const checkedAt = now();
      const searchEvidence: AdminSearchTestEvidence | null = supportsSearch
        ? {
            checkedAt: checkedAt.toISOString(),
            method: "configuration",
            normalizedSourceCount: 0,
            protocol: "openai_responses_web_search",
            status: "available"
          }
        : null;
      const searchName = supportsSearch ? searchDisplayName(connectionName) : null;
      const hostedSearchDraft: AdminSearchDraft | null = supportsSearch
        ? {
            adapterKind: "answer_provider_hosted",
            credentialMode: "answer_provider",
            maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
            maxResults: 8,
            maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
            protocol: "openai_responses_web_search",
            providerModelId: null,
            queryMaxCharacters: 500,
            reasoningPolicy: "provider_default",
            timeoutMs: 300_000
          }
        : null;
      const clientSearchDraft: AdminSearchDraft | null = supportsSearch
        ? {
            adapterKind: "provider_model_client",
            credentialMode: "provider_model",
            maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
            maxResults: 8,
            maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
            protocol: "openai_responses_web_search",
            providerModelId: providerModelIds[0]!,
            queryMaxCharacters: 500,
            reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
            timeoutMs: 300_000
          }
        : null;
      const commit = await input.repository.commit({
        actor: inputValue.actor,
        checkedAt,
        connection: {
          configuration: connection,
          displayName: connectionName,
          id: connectionId
        },
        credential: {
          id: credentialId,
          label: request.authenticationMode === "none"
            ? "No authentication"
            : "Personal API key",
          secretEnvelope: secret === null
            ? null
            : encryptProviderCredentialSecret({
                credentialId,
                key: encryptionKey(),
                secret,
                valueId: credentialVersionId
              }),
          versionId: credentialVersionId
        },
        models: modelConfigurations.map((model, index) => ({
          configuration: model,
          displayName: modelNames[index]!,
          evidence: evidence[index]!,
          grantId: grantIds[index]!,
          id: providerModelIds[index]!
        })),
        now: now(),
        ...(searchGrantId && searchEvidence && searchName && hostedSearchDraft && clientSearchDraft
          ? {
              search: {
                client: {
                  draft: clientSearchDraft,
                  draftHash: searchDraftHash(clientSearchDraft),
                  id: `custom-web-search-client:${connectionId}`,
                  revisionId: `custom-web-search-client-revision:${connectionId}`,
                  strategyId: `custom-web-search-client:${connectionId}`
                },
                description: `Web search provided by ${connectionName}.`.slice(0, 500),
                displayName: searchName,
                evidence: searchEvidence,
                grantId: searchGrantId,
                hosted: {
                  draft: hostedSearchDraft,
                  draftHash: searchDraftHash(hostedSearchDraft),
                  id: `custom-web-search-hosted:${connectionId}`,
                  revisionId: `custom-web-search-hosted-revision:${connectionId}`,
                  strategyId: `custom-web-search-hosted:${connectionId}`
                },
                optionId: `custom-web-search:${connectionId}`,
                optionRowId: `custom-web-search-option:${connectionId}`
              }
            }
          : {})
      });
      if (commit === "catalog_unavailable") {
        throw new AdminProviderCustomSetupServiceError(
          "provider_custom_setup_catalog_unavailable"
        );
      }
      if (commit === "forbidden" || commit === "stale") {
        throw new AdminProviderCustomSetupServiceError(
          "provider_custom_setup_stale"
        );
      }

      return {
        authenticationMode: request.authenticationMode,
        checkedAt: checkedAt.toISOString(),
        connectionDisplayName: connectionName,
        connectionId,
        defaultChanged: commit.defaultChanged,
        modelDisplayName: modelNames[0]!,
        models: providerModelIds.map((providerModelId, index) => ({
          modelDisplayName: modelNames[index]!,
          providerModelId
        })),
        outcome: "ready",
        providerModelId: providerModelIds[0]!,
        search: searchName
          ? {
              displayName: searchName,
              status: commit.search ?? "needs_attention"
            }
          : null
      };
    }
  };
}

export type AdminProviderCustomSetupService = ReturnType<
  typeof createAdminProviderCustomSetupService
>;
