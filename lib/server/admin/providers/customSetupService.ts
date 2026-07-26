import { randomUUID } from "node:crypto";
import {
  ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
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
  request: AdminProviderCustomSetupRequest
): ProviderModelConfiguration {
  return normalizeProviderModelConfiguration({
    adapterKind: "openai_chat_completions_compatible",
    capabilities: request.capabilities ?? ADMIN_PROVIDER_CUSTOM_DEFAULT_CAPABILITIES,
    defaultParams: request.defaultParams ?? {},
    upstreamModelId: request.modelId
  });
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
      const model = modelConfiguration(request);
      const connectionName = displayName(
        request.connectionDisplayName,
        defaultConnectionDisplayName(connection.apiRoot)
      );
      const modelName = displayName(
        request.modelDisplayName,
        model.upstreamModelId.slice(0, MAX_DISPLAY_NAME_LENGTH)
      );

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
      const providerModelId = idFactory();
      const credentialId = idFactory();
      const credentialVersionId = idFactory();
      const grantId = idFactory();

      let testOutcome: AdminProviderDraftTestOutcome;
      try {
        testOutcome = await input.tester.test({
          connection,
          connectionDisplayName: connectionName,
          connectionId,
          credentialId,
          credentialVersionIdentity: credentialVersionId,
          model,
          modelDisplayName: modelName,
          providerFamily: "openai_compatible",
          providerModelId,
          secret,
          signal: inputValue.signal
        });
      } catch {
        throw new AdminProviderCustomSetupServiceError(
          "provider_custom_setup_test_failed"
        );
      }
      const checkedAt = now();
      const evidence = validatedEvidence(testOutcome, model);
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
        evidence,
        grantId,
        model: {
          configuration: model,
          displayName: modelName,
          id: providerModelId
        },
        now: now()
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
        modelDisplayName: modelName,
        outcome: "ready",
        providerModelId
      };
    }
  };
}

export type AdminProviderCustomSetupService = ReturnType<
  typeof createAdminProviderCustomSetupService
>;
