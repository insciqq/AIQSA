import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection, AdminProviderTestEvidence } from "../../../contracts/adminProviders";
import { adminProviderConnectionConfiguration, adminProviderModelConfiguration } from "./adminConfiguration";
import { createAdminProviderCustomSetupService } from "./customSetupService";
import type { AdminProviderCustomSetupCommitPlan } from "./customSetupRepositoryContract";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { createAdminProviderDraftTester, type AdminProviderDraftTesterInput } from "./tester";

const NOW = new Date("2026-09-09T00:00:00Z");
const KEY = Buffer.alloc(32, 21);

function connectionFrom(plan: AdminProviderCustomSetupCommitPlan): AdminProviderConnection {
  const timestamp = NOW.toISOString();
  const config = adminProviderConnectionConfiguration(plan.connection.configuration);
  return {
    activatedAt: timestamp, activeVersion: 1, activeConfig: config, draftConfig: config, draftVersion: 1,
    assignments: [], createdAt: timestamp, defaultCredentialId: plan.credential.id, displayName: plan.connection.displayName,
    draftChecks: [], enabled: true, family: "openai_compatible", id: plan.connection.id, updatedAt: timestamp,
    unassignedPolicy: "use_default", userAssignments: [],
    credentials: [{ activatedAt: timestamp, activeVersion: { activatedAt: timestamp, id: plan.credential.versionId,
      revokedAt: null, testedAt: timestamp, version: 1 }, createdAt: timestamp, draftSecretConfigured: false,
      draftVersion: 1, enabled: true, id: plan.credential.id, label: plan.credential.label, testedAt: timestamp, updatedAt: timestamp }],
    models: plan.models.map((model) => ({ activatedAt: timestamp, activeConfig: adminProviderModelConfiguration(model.configuration),
      activeVersion: 1, connectionId: plan.connection.id, createdAt: timestamp, displayName: model.displayName,
      draftConfig: adminProviderModelConfiguration(model.configuration), draftVersion: 1, enabled: true, id: model.id, updatedAt: timestamp })),
    activeChecks: plan.models.map((model) => ({ checkedAt: timestamp, connectionVersion: 1, credentialId: plan.credential.id,
      credentialVersionId: plan.credential.versionId, evidence: model.evidence, latestRefreshError: null,
      modelVersion: 1, providerModelId: model.id, refreshFailedAt: null, status: "available" }))
  };
}

async function fixture(realTester = false) {
  let connection!: AdminProviderConnection;
  let plan!: AdminProviderCustomSetupCommitPlan;
  let setupRunId = "";
  let nextId = 0;
  let finishBootstrap!: () => void;
  const bootstrap = new Promise<void>((resolve) => { finishBootstrap = resolve; });
  const completeSetup = vi.fn(async () => {
    await bootstrap;
    return { state: "completed" as const, defaults: ["Chat: Synthetic"], search: "skipped" as const };
  });
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const text = body.text?.format ? JSON.stringify({ count: 2, label: "AIQSA", ready: true, tool_ids: ["alpha", "beta"] })
      : JSON.stringify(body.input).includes("input_file") ? "PEARS" : "OK";
    const response = { id: "synthetic-response", status: "completed", output: [{ type: "message", role: "assistant",
      content: [{ type: "output_text", text }] }], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } };
    return body.stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
  });
  const draftTester = createAdminProviderDraftTester({ createFetch: () => fetchFn });
  const test = vi.fn(async (input: Omit<AdminProviderDraftTesterInput, "mode">) => {
    if (realTester) return draftTester.test({ ...input, mode: "tiny_generation" });
    const evidence: AdminProviderTestEvidence = { detail: "ok", method: "tiny_generation", selectedProviders: [],
      upstreamModelId: input.model.upstreamModelId,
      compatibility: { probeVersion: 2, modelAccess: "verified", streaming: "verified", usage: "verified",
        structuredOutput: "not_supported", directPdf: "not_supported" } };
    return { status: "available" as const, evidence };
  });
  const repository = createPrismaAdminProviderRepository({} as PrismaClient);
  vi.spyOn(repository, "listConnections").mockImplementation(async () => [connection]);
  vi.spyOn(repository, "loadActiveRefreshCandidate").mockImplementation(async ({ providerModelId }) => {
    const model = plan.models.find(({ id }) => id === providerModelId)!;
    const activeModel = connection.models.find(({ id }) => id === providerModelId)!;
    return { connection: { configuration: plan.connection.configuration, displayName: plan.connection.displayName,
      family: "openai_compatible", id: connection.id, version: connection.activeVersion },
      credential: { envelope: plan.credential.secretEnvelope, id: plan.credential.id, versionId: connection.credentials[0]!.activeVersion!.id },
      model: { configuration: model.configuration, displayName: model.displayName, id: model.id, version: activeModel.activeVersion } };
  });
  vi.spyOn(repository, "storeActiveRefreshCas").mockResolvedValue("stored");
  vi.spyOn(repository, "recordActiveRefreshFailureCas").mockResolvedValue("stored");
  const providerService = createAdminProviderService({ repository, completeSetup, now: () => NOW,
    encryptionKey: () => KEY, tester: { test }, credentialTester: { async test() { throw new Error("unexpected_catalog_probe"); } } });
  const customService = createAdminProviderCustomSetupService({
    encryptionKey: () => KEY, idFactory: () => `synthetic-${++nextId}`, now: () => NOW, tester: { test },
    repository: { async commit(value) { plan = value; connection = connectionFrom(plan); return { status: "ready", defaultChanged: true }; } },
    async onCompleted(value) {
      const run = await providerService.startCheckRun({ ...value, reuseCurrentChecks: true, reason: "setup" });
      setupRunId = run.id;
    }
  });
  await customService.setup({ actor: { sessionId: "session", userId: "admin" }, request: {
    allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer",
    confirmPaidRequest: true, modelIds: ["model-a", "model-b", "model-c", "model-d"], protocol: "responses",
    responseTimeoutSeconds: 300, secret: "synthetic-secret"
  } });
  await vi.waitFor(() => expect(completeSetup).toHaveBeenCalledOnce());
  const current = () => providerService.checkRun({ connectionId: connection.id, runId: setupRunId });
  return { connection, current, fetchFn, finishBootstrap, providerService, repository, test, completeSetup,
    async finish() { finishBootstrap(); await vi.waitFor(() => expect(current().state).toBe("completed")); } };
}

describe("reuse of checks committed by custom setup", () => {
  it("performs four checks, reuses all four exact proofs, and still waits for automatic setup", async () => {
    const f = await fixture(true);
    expect(f.test).toHaveBeenCalledTimes(4);
    expect(f.test.mock.calls.map(([input]) => input.model.upstreamModelId)).toEqual(["model-a", "model-b", "model-c", "model-d"]);
    expect(f.fetchFn).toHaveBeenCalledTimes(16);
    expect(f.repository.loadActiveRefreshCandidate).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({ state: "running", done: 4, total: 4, failed: [], inFlight: [], setup: { state: "running" } });
    await f.finish();
    expect(f.current()).toMatchObject({ state: "completed", done: 4, failed: [],
      setup: { state: "completed", defaults: ["Chat: Synthetic"], search: "skipped" } });
    expect(f.test).toHaveBeenCalledTimes(4);
    // Four physical probes per model: access, JSON, PDF and streaming. Bootstrap adds none.
    expect(f.fetchFn).toHaveBeenCalledTimes(16);
  });

  it.each(["connection", "model", "credential", "warning", "unavailable", "unproved"] as const)(
    "requires fresh probes when %s evidence is no longer reusable", async (changed) => {
      const f = await fixture();
      await f.finish();
      const first = f.connection.activeChecks[0]!;
      if (changed === "connection") f.connection.activeVersion += 1;
      else if (changed === "model") f.connection.models[0]!.activeVersion += 1;
      else if (changed === "credential") f.connection.credentials[0]!.activeVersion!.id = "new-version";
      else if (changed === "warning") first.latestRefreshError = { code: "provider_refresh_failed", version: 1 };
      else if (changed === "unavailable") first.status = "unavailable";
      else first.evidence = null;
      const run = await f.providerService.startCheckRun({ connectionId: f.connection.id,
        credentialId: f.connection.defaultCredentialId!, reason: "setup", reuseCurrentChecks: true });
      await vi.waitFor(() => expect(f.providerService.checkRun({ connectionId: f.connection.id, runId: run.id }).state).toBe("completed"));
      expect(f.test).toHaveBeenCalledTimes(changed === "connection" || changed === "credential" ? 8 : 5);
    }
  );

  it("executes an explicit later check even when its evidence remains current", async () => {
    const f = await fixture();
    await f.finish();
    const run = await f.providerService.startCheckRun({ connectionId: f.connection.id,
      credentialId: f.connection.defaultCredentialId!, reason: "requested", reuseCurrentChecks: true });
    await vi.waitFor(() => expect(f.providerService.checkRun({ connectionId: f.connection.id, runId: run.id }).state).toBe("completed"));
    expect(f.test).toHaveBeenCalledTimes(8);
    expect(f.repository.loadActiveRefreshCandidate).toHaveBeenCalledTimes(4);
  });
});
