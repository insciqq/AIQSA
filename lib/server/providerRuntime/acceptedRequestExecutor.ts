import { mergeTokenUsage, sumTokenUsage } from "../../domain/usage";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decryptProviderCredentialSecret } from "../providers/credentialSecrets";
import {
  providerAuthenticationMode,
  type ProviderConnectionConfiguration
} from "../providers/providerConfiguration";
import { droppedRequestRetryDelay, sleepWithSignal, type ProviderDroppedRequestRetry } from "../providers/providerRetry";
import { createProviderSafeFetch } from "../providers/providerSafeFetch";
import { providerOutputObserved } from "../providers/streamDrop";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import type {
  ProviderRunOptions,
  ProviderRunRequest,
  ProviderRunResult
} from "../providers/types";
import { getSecretEncryptionKey } from "../secrets/envelope";

type LockedCredentialVersion = Readonly<{
  credentialId: string;
  id: string;
  revokedAt: Date | null;
  secretEnvelope: string | null;
  testEvidence: unknown;
}>;

type RuntimeClient = Pick<PrismaClient, "$transaction">;

type AcceptedRequestExecutorOptions = Readonly<{
  createFetch?: (configuration: ProviderConnectionConfiguration) => typeof fetch;
  disableRequestRetries?: boolean;
  /**
   * Vision (PROVIDERS.md: Codex LB): within one call, a request the binding
   * recognizes as dropped before any of its output arrived is sent again
   * after the shared backoff. Present: admitted; the fields are backoff seams.
   */
  droppedRequestRetry?: Omit<ProviderDroppedRequestRetry, "policy">;
  encryptionKey?: () => Buffer;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noAuthEvidence(value: unknown): boolean {
  return isRecord(value) && value.authenticationMode === "none";
}

/** Executes a bounded ordinary answer request against an immutable provider
 * snapshot. The exact credential version is checked again at every network
 * boundary, and no mutable model selection is consulted after admission. */
export function createAcceptedProviderRequestExecutor(
  client: RuntimeClient,
  options: AcceptedRequestExecutorOptions = {}
) {
  const encryptionKey = options.encryptionKey ?? getSecretEncryptionKey;
  return async (
    executionSnapshot: ProviderExecutionSnapshot,
    request: ProviderRunRequest,
    executionOptions: ProviderRunOptions & { onUsage?(usage: ModelRunUsage): void } = {}
  ): Promise<ProviderRunResult> => {
    const snapshot = normalizeProviderExecutionSnapshot(executionSnapshot);
    if (
      snapshot.model.adapterKind === "fake" ||
      snapshot.model.modelClass !== "answer" ||
      !snapshot.credentialId ||
      !snapshot.credentialVersionId ||
      request.modelId !== snapshot.model.upstreamModelId ||
      request.provider !== snapshot.providerFamily ||
      request.forceNonStreaming !== true ||
      request.toolMode !== "none" ||
      request.toolChoice !== "none" ||
      request.tools?.length
    ) {
      throw new Error("accepted_provider_request_invalid");
    }
    const credentialId = snapshot.credentialId;
    const credentialVersionId = snapshot.credentialVersionId;
    const authenticationMode = providerAuthenticationMode(snapshot.connection);
    const lockCredential = async (expectNoAuth: boolean): Promise<string | null> =>
      client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<LockedCredentialVersion[]>(Prisma.sql`
          SELECT "credentialId", "id", "revokedAt", "secretEnvelope", "testEvidence"
          FROM "ProviderCredentialVersion"
          WHERE "credentialId" = ${credentialId}
            AND "id" = ${credentialVersionId}
          FOR SHARE
        `);
        const version = rows[0];
        if (
          !version || version.revokedAt ||
          version.credentialId !== credentialId ||
          version.id !== credentialVersionId ||
          expectNoAuth !== noAuthEvidence(version.testEvidence) ||
          expectNoAuth !== (version.secretEnvelope === null)
        ) throw new Error("credential_revoked");
        return version.secretEnvelope === null
          ? null
          : decryptProviderCredentialSecret({
              credentialId,
              envelope: version.secretEnvelope,
              key: encryptionKey(),
              valueId: credentialVersionId
            });
      });
    const baseFetch = options.createFetch?.(snapshot.connection) ??
      createProviderSafeFetch({ configuration: snapshot.connection });
    const fetchFn: typeof fetch = authenticationMode === "none"
      ? async (fetchRequest, init) => {
          await lockCredential(true);
          return baseFetch(fetchRequest, init);
        }
      : baseFetch;
    const runtime = createProviderRuntimeBinding({
      options: { allowFake: false, fetchFn, disableRequestRetries: options.disableRequestRetries,
        ...(options.droppedRequestRetry ? { droppedRequestRetry: true } : {}) },
      secret: authenticationMode === "none"
        ? null
        : async () => {
            const secret = await lockCredential(false);
            if (secret === null) throw new Error("credential_revoked");
            return secret;
          },
      snapshot
    });
    const retry = options.droppedRequestRetry && runtime.adapter.droppedRoundRetry
      ? { ...options.droppedRequestRetry, policy: runtime.adapter.droppedRoundRetry } : null;
    // Each dropped request is its own operation: the call reports the sum.
    const dropped: ModelRunUsage[] = [];
    for (let attempt = 1; ; attempt += 1) {
      let usage: ModelRunUsage = {};
      const total = () => dropped.length ? sumTokenUsage([...dropped, usage]) : usage;
      // Any event but usage and the provider's lifecycle summary is output.
      let receivedOutput = false;
      const stream = runtime.adapter.stream(request, executionOptions);
      let delayMs: number | null;
      try {
        let next = await stream.next();
        while (!next.done) {
          if (next.value.type === "usage") {
            usage = mergeTokenUsage(usage, next.value.data);
            executionOptions.onUsage?.(total());
          } else if (next.value.type !== "artifact" || next.value.data.artifactType !== "summary") receivedOutput = true;
          next = await stream.next();
        }
        usage = mergeTokenUsage(usage, next.value.usage);
        executionOptions.onUsage?.(total());
        return { ...next.value, usage: total() };
      } catch (error) {
        // Output the transport received before the adapter yielded any
        // (an assembled non-streaming create) counts as received too.
        delayMs = retry ? droppedRequestRetryDelay(retry, { acceptedOutput: receivedOutput || providerOutputObserved(error), attempt, error,
          signal: executionOptions.signal }) : null;
        if (delayMs === null) throw error;
      } finally {
        await stream.return(undefined as never).catch(() => undefined);
      }
      dropped.push({ ...usage, completeness: "partial" });
      executionOptions.onUsage?.(sumTokenUsage(dropped));
      // Stop and the caller's deadline end the wait with their own reason.
      await (retry!.sleep ?? sleepWithSignal)(delayMs, executionOptions.signal ?? new AbortController().signal);
    }
  };
}
