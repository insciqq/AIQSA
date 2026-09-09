import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection, AdminProviderModelConfiguration, AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { createAdminProviderDraftTester } from "./tester";

const NOW = new Date("2026-09-09T00:00:00Z");
const KEY = Buffer.alloc(32, 17);
const configuration = {
  allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1",
  authenticationMode: "bearer" as const, responseTimeoutMs: 300_000
};
const model = {
  adapterKind: "openai_responses_compatible" as const, answerSelectable: true,
  capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
  defaultParams: {}, modelClass: "answer" as const, upstreamModelId: "synthetic-model"
};
const request = { confirmPaidRequest: true, connectionId: "connection", credentialId: "credential", providerModelId: "model" };
const previous: AdminProviderTestEvidence = {
  detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: model.upstreamModelId,
  compatibility: { probeVersion: 2, modelAccess: "verified", streaming: "verified", usage: "verified",
    structuredOutput: "verified", directPdf: "verified", vision: "verified" },
  structuredOutput: { adapterKind: model.adapterKind, upstreamModelId: model.upstreamModelId, probeVersion: 2, verified: true },
  pdfInput: { adapterKind: model.adapterKind, upstreamModelId: model.upstreamModelId, probeVersion: 1, verified: true },
  visionInput: { adapterKind: model.adapterKind, upstreamModelId: model.upstreamModelId, probeVersion: 1, verified: true }
};

function fixture(prior: boolean, target: "memory" | "direct_pdf", terminal: "failed" | "incomplete", nativeGemini = false,
  routerFailure?: "refusal" | "parser" | "limit" | "truncated" | "wrong" | "unsupported") {
  const selectedModel: AdminProviderModelConfiguration = routerFailure ? { ...model, adapterKind: "openrouter_chat_completions" as const,
    openRouterRouting: { mode: "automatic" as const, providers: [] } }
    : nativeGemini ? { ...model, adapterKind: "gemini_interactions_native" as const } : model;
  const family = routerFailure ? "openrouter" : nativeGemini ? "gemini" : "openai_compatible";
  const previousEvidence: AdminProviderTestEvidence = nativeGemini ? {
    ...previous,
    structuredOutput: { ...previous.structuredOutput!, adapterKind: "gemini_interactions_native" },
    pdfInput: { ...previous.pdfInput!, adapterKind: "gemini_interactions_native" },
    visionInput: { ...previous.visionInput!, adapterKind: "gemini_interactions_native" }
  } : routerFailure ? { ...previous,
    structuredOutput: { ...previous.structuredOutput!, adapterKind: "openrouter_chat_completions", probeVersion: 5 },
    pdfInput: { ...previous.pdfInput!, adapterKind: "openrouter_chat_completions" },
    visionInput: { ...previous.visionInput!, adapterKind: "openrouter_chat_completions" }
  } : previous;
  const envelope = encryptProviderCredentialSecret({ credentialId: request.credentialId, key: KEY,
    secret: "synthetic-secret", valueId: "version" });
  const candidate = {
    connection: { configuration, displayName: "Synthetic", family, id: request.connectionId, version: 3 },
    credential: { envelope, id: request.credentialId, versionId: "version" },
    model: { configuration: selectedModel, displayName: "Synthetic", id: request.providerModelId, version: 4 }
  };
  let row: Record<string, unknown> | null = prior ? { status: "available", evidence: previousEvidence } : null;
  const active = { connection: 3, model: 4, credential: "version", revokedAt: null as Date | null };
  const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (row) Object.assign(row, data);
    return { count: row ? 1 : 0 };
  });
  const upsert = vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    row = row ? { ...row, ...update } : create;
    return row;
  });
  const db = {
    providerConnection: { findUnique: async () => ({ activeVersion: active.connection }) },
    providerModel: { findFirst: async () => ({ activeVersion: active.model }) },
    providerCredential: { findFirst: async () => ({ activeVersionId: active.credential,
      activeVersion: { revokedAt: active.revokedAt, secretEnvelope: envelope } }) },
    providerModelCredentialCheck: { updateMany, upsert, findUnique: async () => row }
  };
  const repository = createPrismaAdminProviderRepository({ ...db,
    $transaction: async (operation: (tx: typeof db) => Promise<unknown>) => operation(db)
  } as unknown as PrismaClient);
  vi.spyOn(repository, "loadActiveRefreshCandidate").mockResolvedValue(candidate);
  vi.spyOn(repository, "withLockedCredential").mockImplementation(async (_id, _version, consume) =>
    consume({ credentialId: request.credentialId, id: "version", revokedAt: null, secretEnvelope: envelope }));
  const adminConfig = { allowPrivateNetwork: false, apiRoot: configuration.apiRoot,
    authenticationMode: "bearer" as const, responseTimeoutSeconds: 300 };
  const timestamp = NOW.toISOString();
  const connection: AdminProviderConnection = {
    activatedAt: timestamp, activeChecks: [], activeConfig: adminConfig, activeVersion: 3, assignments: [],
    createdAt: timestamp, defaultCredentialId: request.credentialId, displayName: "Synthetic", draftChecks: [],
    draftConfig: adminConfig, draftVersion: 3, enabled: true, family, id: request.connectionId,
    unassignedPolicy: "use_default", updatedAt: timestamp, userAssignments: [],
    credentials: [{ activatedAt: timestamp, activeVersion: { activatedAt: timestamp, id: "version",
      revokedAt: null, testedAt: timestamp, version: 1 }, createdAt: timestamp, draftSecretConfigured: false,
      draftVersion: 1, enabled: true, id: request.credentialId, label: "Synthetic", testedAt: timestamp, updatedAt: timestamp }],
    models: [{ activatedAt: timestamp, activeConfig: selectedModel, activeVersion: 4, connectionId: request.connectionId,
      createdAt: timestamp, displayName: "Synthetic", draftConfig: selectedModel, draftVersion: 4, enabled: true,
      id: request.providerModelId, updatedAt: timestamp }]
  };
  vi.spyOn(repository, "listConnections").mockResolvedValue([connection]);
  let fail = true;
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const structured = Boolean(body.text?.format || body.response_format);
    const pdf = Boolean(body.plugins) || (JSON.stringify(body.input) ?? "").includes("input_file");
    if (routerFailure) {
      if (pdf) {
        expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "native" } }]);
        expect(body.provider).toMatchObject({ data_collection: "deny" });
      }
      if (fail && pdf && ["parser", "limit", "unsupported"].includes(routerFailure)) {
        return Response.json({ error: { code: routerFailure === "unsupported" ? "unsupported_file_type" : "invalid_request",
          message: "PRIVATE_SYNTHETIC_UPSTREAM_DETAIL" } }, { status: 400 });
      }
      const text = structured ? JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] })
        : pdf ? fail && routerFailure === "wrong" ? "APPLES" : "PEARS" : "OK";
      const choice = { finish_reason: fail && pdf && routerFailure === "truncated" ? "length"
        : fail && pdf && routerFailure === "refusal" ? "content_filter" : "stop",
        message: { role: "assistant", content: text,
          ...(fail && pdf && routerFailure === "refusal" ? { refusal: "PRIVATE_SYNTHETIC_UPSTREAM_DETAIL" } : {}) } };
      const response = { choices: [choice], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
      return body.stream ? new Response(`data: ${JSON.stringify({ ...response, choices: [{ ...choice, delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
    }
    if (fail && (target === "memory" ? structured : pdf)) return Response.json({
      id: "synthetic-response", status: terminal, output: [],
      error: { code: "server_error", message: "PRIVATE_SYNTHETIC_UPSTREAM_DETAIL" },
      incomplete_details: { reason: "max_output_tokens" }
    });
    if (nativeGemini) {
      const response = { id: "synthetic-response", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: structured
        ? JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] }) : "OK" }] }],
        usage: { total_input_tokens: 4, total_output_tokens: 1, total_tokens: 5 } };
      return body.stream ? new Response([
        `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "synthetic-response", status: "in_progress" } })}\n\n`,
        `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: response })}\n\n`,
        "event: done\ndata: [DONE]\n\n"
      ].join(""), { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
    }
    const response = { id: "synthetic-response", status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text: structured
        ? JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] }) : pdf ? "PEARS" : "OK" }] }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } };
    return body.stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
  });
  const tester = createAdminProviderDraftTester({ retrySleep: async () => {}, createFetch: () => fetchFn });
  const service = createAdminProviderService({ repository, now: () => NOW, encryptionKey: () => KEY,
    credentialTester: { async test() { throw new Error("unexpected_credential_test"); } },
    tester });
  return { active, candidate, fetchFn, previousEvidence, repository, service, tester, updateMany, upsert,
    row: () => row, succeed: () => { fail = false; } };
}

describe("failed capability response publication", () => {
  it.each([true, false])("replaces an incomplete setup PDF state with a conclusive role recheck: verified=%s", async (verified) => {
    const f = fixture(true, "direct_pdf", "failed", false, "unsupported");
    f.row()!.evidence = { ...f.previousEvidence, pdfInput: undefined,
      compatibility: { ...f.previousEvidence.compatibility, directPdf: "not_supported" },
      capabilitySetup: { policyVersion: 1, checks: { modelAccess: "verified", directPdf: "incomplete", vision: "verified" } }
    };
    if (verified) f.succeed();
    await expect(f.service.refreshActive({ ...request, capabilityRole: "direct_pdf" })).resolves.toMatchObject({
      evidence: { compatibility: { directPdf: verified ? "verified" : "not_supported" } }
    });
    expect(f.row()?.evidence).toMatchObject({
      compatibility: { directPdf: verified ? "verified" : "not_supported" },
      capabilitySetup: { checks: { directPdf: verified ? "verified" : "unsupported", vision: "verified" } }
    });
  });

  it.each(["refusal", "parser", "limit", "truncated", "wrong"] as const)(
    "preserves prior OpenRouter PDF proof after %s and publishes the next successful refresh", async (failure) => {
      const f = fixture(true, "direct_pdf", "failed", false, failure);
      await expect(f.service.refreshActive({ ...request, capabilityRole: "direct_pdf" }))
        .rejects.toMatchObject({ code: "provider_refresh_failed" });
      expect(f.upsert).not.toHaveBeenCalled();
      expect(f.row()?.evidence).toEqual(f.previousEvidence);
      expect(f.fetchFn).toHaveBeenCalledTimes(2);
      f.succeed();
      await expect(f.service.refreshActive({ ...request, capabilityRole: "direct_pdf" })).resolves.toMatchObject({
        connectionVersion: 3, modelVersion: 4, credentialVersionId: "version",
        latestRefreshError: null, evidence: { pdfInput: { verified: true }, compatibility: { directPdf: "verified" } }
      });
      expect(JSON.stringify(f.row())).not.toContain("PRIVATE_SYNTHETIC_UPSTREAM_DETAIL");
    }
  );

  it.each(["refusal", "parser", "limit", "truncated", "wrong", "unsupported"] as const)(
    "keeps fresh setup PDF %s separate from independent successful checks", async (failure) => {
      const f = fixture(false, "direct_pdf", "failed", false, failure);
      const result = await f.tester.test({
        connection: configuration, connectionDisplayName: "Synthetic", connectionId: "connection",
        credentialId: "credential", credentialVersionIdentity: "version", model: f.candidate.model.configuration,
        modelDisplayName: "Synthetic", providerModelId: "model", providerFamily: "openrouter",
        initialSetup: true, mode: "tiny_generation", secret: "synthetic-secret"
      });
      expect(result).toMatchObject({ status: "available", evidence: {
        capabilitySetup: { checks: { directPdf: failure === "unsupported" ? "unsupported" : "incomplete",
          structuredOutput: "verified", modelAccess: "verified", streaming: "verified" } },
        structuredOutput: { verified: true }
      } });
      expect(result.evidence.pdfInput).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC_UPSTREAM_DETAIL");
    }
  );

  it("replaces an earlier Gemini JSON rejection through the normal exact-revision refresh", async () => {
    const f = fixture(true, "memory", "failed", true);
    const row = f.row()!;
    row.evidence = { ...f.previousEvidence, structuredOutput: undefined,
      compatibility: { ...f.previousEvidence.compatibility, structuredOutput: "not_supported" }
    };
    f.succeed();
    const result = await f.service.refreshActive({ ...request, capabilityRole: "memory" });
    expect(result).toMatchObject({ status: "available", connectionVersion: 3,
      modelVersion: 4, credentialVersionId: "version", evidence: {
        compatibility: { structuredOutput: "verified" },
        structuredOutput: { verified: true, adapterKind: "gemini_interactions_native" }
      }
    });
    expect(f.candidate.model.configuration.defaultParams).toEqual({});
    expect((f.row()?.evidence as AdminProviderTestEvidence).visionInput).toEqual(f.previousEvidence.visionInput);
    expect(f.upsert).toHaveBeenCalledOnce();
  });

  it.each(["failed", "incomplete"] as const)("preserves Gemini evidence on %s and publishes the matching native JSON recheck", async (terminal) => {
    const f = fixture(true, "memory", terminal, true);
    await expect(f.service.refreshActive({ ...request, capabilityRole: "memory" })).rejects.toMatchObject({ code: "provider_refresh_failed" });
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.row()?.evidence).toEqual(f.previousEvidence);
    expect(JSON.stringify(f.row())).not.toContain("PRIVATE_SYNTHETIC_UPSTREAM_DETAIL");
    f.succeed();
    await expect(f.service.refreshActive({ ...request, capabilityRole: "memory" })).resolves.toMatchObject({
      status: "available", connectionVersion: 3, modelVersion: 4, credentialVersionId: "version",
      evidence: { structuredOutput: { adapterKind: "gemini_interactions_native", probeVersion: 2, verified: true,
        upstreamModelId: "synthetic-model" } }
    });
    expect(f.upsert).toHaveBeenCalledOnce();
  });

  it.each(["connection", "model", "credential", "revokedAt"] as const)("fences successful Gemini JSON evidence from a changed %s revision", async (changed) => {
    const f = fixture(true, "memory", "incomplete", true);
    f.succeed();
    if (changed === "credential") f.active.credential = "new-version";
    else if (changed === "revokedAt") f.active.revokedAt = NOW;
    else f.active[changed] += 1;
    await expect(f.service.refreshActive({ ...request, capabilityRole: "memory" })).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.row()).toEqual({ status: "available", evidence: f.previousEvidence });
  });

  it.each([
    ["memory", "failed"], ["memory", "incomplete"], ["direct_pdf", "failed"], ["direct_pdf", "incomplete"]
  ] as const)("preserves prior or absent evidence on %s/%s and permits an ordinary recheck", async (target, terminal) => {
    for (const prior of [true, false]) {
      for (const capabilityRole of [target, undefined] as const) {
        const f = fixture(prior, target, terminal);
        await expect(f.service.refreshActive({ ...request, capabilityRole })).rejects.toMatchObject({ code: "provider_refresh_failed" });
        expect(f.upsert).not.toHaveBeenCalled();
        expect(f.updateMany).toHaveBeenCalledWith({ data: {
          latestRefreshError: { code: "provider_refresh_failed", version: 1 }, refreshFailedAt: NOW
        }, where: { connectionId: request.connectionId, connectionVersion: 3, credentialId: request.credentialId,
          credentialVersionId: "version", modelVersion: 4, providerModelId: request.providerModelId } });
        expect(f.row()?.evidence ?? null).toEqual(prior ? previous : null);
        expect(f.row()?.status ?? null).toBe(prior ? "available" : null);
        expect(JSON.stringify(f.row())).not.toContain("PRIVATE_SYNTHETIC_UPSTREAM_DETAIL");
        f.succeed();
        const result = await f.service.refreshActive({ ...request, capabilityRole });
        expect(result).toMatchObject({ status: "available", latestRefreshError: null, refreshFailedAt: null,
          connectionVersion: 3, modelVersion: 4, credentialVersionId: "version" });
        expect(result.evidence?.compatibility?.[target === "memory" ? "structuredOutput" : "directPdf"]).toBe("verified");
        if (prior) expect(f.row()?.refreshFailedAt).toBeNull();
        if (prior && capabilityRole) expect((f.row()?.evidence as AdminProviderTestEvidence).visionInput).toEqual(previous.visionInput);
      }
    }
  });

  it.each(["connection", "model", "credential", "revokedAt"] as const)("does not mark a different %s authority tuple", async (changed) => {
    const f = fixture(true, "direct_pdf", "failed");
    if (changed === "credential") f.active.credential = "new-version";
    else if (changed === "revokedAt") f.active.revokedAt = NOW;
    else f.active[changed] += 1;
    await expect(f.service.refreshActive({ ...request, capabilityRole: "direct_pdf" }))
      .rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.row()).toEqual({ status: "available", evidence: previous });
  });

  it.each(["memory", "direct_pdf"] as const)("reports failed first-setup %s checks and clears failure after retry", async (target) => {
    const f = fixture(false, target, "incomplete");
    const started = await f.service.startCheckRun({ ...request, modelIds: [request.providerModelId], reason: "setup" });
    await vi.waitFor(() => expect(f.service.checkRun({ connectionId: request.connectionId, runId: started.id }))
      .toMatchObject({ state: "completed", done: 1, failed: [request.providerModelId] }));
    expect(f.row()).toBeNull();
    expect(f.upsert).not.toHaveBeenCalled();
    f.succeed();
    const retry = await f.service.startCheckRun({ ...request, modelIds: [request.providerModelId], reason: "requested" });
    await vi.waitFor(() => expect(f.service.checkRun({ connectionId: request.connectionId, runId: retry.id }))
      .toMatchObject({ state: "completed", done: 1, failed: [] }));
    expect(f.row()?.status).toBe("available");
  });
});
