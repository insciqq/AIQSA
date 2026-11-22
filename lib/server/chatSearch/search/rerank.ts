import { ProviderAdmissionError } from "../../providerRuntime/admission";
import { createRerankerModelRoleResolver } from "../../providerRuntime/rerankerModelRole";
import { createPrismaRerankerRuntime, type RerankerRuntimeBinding } from "../../providerRuntime/rerankerRuntime";
import type { RerankRequest, RerankResult, RerankUsage } from "../../providers/rerank";

/**
 * The installation's dedicated reranker as past-chat search uses it: the
 * administrator's selected model only. Not set means the fused order; set and
 * unusable means the fused order too, never another reranker, the System
 * Model or a generative fallback (`agent_docs/PROVIDERS.md`).
 */

export type PastChatRerankBinding = Pick<RerankerRuntimeBinding,
  "connectionId" | "credentialId" | "credentialSource" | "credentialVersionId" | "provider" | "providerModelId">;

export type PastChatRerankRoute = Readonly<{
  binding: PastChatRerankBinding;
  rerank(request: RerankRequest): Promise<RerankResult>;
}>;

export type PastChatRerankResolution =
  | Readonly<{ kind: "unset" }>
  | Readonly<{ kind: "unavailable"; providerModelId: string | null }>
  | Readonly<{ kind: "ready"; route: PastChatRerankRoute }>;

export type PastChatReranker = Readonly<{ resolve(): Promise<PastChatRerankResolution> }>;

/**
 * A reranker call's provider-reported usage, recorded after the call under the
 * `memory_retrieval` purpose (the identifier past-chat search keeps from
 * Memory, so usage history stays continuous). Only calls that reported usage
 * are recorded; failed ones included. Recording never delays or fails a search.
 */
export type PastChatRerankUsageEvent = Readonly<{
  purpose: "memory_retrieval";
  kind: "rerank";
  userId: string;
  binding: PastChatRerankBinding;
  outcome: "succeeded" | "failed";
  usage: RerankUsage;
  providerRequestId: string | null;
}>;

export type PastChatUsageRecorder = (event: PastChatRerankUsageEvent) => Promise<void> | void;

type RerankerStore = Parameters<typeof createRerankerModelRoleResolver>[0] & Parameters<typeof createPrismaRerankerRuntime>[0];

export function createPrismaPastChatReranker(db: RerankerStore, dependencies: Readonly<{
  resolver?: Pick<ReturnType<typeof createRerankerModelRoleResolver>, "resolve">;
  runtime?: Pick<ReturnType<typeof createPrismaRerankerRuntime>, "resolveForInstallation">;
}> = {}): PastChatReranker {
  const resolver = dependencies.resolver ?? createRerankerModelRoleResolver(db);
  // Strict: a malformed ranking is a failure, never a partial order.
  const runtime = dependencies.runtime ?? createPrismaRerankerRuntime(db, { validation: "strict" });
  return Object.freeze({
    async resolve(): Promise<PastChatRerankResolution> {
      const resolution = await resolver.resolve();
      if (!resolution.ok) {
        return resolution.selectedProviderModelId === null
          ? { kind: "unset" }
          : { kind: "unavailable", providerModelId: resolution.selectedProviderModelId };
      }
      const selected = resolution.selectedProviderModelId ?? resolution.providerModelId;
      // The resolver lists approved fallbacks after the selected model; only the selected one is used.
      if (resolution.providerModelId !== selected) return { kind: "unavailable", providerModelId: selected };
      try {
        const binding = await runtime.resolveForInstallation({ providerModelId: selected });
        return { kind: "ready", route: {
          binding: { connectionId: binding.connectionId, credentialId: binding.credentialId, credentialSource: binding.credentialSource,
            credentialVersionId: binding.credentialVersionId, provider: binding.provider, providerModelId: binding.providerModelId },
          rerank: (request) => binding.adapter.rerank(request)
        } };
      } catch (error) {
        if (error instanceof ProviderAdmissionError) return { kind: "unavailable", providerModelId: selected };
        throw error;
      }
    }
  });
}
