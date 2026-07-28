import { randomUUID } from "node:crypto";
import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
  MAX_ADMIN_PROVIDER_CUSTOM_SETUP_MODELS,
  type AdminProviderCustomSetupErrorCode,
  type AdminProviderCustomSetupReadyResult,
  type AdminProviderCustomSetupRequest
} from "../../../contracts/adminProviderCustomSetup";
import type { AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import {
  encryptProviderCredentialSecret,
  normalizeProviderCredentialSecret
} from "../../providers/credentialSecrets";
import {
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  type ProviderModelConfiguration
} from "../../providers/providerConfiguration";
import { getSecretEncryptionKey } from "../../secrets/envelope";
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

function connectionConfiguration(
  request: AdminProviderCustomSetupRequest
): AdminProviderCustomConnectionConfiguration {
  const normalized = normalizeProviderConnectionConfiguration({
    allowPrivateNetwork: request.allowPrivateNetwork,
    apiRoot: request.apiRoot,
    authenticationMode: request.authenticationMode
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
  const protocol = request.protocol ?? "chat_completions";
  const configuration = normalizeProviderModelConfiguration({
    adapterKind: protocol === "responses"
      ? "openai_responses_compatible"
      : "openai_chat_completions_compatible",
    capabilities: request.capabilities ?? ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
    defaultParams: request.defaultParams ?? {},
    upstreamModelId
  });
  if (
    (request.authenticationMode === "none" && protocol === "responses") ||
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
  if (
    outcome.status !== "available" ||
    outcome.evidence.detail !== "ok" ||
    outcome.evidence.method !== "tiny_generation" ||
    outcome.evidence.upstreamModelId !== model.upstreamModelId ||
    outcome.evidence.selectedProviders.length !== 0
  ) {
    throw new AdminProviderCustomSetupServiceError(
      "provider_custom_setup_test_failed"
    );
  }
  return {
    detail: "ok",
    method: "tiny_generation",
    selectedProviders: [],
    upstreamModelId: model.upstreamModelId
  };
}

export function createAdminProviderCustomSetupService(input: Readonly<{
  encryptionKey?: () => Buffer;
  idFactory?: () => string;
  now?: () => Date;
  repository: AdminProviderCustomSetupRepository;
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
      const searchGrantId = modelConfigurations[0]!.capabilities.nativeSearch
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
        ...(searchGrantId ? { searchGrantId } : {})
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
        providerModelId: providerModelIds[0]!
      };
    }
  };
}

export type AdminProviderCustomSetupService = ReturnType<
  typeof createAdminProviderCustomSetupService
>;
