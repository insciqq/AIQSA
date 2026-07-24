import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import {
  normalizeProviderConnectionConfiguration,
  type ProviderAdapterKind,
  type ProviderConnectionConfiguration
} from "../../lib/server/providers/providerConfiguration";
import {
  encryptProviderCredentialSecret,
  normalizeProviderCredentialSecret
} from "../../lib/server/providers/credentialSecrets";

const IMPORTED_CREDENTIAL_LABEL = "Imported legacy environment";

type LegacyProviderName = "anthropic" | "openai" | "openrouter";

export type LegacyProviderImportCandidate = Readonly<{
  adapterKind: ProviderAdapterKind;
  configuration: ProviderConnectionConfiguration;
  connectionId: string;
  family: "anthropic" | "openai" | "openai_compatible" | "openrouter";
  provider: LegacyProviderName;
  secret: string;
}>;

export type LegacyProviderImportResult = Readonly<{
  imported: LegacyProviderName[];
  skippedConfigured: LegacyProviderName[];
}>;

export class LegacyProviderImportError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "LegacyProviderImportError";
  }
}

function present(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function endpoint(
  value: string | null,
  fallback: string,
  provider: LegacyProviderName
): ProviderConnectionConfiguration {
  const candidate = value ?? fallback;
  let allowPrivateNetwork = false;
  try {
    allowPrivateNetwork = new URL(candidate).protocol === "http:";
    return normalizeProviderConnectionConfiguration({
      allowPrivateNetwork,
      apiRoot: candidate
    });
  } catch {
    throw new LegacyProviderImportError(`provider_env_invalid_${provider}_endpoint`);
  }
}

function candidate(input: {
  baseUrl: string | undefined;
  canonicalRoot: string;
  connectionId: string;
  key: string | undefined;
  provider: LegacyProviderName;
}): LegacyProviderImportCandidate | null {
  const key = present(input.key);
  const baseUrl = present(input.baseUrl);
  if (!key && !baseUrl) return null;
  if (!key) {
    throw new LegacyProviderImportError(`provider_env_partial_${input.provider}`);
  }

  let secret: string;
  try {
    secret = normalizeProviderCredentialSecret(key);
  } catch {
    throw new LegacyProviderImportError(`provider_env_invalid_${input.provider}_key`);
  }
  const configuration = endpoint(baseUrl, input.canonicalRoot, input.provider);
  const customOpenAi = input.provider === "openai" &&
    configuration.apiRoot !== input.canonicalRoot;

  return {
    adapterKind: input.provider === "openai"
      ? customOpenAi
        ? "openai_responses_compatible"
        : "openai_responses_native"
      : input.provider === "anthropic"
        ? "anthropic_messages"
        : "openrouter_chat_completions",
    configuration,
    connectionId: input.connectionId,
    family: customOpenAi ? "openai_compatible" : input.provider,
    provider: input.provider,
    secret
  };
}

export function parseLegacyProviderEnvironment(
  env: Record<string, string | undefined>
): LegacyProviderImportCandidate[] {
  return [
    candidate({
      baseUrl: env.OPENAI_BASE_URL,
      canonicalRoot: "https://api.openai.com/v1",
      connectionId: providerTemplateIds.openAiConnection,
      key: env.OPENAI_API_KEY,
      provider: "openai"
    }),
    candidate({
      baseUrl: env.ANTHROPIC_BASE_URL,
      canonicalRoot: "https://api.anthropic.com/v1",
      connectionId: providerTemplateIds.anthropicConnection,
      key: env.ANTHROPIC_API_KEY,
      provider: "anthropic"
    }),
    candidate({
      baseUrl: env.OPENROUTER_BASE_URL,
      canonicalRoot: "https://openrouter.ai/api/v1",
      connectionId: providerTemplateIds.openRouterConnection,
      key: env.OPENROUTER_API_KEY,
      provider: "openrouter"
    })
  ].filter((value): value is LegacyProviderImportCandidate => value !== null);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

export async function importLegacyProviderEnvironment(
  tx: Pick<
    Prisma.TransactionClient,
    "providerConnection" | "providerCredential" | "providerModel"
  >,
  key: Buffer,
  env: Record<string, string | undefined>
): Promise<LegacyProviderImportResult> {
  const imported: LegacyProviderName[] = [];
  const skippedConfigured: LegacyProviderName[] = [];

  for (const item of parseLegacyProviderEnvironment(env)) {
    const connection = await tx.providerConnection.findUnique({
      include: {
        credentials: { select: { id: true, label: true } },
        models: {
          select: {
            activeVersion: true,
            draftConfig: true,
            draftVersion: true,
            id: true
          }
        }
      },
      where: { id: item.connectionId }
    });
    if (!connection) {
      throw new LegacyProviderImportError(`provider_env_missing_${item.provider}_template`);
    }

    const alreadyImported = connection.credentials.some(
      (credential) => credential.label === IMPORTED_CREDENTIAL_LABEL
    );
    const pristine =
      connection.activeVersion === 0 &&
      connection.defaultCredentialId === null &&
      connection.draftVersion === 1 &&
      connection.credentials.length === 0 &&
      connection.models.every((model) => model.activeVersion === 0 && model.draftVersion === 1);
    if (alreadyImported || !pristine) {
      skippedConfigured.push(item.provider);
      continue;
    }

    const credentialId = randomUUID();
    await tx.providerCredential.create({
      data: {
        connectionId: connection.id,
        draftSecretEnvelope: encryptProviderCredentialSecret({
          credentialId,
          key,
          secret: item.secret,
          valueId: "draft:1"
        }),
        draftVersion: 1,
        enabled: false,
        id: credentialId,
        label: IMPORTED_CREDENTIAL_LABEL
      }
    });

    await tx.providerConnection.update({
      data: {
        defaultCredentialId: credentialId,
        draftConfig: json(item.configuration),
        draftVersion: { increment: 1 },
        enabled: false,
        family: item.family
      },
      where: { id: connection.id }
    });

    if (item.provider === "openai") {
      for (const model of connection.models) {
        await tx.providerModel.update({
          data: {
            draftConfig: json({
              ...record(model.draftConfig),
              adapterKind: item.adapterKind
            }),
            draftVersion: { increment: 1 },
            enabled: false
          },
          where: { id: model.id }
        });
      }
    }
    imported.push(item.provider);
  }

  return { imported, skippedConfigured };
}
