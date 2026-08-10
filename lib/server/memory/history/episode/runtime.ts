import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ModelRunSseEvent,
  ModelRunUsage
} from "../../../../domain/modelRunEvents";
import { getSecretEncryptionKey } from "../../../secrets/envelope";
import { decryptProviderCredentialSecret } from "../../../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "../../../providers/providerConfiguration";
import { createProviderSafeFetch } from "../../../providers/providerSafeFetch";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../../providers/runtimeFactory";
import type { ProviderRunRequest, ProviderRunResult } from "../../../providers/types";
import type { ModelToolCall } from "../../../tools/types";
import type { MemorySecretFreeExecutionSnapshot } from "../../execution";
import type { MemoryEpisodeExtractionInput } from "./contract";
import {
  MEMORY_EPISODE_SYSTEM_PROMPT,
  memoryEpisodeExtractionTool,
  memoryEpisodePromptPayload
} from "./prompt";

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

export type MemoryEpisodeProviderEvidence = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  executionSnapshot: unknown;
  providerModelId: string;
}>;

export type MemoryEpisodeProviderResult = Readonly<{
  providerResponseId: string | null;
  toolCalls: readonly ModelToolCall[] | undefined;
  usage: ModelRunUsage;
}>;

export type MemoryEpisodeProvider = Readonly<{
  run(
    evidence: MemoryEpisodeProviderEvidence,
    input: MemoryEpisodeExtractionInput,
    signal: AbortSignal
  ): Promise<MemoryEpisodeProviderResult>;
}>;

export class MemoryEpisodeProviderCallError extends Error {
  constructor(
    readonly usage: ModelRunUsage | null,
    options: Readonly<{ cause?: unknown }> = {}
  ) {
    super("memory_episode_provider_outcome_unknown", options);
    this.name = "MemoryEpisodeProviderCallError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

function boundedProviderResponseId(value: string | undefined): string | null {
  return value && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(value)
    ? value
    : null;
}

function providerRequest(
  snapshot: ProviderExecutionSnapshot,
  input: MemoryEpisodeExtractionInput
): ProviderRunRequest {
  const model = snapshot.model;
  if (model.adapterKind === "fake" || model.modelClass !== "answer") {
    throw new Error("memory_episode_runtime_invalid");
  }
  const maxOutputTokens = Math.min(
    model.capabilities.defaultMaxOutputTokens ?? 1_600,
    1_600
  );
  return {
    attachmentIds: [],
    attachments: [],
    chatId: input.source.chatId,
    content: {
      blocks: [{ text: memoryEpisodePromptPayload(input), type: "text" }]
    },
    forceNonStreaming: true,
    modelCapabilities: model.capabilities,
    modelId: model.upstreamModelId,
    parallelToolCalls: false,
    params: {
      ...model.defaultParams,
      background: false,
      maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      store: false,
      stream: false
    },
    prompt: {
      developer: null,
      system: MEMORY_EPISODE_SYSTEM_PROMPT
    },
    provider: snapshot.providerFamily,
    searchStrategy: null,
    toolChoice: "auto",
    tools: [memoryEpisodeExtractionTool]
  };
}

async function collectProviderResult(
  stream: AsyncGenerator<ModelRunSseEvent, ProviderRunResult>
): Promise<ProviderRunResult> {
  let lastUsage: ModelRunUsage | null = null;
  try {
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "usage") lastUsage = next.value.data;
      next = await stream.next();
    }
    return next.value;
  } catch (error) {
    throw new MemoryEpisodeProviderCallError(lastUsage, { cause: error });
  }
}

export function memoryEpisodeProviderEvidence(
  snapshot: MemorySecretFreeExecutionSnapshot
): MemoryEpisodeProviderEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (!provider.credentialId || !provider.credentialVersionId) {
    throw new Error("memory_episode_binding_invalid");
  }
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    providerModelId: provider.providerModelId
  };
}

type RuntimeClient = Pick<PrismaClient, "$transaction">;

/** Resolves only the immutable target accepted by Memory execution admission.
 * The exact credential version is share-locked and rechecked on every request. */
export function createAcceptedMemoryEpisodeProvider(
  client: RuntimeClient,
  options: Readonly<{
    createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
    encryptionKey?: () => Buffer;
  }> = {}
): MemoryEpisodeProvider {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;

  return Object.freeze({
    async run(evidence, input, signal) {
      const snapshot = normalizeProviderExecutionSnapshot(evidence.executionSnapshot);
      if (
        snapshot.connectionId !== evidence.connectionId ||
        snapshot.providerModelId !== evidence.providerModelId ||
        snapshot.credentialId !== evidence.credentialId ||
        snapshot.credentialVersionId !== evidence.credentialVersionId ||
        snapshot.model.adapterKind === "fake" ||
        snapshot.model.modelClass !== "answer" ||
        snapshot.model.capabilities.toolCalling !== true
      ) throw new Error("memory_episode_runtime_invalid");
      const authenticationMode = providerAuthenticationMode(snapshot.connection);
      const lockCredential = async (expectNoAuth: boolean): Promise<string | null> =>
        client.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<LockedCredentialVersion[]>(Prisma.sql`
            SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
            FROM "ProviderCredentialVersion"
            WHERE "credentialId" = ${evidence.credentialId}
              AND "id" = ${evidence.credentialVersionId}
            FOR SHARE
          `);
          const version = rows[0];
          if (
            !version || version.revokedAt ||
            version.credentialId !== evidence.credentialId ||
            version.id !== evidence.credentialVersionId ||
            expectNoAuth !== noAuthEvidence(version.testEvidence) ||
            expectNoAuth !== (version.secretEnvelope === null)
          ) throw new Error("credential_revoked");
          return version.secretEnvelope === null
            ? null
            : decryptProviderCredentialSecret({
                credentialId: version.credentialId,
                envelope: version.secretEnvelope,
                key: encryptionKey(),
                valueId: version.id
              });
        });
      const baseFetch = options.createFetch?.(snapshot.connection) ??
        createProviderSafeFetch({ configuration: snapshot.connection });
      const fetchFn: typeof fetch = authenticationMode === "none"
        ? async (request, init) => {
            await lockCredential(true);
            return baseFetch(request, init);
          }
        : baseFetch;
      const runtime = createProviderRuntimeBinding({
        options: { allowFake: false, fetchFn },
        secret: authenticationMode === "none"
          ? null
          : async () => {
              const secret = await lockCredential(false);
              if (secret === null) throw new Error("credential_revoked");
              return secret;
            },
        snapshot
      });
      if (!runtime.toolBridge?.supportsToolCalling({
        modelId: snapshot.model.upstreamModelId,
        provider: snapshot.providerFamily
      })) throw new Error("memory_episode_runtime_invalid");
      const request = providerRequest(snapshot, input);
      const result = await collectProviderResult(
        runtime.adapter.stream(request, { signal })
      );
      return {
        providerResponseId: boundedProviderResponseId(result.providerResponseId),
        toolCalls: result.toolCalls,
        usage: result.usage
      };
    }
  });
}
