import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import * as runtime from "../../providers/runtimeFactory";
import * as vision from "../../providers/visionInputProbe";
import { fakeProviderToolBridge } from "../../tools/bridges";
import { loadInstallationAnswerProviderRole } from "../../providerRuntime/admission";
import { pdfInputVerificationEvidence } from "../../providers/pdfInputEvidence";
import { normalizeProviderModelConfiguration } from "../../providers/providerConfiguration";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { createAdminProviderDraftTester } from "./tester";
import { pendingInitialCapabilityEvidence } from "./initialCapabilitySetup";

afterAll(() => prisma.$disconnect());
afterEach(() => vi.restoreAllMocks());

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); } finally {
    await prisma.$transaction(async (tx) => {
      await tx.providerConnection.update({ where: { id: f.connectionId }, data: { defaultCredentialId: null } });
      await tx.providerCredential.update({ where: { id: f.credentialId }, data: { activeVersionId: null } });
      await tx.providerModel.deleteMany({ where: { connectionId: f.connectionId } });
      await tx.providerCredentialVersion.deleteMany({ where: { credentialId: f.credentialId } });
      await tx.providerCredential.delete({ where: { id: f.credentialId } });
      await tx.providerConnection.delete({ where: { id: f.connectionId } });
    });
  }
}

async function createFixture() {
  const connectionId = randomUUID(), credentialId = randomUUID(), providerModelId = randomUUID(), versionId = randomUUID();
  const connection = { apiRoot: "http://127.0.0.1:1/v1", allowPrivateNetwork: true,
    authenticationMode: "none", responseTimeoutMs: 5000 };
  const model = normalizeProviderModelConfiguration({ adapterKind: "openai_responses_compatible", answerSelectable: true,
    modelClass: "answer", upstreamModelId: "fixture", defaultParams: {}, capabilities: {
      toolCalling: false, parallelToolCalls: false, vision: false, streaming: false, nativePdfInput: false,
      nativeSearch: false, pdf: true, reasoning: false
    } });
  await prisma.$transaction(async (tx) => {
    await tx.providerConnection.create({ data: { id: connectionId, displayName: "Capability checkpoint fixture",
      family: "openai_compatible", enabled: true, activeVersion: 1, draftVersion: 1,
      activeConfig: connection, draftConfig: connection, activatedAt: new Date() } });
    await tx.providerCredential.create({ data: { id: credentialId, connectionId, label: "Keyless fixture", enabled: true } });
    await tx.providerCredentialVersion.create({ data: { id: versionId, credentialId, version: 1,
      secretEnvelope: null, testEvidence: { authenticationMode: "none" }, testedAt: new Date(), activatedAt: new Date() } });
    await tx.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: versionId, activatedAt: new Date() } });
    await tx.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    const json = JSON.parse(JSON.stringify(model));
    await tx.providerModel.create({ data: { id: providerModelId, connectionId, provider: "openai_compatible", modelId: "fixture",
      displayName: "Checkpoint fixture", modelClass: "answer", enabled: true, activeVersion: 1, draftVersion: 1,
      activeConfig: json, draftConfig: json, capabilities: json.capabilities, defaultParams: {}, activatedAt: new Date() } });
    await tx.providerModelCredentialCheck.create({ data: { connectionId, providerModelId, credentialId, credentialVersionId: versionId,
      connectionVersion: 1, modelVersion: 1, status: "unavailable", checkedAt: new Date(),
      evidence: JSON.parse(JSON.stringify(pendingInitialCapabilityEvidence(model))) } });
  });
  const calls: string[] = [];
  let jsonGate: ReturnType<typeof gate> | undefined;
  let pdfFails = false;
  vi.spyOn(vision, "createProviderVisionInputProbe").mockReturnValue({ async probe() { calls.push("vision"); return true; } });
  vi.spyOn(runtime, "createProviderRuntimeBinding").mockImplementation(() => ({
    responseTimeoutMs: 5000, toolBridge: fakeProviderToolBridge,
    adapter: { buildRequestPreview() { return {}; }, async *stream(request) {
      const name = request.tools?.[0]?.name;
      calls.push(name ?? (request.forceNonStreaming ? "access" : "streaming"));
      yield { type: "usage", data: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 } };
      return { finalText: "OK", finalProviderResponsePreview: {}, providerResponseId: "synthetic",
        usage: { inputTokens: 2, outputTokens: 1, reasoningTokens: 0, totalTokens: 3 }, toolCalls: name ? (name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
          id: `call-${index}`, name, arguments: { city }
        })) : [] };
    } },
    structuredOutputAdapter: { async execute() {
      calls.push("json"); if (jsonGate) await jsonGate.wait;
      return { ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] };
    } }
  }));
  const tester = createAdminProviderDraftTester({ retrySleep: async () => {}, pdfInputProbe: { async probe() {
    calls.push("pdf"); if (pdfFails) throw new Error("pdf_input_probe_inconclusive");
    return pdfInputVerificationEvidence(model.adapterKind, model.upstreamModelId);
  } } });
  const repository = createPrismaAdminProviderRepository(prisma);
  const service = (repo = repository) => createAdminProviderService({ repository: repo, tester,
    credentialTester: { async test() { return { method: "models_catalog", modelIds: ["fixture"] }; } } });
  const tuple = { connectionId, credentialId, providerModelId };
  const request = { connectionId, credentialId, modelIds: [providerModelId], reason: "requested" as const };
  const current = async () => (await repository.loadActiveRefreshCandidate(tuple))!;
  return { ...tuple, versionId, calls, repository, service, request, current,
    blockJson() { jsonGate = gate(); return jsonGate; }, failPdf(value: boolean) { pdfFails = value; } };
}

async function finished(service: ReturnType<typeof createAdminProviderService>, connectionId: string, runId: string) {
  await vi.waitFor(() => expect(service.checkRun({ connectionId, runId }).inFlight).toEqual([]), { timeout: 5000 });
  await vi.waitFor(() => expect(service.checkRun({ connectionId, runId }).state).not.toBe("running"), { timeout: 5000 });
  return service.checkRun({ connectionId, runId });
}

describe("durable independent capability checkpoints", () => {
  it("keeps a committed prefix after cancellation and a new service resumes only unresolved probes", async () => fixture(async (f) => {
    const blocked = f.blockJson();
    const first = f.service();
    const run = await first.startCheckRun({ ...f.request, initialModelIds: [f.providerModelId] });
    await vi.waitFor(() => expect(f.calls).toContain("json"));
    const saved = await f.current();
    expect(saved.priorEvidence?.capabilitySetup?.checks).toMatchObject({ modelAccess: "verified", structuredOutput: "not_checked" });
    first.cancelCheckRun({ connectionId: f.connectionId, runId: run.id });
    expect(await finished(first, f.connectionId, run.id)).toMatchObject({ state: "cancelled",
      results: [{ state: "cancelled", checks: { modelAccess: "verified", structuredOutput: "not_checked" } }] });
    blocked.release();
    await Promise.resolve();
    expect((await f.current()).priorEvidence).toEqual(saved.priorEvidence);
    f.calls.length = 0;
    // A new repository/service owns no cache or in-process run state.
    const restarted = f.service(createPrismaAdminProviderRepository(prisma));
    expect(restarted.checkRun({ connectionId: f.connectionId, runId: run.id }).state).toBe("interrupted");
    const retry = await restarted.startCheckRun({ ...f.request, retryUnresolved: true });
    expect(await finished(restarted, f.connectionId, retry.id)).toMatchObject({ failed: [], results: [{ state: "saved" }] });
    expect(f.calls).not.toContain("access");
    expect(f.calls).toContain("streaming");
    expect((await f.current()).model.version).toBeGreaterThan(saved.model.version);
    expect(await loadInstallationAnswerProviderRole(prisma, { providerModelId: f.providerModelId }))
      .toMatchObject({ verifiedVisionInput: true, verifiedStructuredOutput: true, verifiedForcedToolCall: true });
  }));

  it("saves a partial result, retries only PDF and preserves a later administrator disable", async () => fixture(async (f) => {
    f.failPdf(true);
    const service = f.service();
    const run = await service.startCheckRun({ ...f.request, initialModelIds: [f.providerModelId] });
    expect(await finished(service, f.connectionId, run.id)).toMatchObject({ failed: [f.providerModelId],
      results: [{ state: "partial", checks: { directPdf: "incomplete", streaming: "verified" } }] });
    const candidate = await f.current();
    expect(candidate.priorEvidence?.capabilitySetup?.attempts?.directPdf?.attempts).toBe(2);
    f.failPdf(false); f.calls.length = 0;
    const retryService = f.service();
    const retry = await retryService.startCheckRun({ ...f.request, retryUnresolved: true });
    await finished(retryService, f.connectionId, retry.id);
    expect(retry.total).toBe(1);
    expect(f.calls).toEqual(["pdf"]);
    const enabled = await f.current();
    const configuration = normalizeProviderModelConfiguration(enabled.model.configuration);
    const disabled = { ...configuration, capabilities: { ...configuration.capabilities, vision: false } };
    await prisma.providerModel.update({ where: { id: f.providerModelId }, data: { activeVersion: { increment: 1 }, draftVersion: { increment: 1 },
      activeConfig: JSON.parse(JSON.stringify(disabled)), draftConfig: JSON.parse(JSON.stringify(disabled)), capabilities: JSON.parse(JSON.stringify(disabled.capabilities)) } });
    const ordinary = f.service();
    const refresh = await ordinary.startCheckRun({ ...f.request, retryUnresolved: true });
    expect(await finished(ordinary, f.connectionId, refresh.id)).toMatchObject({ failed: [],
      results: [{ state: "saved", checks: { vision: "verified", streaming: "verified" } }] });
    expect(normalizeProviderModelConfiguration((await f.current()).model.configuration).capabilities.vision).toBe(false);
  }));

  it("reports only durable capabilities if the next checkpoint cannot be saved", async () => fixture(async (f) => {
    let writes = 0;
    const service = f.service({ ...f.repository, async storeActiveRefreshCas(value) {
      if (++writes === 2) throw new Error("synthetic_database_failure");
      return f.repository.storeActiveRefreshCas(value);
    } });
    const run = await service.startCheckRun(f.request);
    const result = await finished(service, f.connectionId, run.id);
    expect(result).toMatchObject({ failed: [f.providerModelId], results: [{ state: "save_failed",
      checks: { modelAccess: "verified", structuredOutput: "not_checked" } }] });
    expect((await f.current()).priorEvidence?.structuredOutput).toBeUndefined();
    expect(f.calls).toEqual(["access", "json"]);
  }));

  it("rejects an older partial result after another writer, tuple replacement or cancellation", async () => fixture(async (f) => {
    const service = f.service();
    const run = await service.startCheckRun(f.request);
    await finished(service, f.connectionId, run.id);
    const candidate = await f.current();
    const evidence = candidate.priorEvidence!;
    const write = { candidate, evidence, status: "available" as const, checkedAt: new Date() };
    const results = await Promise.all([1, 2].map((attempts) => f.repository.storeActiveRefreshCas({ ...write, evidence: {
      ...evidence, capabilitySetup: { ...evidence.capabilitySetup!, attempts: { streaming: { attempts, status: "incomplete", reason: "network" } } }
    } })));
    expect(results.sort()).toEqual(["stale", "stored"]);
    expect(await f.repository.storeActiveRefreshCas(write)).toBe("stale");
    const after = await f.current();
    const controller = new AbortController(); controller.abort();
    await expect(f.repository.storeActiveRefreshCas({ ...write, candidate: after, signal: controller.signal })).rejects.toThrow();
    await prisma.providerConnection.update({ where: { id: f.connectionId }, data: { activeVersion: { increment: 1 } } });
    expect(await f.repository.storeActiveRefreshCas({ ...write, candidate: after })).toBe("stale");
    expect((await f.current()).priorEvidence).toBeUndefined();
    const rotated = randomUUID();
    await prisma.providerCredentialVersion.create({ data: { id: rotated, credentialId: f.credentialId, version: 2,
      secretEnvelope: null, testEvidence: { authenticationMode: "none" }, testedAt: new Date(), activatedAt: new Date() } });
    await prisma.providerCredential.update({ where: { id: f.credentialId }, data: { activeVersionId: rotated } });
    expect(await f.repository.storeActiveRefreshCas({ ...write, candidate: after })).toBe("stale");
    expect((await f.current()).priorEvidence).toBeUndefined();
  }));
});
