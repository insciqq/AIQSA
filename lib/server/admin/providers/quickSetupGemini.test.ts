import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGeminiInteractionsAdapter } from "../../providers/geminiInteractions";
import { createFetchGeminiInteractionsClient } from "../../providers/geminiInteractionsTransport";
import { type ProviderConnectionConfiguration } from "../../providers/providerConfiguration";
import { createAdminProviderCredentialTester } from "./credentialTester";
import { adminProviderQuickSetupPolicy } from "./quickSetupPolicy";
import type { AdminProviderQuickSetupInspection, AdminProviderQuickSetupRepository } from "./quickSetupRepositoryContract";
import { createAdminProviderQuickSetupService } from "./quickSetupService";

describe("Gemini setup API version", () => {
  it.each([false, true])("keeps discovery, probes and saved native execution on the working root (additional: %s)", async (additional) => {
    const policy = adminProviderQuickSetupPolicy("gemini");
    const betaRoot = "https://generativelanguage.googleapis.com/v1beta";
    const pro = "gemini-3.1-pro-preview";
    const flash = "gemini-3.8-flash";
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (request, init) => {
      const url = new URL(String(request));
      calls.push(url.href);
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("synthetic-key");
      if (init?.method === "GET") {
        // The reported upstream discrepancy: /v1 lists Flash but omits Pro.
        return Response.json({ models: (url.pathname.startsWith("/v1beta/") ? [flash, pro] : [flash])
          .map((name) => ({ name: `models/${name}` })) });
      }
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model: pro, store: false, stream: false });
      if (!url.pathname.startsWith("/v1beta/")) return new Response(null, { status: 404 });
      return Response.json({
        id: "synthetic-interaction", model: pro, status: "completed",
        steps: [{ type: "model_output", content: [{ type: "text", text: "ok" }] }]
      });
    };
    let savedConnection: ProviderConnectionConfiguration | undefined;
    let savedModels: string[] = [];
    const repository: AdminProviderQuickSetupRepository = {
      inspect: async ({ provider }): Promise<AdminProviderQuickSetupInspection> => ({
        actingUserDefault: false, authorized: true, canonicalConnection: additional,
        configured: additional, connectionNames: additional ? ["Gemini"] : [],
        fingerprint: `synthetic-${provider}`, mode: "initial", model: null,
        preservedModels: [], quickSetupAssignment: null, quickSetupCredential: null,
        provider, state: "not_configured"
      }),
      commit: async (plan) => {
        savedConnection = adminProviderQuickSetupPolicy(plan.provider).connection.configuration;
        savedModels = plan.candidates.map(({ configuration }) => configuration.upstreamModelId);
        expect(plan.grants.map(({ modelId }) => modelId)).toEqual(plan.candidates.map(({ modelId }) => modelId));
        return { status: "ready", defaultChanged: true, defaultCredentialChanged: true };
      },
      commitAdditional: async (plan) => {
        savedConnection = plan.connection.configuration;
        savedModels = plan.models.map(({ candidate }) => candidate.configuration.upstreamModelId);
        expect(plan.connection.id).not.toBe(policy.connection.id);
        expect(plan.models.every(({ grantId }) => Boolean(grantId))).toBe(true);
        return { status: "ready" };
      }
    };
    const probe = vi.fn(async (input: { connection: ProviderConnectionConfiguration }) => {
      expect(input.connection.apiRoot).toBe(betaRoot);
      // Independent PDF failure cannot erase a discovered text model.
      return null;
    });
    const service = createAdminProviderQuickSetupService({
      credentialTester: createAdminProviderCredentialTester({ network: {
        dispatch: async (request) => fetchFn(request.url, {
          method: request.method, headers: request.headers, body: request.body,
          signal: request.signal
        }),
        lookupHostname: async () => [{ address: "8.8.8.8", family: 4 }]
      } }),
      encryptionKey: () => Buffer.alloc(32, 7), idFactory: randomUUID,
      pdfInputProbe: { probe }, repository, stateTokenKey: () => Buffer.alloc(32, 9)
    });
    const actor = { sessionId: "synthetic-session", userId: "synthetic-admin" };
    const snapshot = await service.getSnapshot(actor);
    const result = await service.setup({ actor, request: {
      provider: "gemini", secret: "synthetic-key",
      expectedState: snapshot.providers.find(({ provider }) => provider === "gemini")!.stateToken,
      ...(additional ? { connectionDisplayName: "Gemini second account" } : {})
    } });
    expect(result.outcome).toBe("ready");
    expect(savedModels).toEqual([flash, pro]);
    expect(savedConnection?.apiRoot).toBe(betaRoot);
    expect(probe).toHaveBeenCalledTimes(2);

    const model = policy.candidates.find(({ configuration }) => configuration.upstreamModelId === pro)!.configuration;
    const adapter = createGeminiInteractionsAdapter({ client: createFetchGeminiInteractionsClient({
      apiKey: "synthetic-key", apiRoot: savedConnection!.apiRoot, fetchFn
    }) });
    const stream = adapter.stream({
      attachmentIds: [], attachments: [], chatId: "synthetic-chat",
      content: { blocks: [{ type: "text", text: "hello" }] },
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: model.capabilities, modelId: pro,
      params: { maxTokens: 256, stream: false }, prompt: { developer: null, system: null },
      provider: "gemini", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
    });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    expect(next.value.finalText).toBe("ok");
    expect(calls).toEqual([`${betaRoot}/models?pageSize=1000`, `${betaRoot}/interactions`]);
  });
});
