import { DEFAULT_AGENT_POLICY } from "@/lib/contracts/agentPolicy";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { textMessageContent } from "@/lib/domain/content";
import { agentLimits } from "./config";
import { createAgentRunStore, interruptExpiredAgentRun } from "./store";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { createOptionalDecisionRepository } from "../providerRuntime/optionalDecisionRepository";
import { lockRunSettlementScope } from "../runs/prismaRepositoryShared";
import { createArtifactService } from "../artifacts/service";
import type { StorageAdapter, StoredObjectInput } from "../uploads/storage";
import type { NormalizedRunRequest } from "../providers/types";
import { createAgentBuiltinDispatcher } from "./builtinTools";
import type { ModelToolCall } from "../tools/types";
import { syntheticImagePlan } from "@/tests/support/imagePlan";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createPrismaImageGenerationService } from "../images/service";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createPrismaWorkspaceCoordinatorRepository, type WorkspaceExecutionBinding } from "../workspace/coordinator";
import { readSkillZip } from "../skills/zipReader";

const configuration = { ...agentLimits({ ...DEFAULT_AGENT_POLICY, limitsEnabled: true }, { AIQSA_AGENT_GATEWAY_URL: "http://agent.invalid" }),
  compatibilityHash: "a".repeat(64), mcpMode: "auto" as const, maxModelCalls: 2 };

async function fixture(runConfiguration = configuration) {
  const userId = `agent-store-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, displayName: "Agent store fixture", status: "active" } });
  const chat = await prisma.chat.create({ data: { userId, title: "Agent fixture" } });
  const session = await prisma.workspaceSession.create({ data: { chatId: chat.id, sandboxName: `agent-${randomUUID()}`,
    imageRef: "aiqsa-workspace:0.1.27", internetEnabled: true, policyRevision: 1,
    runtimeSandboxId: "fixture-runtime", state: "RUNNING", expiresAt: new Date(Date.now() + 600000) } });
  async function run() {
    await prisma.modelRun.updateMany({ where: { chatId: chat.id, status: "in_progress" }, data: { status: "error" } });
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: textMessageContent("synthetic task") } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", content: textMessageContent("synthetic answer") } });
    const accepted = await prisma.modelRun.create({ data: { chatId: chat.id, userId, userMessageId: message.id,
      assistantMessageId: answer.id, provider: "fake", modelId: "fixture", status: "in_progress", normalizedRequest: {} } });
    await prisma.workspaceRunBinding.create({ data: { modelRunId: accepted.id, workspaceSessionId: session.id,
      imageRef: session.imageRef, internetEnabled: true, policyRevision: 1, runtimeVersion: "0.6.16", mcpVersion: "0.6.16",
      toolCatalogHash: "a".repeat(64), toolDefinitions: [{ originalName: "sandbox_exec_start", namespacedName: "workspace__sandbox_exec_start",
        description: "Fixture", inputSchema: { type: "object" } }], outputDirectory: `/workspace/output/${accepted.id}` } });
    await prisma.agentRunBinding.create({ data: { modelRunId: accepted.id, configuration: runConfiguration, compatibilityHash: runConfiguration.compatibilityHash } });
    await prisma.providerRunBinding.create({ data: { modelRunId: accepted.id, role: "answer", credentialSource: "default",
      executionSnapshot: { version: 1, providerFamily: "fake", connectionId: "fixture", providerModelId: "fixture",
        connectionDisplayName: "Fixture", modelDisplayName: "Fixture", credentialId: null, credentialVersionId: null,
        connection: { apiRoot: "http://fixture.invalid", allowPrivateNetwork: true, authenticationMode: "none", responseTimeoutMs: 300000 },
        model: { adapterKind: "fake", upstreamModelId: "fixture", defaultParams: {}, capabilities: {
          nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, streaming: true, vision: false
        } } } } });
    const store = createAgentRunStore(prisma, { runId: accepted.id, userId, configuration: runConfiguration });
    return { ...accepted, store };
  }
  return { userId, session, run, async dispose() {
    // Also proves whole-run deletion removes receipt rows without a FK deadlock.
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.workspaceSession.delete({ where: { id: session.id } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { startsWith: `artifacts/${userId}/` } } });
  } };
}

const pageCall: ModelToolCall = { id: "page", name: "create_artifact", arguments: { intent: "create", kind: "html", title: "Page",
  entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: "<p>PRIVATE_SYNTHETIC_SOURCE</p>" }] } };

async function artifactFixture() {
  const f = await fixture();
  const run = await f.run(); await run.store.arm(null);
  const objects = new Map<string, StoredObjectInput>();
  let beforePut: (() => Promise<void>) | undefined;
  const storage: StorageAdapter = {
    async putObject(value) { await beforePut?.(); objects.set(value.storageKey, value); },
    async getObject(key) { const value = objects.get(key); if (!value) throw new Error("missing_object"); return { ...value, body: Buffer.from(value.body) }; },
    async deleteObject(key) { objects.delete(key); }
  };
  const artifacts = createArtifactService(prisma, storage);
  const request = { chatId: run.chatId, artifactTool: true, artifactReferences: [], agent: configuration } as unknown as NormalizedRunRequest;
  const dispatch = (accepted = request, selectedRun = run, service = artifacts, store = selectedRun.store) => createAgentBuiltinDispatcher({
    request: accepted, runId: selectedRun.id, userId: f.userId, store, artifacts: service
  });
  return { ...f, accepted: run, request, artifacts, dispatch, objects, setBeforePut(value: typeof beforePut) { beforePut = value; } };
}

async function imageFixture() {
  const f = await fixture();
  const run = await f.run(); await run.store.arm(null);
  const plan = syntheticImagePlan();
  const authority = { ...plan.authority, connectionId: randomUUID(), providerModelId: randomUUID(), credentialId: randomUUID(), credentialVersionId: randomUUID() };
  plan.authority = authority;
  plan.snapshot = { ...plan.snapshot, connectionId: authority.connectionId, providerModelId: authority.providerModelId,
    credentialId: authority.credentialId, credentialVersionId: authority.credentialVersionId };
  const key = Buffer.alloc(32, 69);
  const json = (value: unknown) => value as Prisma.InputJsonValue;
  await prisma.providerConnection.create({ data: { id: authority.connectionId, displayName: "Synthetic image provider", family: "openai", enabled: true,
    activeConfig: json(plan.snapshot.connection), activeVersion: 1, activatedAt: new Date() } });
  await prisma.providerCredential.create({ data: { id: authority.credentialId, connectionId: authority.connectionId, label: "Fixture", enabled: true } });
  await prisma.providerCredentialVersion.create({ data: { id: authority.credentialVersionId, credentialId: authority.credentialId, version: 1,
    testEvidence: { authenticationMode: "bearer" }, activatedAt: new Date(), testedAt: new Date(),
    secretEnvelope: encryptProviderCredentialSecret({ credentialId: authority.credentialId, valueId: authority.credentialVersionId, key, secret: "synthetic-key" }) } });
  await prisma.providerModel.create({ data: { id: authority.providerModelId, connectionId: authority.connectionId, modelId: plan.snapshot.model.upstreamModelId,
    modelClass: "image", provider: "openai", displayName: "Synthetic image model", enabled: true, capabilities: json(plan.snapshot.model.capabilities),
    defaultParams: {}, activeConfig: json(plan.snapshot.model), activeVersion: 1, activatedAt: new Date() } });
  const bind = (runId: string) => prisma.providerRunBinding.create({ data: { modelRunId: runId, bindingKey: "image", role: "image", credentialSource: "default",
    connectionId: authority.connectionId, providerModelId: authority.providerModelId, credentialId: authority.credentialId,
    credentialVersionId: authority.credentialVersionId, executionSnapshot: json(plan.snapshot) } });
  await bind(run.id);
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: png.toString("base64") }],
    usage: { input_tokens: 3, output_tokens: 11, total_tokens: 14, cost: 0.012 } }));
  const storage = createMemoryStorageAdapter();
  const images = createPrismaImageGenerationService(prisma, storage, { encryptionKey: () => key, fetchFn });
  const artifacts = createArtifactService(prisma, storage);
  const request = { chatId: run.chatId, imagePlan: plan, imageReferences: [], artifactTool: true, agent: configuration } as unknown as NormalizedRunRequest;
  const call: ModelToolCall = { id: "image", name: "generate_image", arguments: { prompt: "SYNTHETIC_PRIVATE_IMAGE_PROMPT", image_ids: [] } };
  const dispatch = (accepted = request, selected = run, imageService: Pick<typeof images, "execute"> = images, store = selected.store) =>
    createAgentBuiltinDispatcher({ request: accepted, runId: selected.id, userId: f.userId, store, images: imageService, artifacts });
  return { ...f, accepted: run, request, call, images, artifacts, dispatch, fetchFn, bind, storage, png, async dispose() {
    const objects = await prisma.attachment.findMany({ where: { userId: f.userId }, select: { storageKey: true } });
    await prisma.attachment.deleteMany({ where: { userId: f.userId } });
    await f.dispose();
    await prisma.providerRunBinding.deleteMany({ where: { connectionId: authority.connectionId } });
    await prisma.providerModel.delete({ where: { id: authority.providerModelId } });
    await prisma.providerCredentialVersion.delete({ where: { id: authority.credentialVersionId } });
    await prisma.providerCredential.delete({ where: { id: authority.credentialId } });
    await prisma.providerConnection.delete({ where: { id: authority.connectionId } });
    await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: [...objects.map(row => row.storageKey), ...storage.objects.keys()] } } });
  } };
}

describe("durable Agent authority and accounting", () => {
  afterAll(() => prisma.$disconnect());

  it("settles paid images once across duplicate delivery and lost ACK, with separate usage and immutable artifact assets", async () => {
    const f = await imageFixture();
    try {
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const response = f.fetchFn.getMockImplementation()!;
      f.fetchFn.mockImplementationOnce(async (...args) => { entered(); await waiting; return response(...args); });
      const lostAck = { async execute(...args: Parameters<typeof f.images.execute>) {
        await f.images.execute(...args); throw new Error("lost_ack");
      } };
      const other = createAgentRunStore(prisma, { runId: f.accepted.id, userId: f.userId, configuration });
      const first = f.dispatch(f.request, f.accepted, lostAck)(f.call, new AbortController().signal);
      await started;
      expect(await f.dispatch(f.request, f.accepted, f.images, other)(f.call, new AbortController().signal)).toMatchObject({ status: "error" });
      release();
      const result = await first;
      expect(result.status).toBe("complete");
      expect(await f.dispatch()(f.call, new AbortController().signal)).toEqual(result);
      expect(f.fetchFn).toHaveBeenCalledOnce();
      const workspace = { imagePath: vi.fn<NonNullable<import("../workspace/coordinator").WorkspaceCoordinator["imagePath"]>>()
        .mockRejectedValueOnce(new Error("synthetic_transfer_failure")).mockResolvedValue("/workspace/inbox/messages/fixture/picture.png") };
      const delivery = createAgentBuiltinDispatcher({ request: { ...f.request, workspace: { enabled: true } as NormalizedRunRequest["workspace"] },
        runId: f.accepted.id, userId: f.userId, store: f.accepted.store, images: f.images, workspace });
      expect(await delivery(f.call, new AbortController().signal)).toMatchObject({ status: "complete",
        content: [{ type: "json", value: { workspace_error: "image_workspace_unavailable" } }] });
      expect(await delivery(f.call, new AbortController().signal)).toMatchObject({ status: "complete",
        content: [{ type: "json", value: { workspace_path: "/workspace/inbox/messages/fixture/picture.png" } }] });
      expect(f.fetchFn).toHaveBeenCalledOnce();
      const attachment = await prisma.attachment.findFirstOrThrow({ where: { producerModelRunId: f.accepted.id } });
      expect(await prisma.usageEvent.findMany({ where: { modelRunId: f.accepted.id, imageGeneration: true } }))
        .toMatchObject([{ totalTokens: 14, estimatedCostMicros: 12000, imageToolCallId: attachment.imageToolCallId }]);
      const repository = createPrismaRunRepository(prisma);
      await repository.recordRunUsageEvents({ runId: f.accepted.id, chatId: f.accepted.chatId, userId: f.userId, usageAttributions: [] });
      expect(await f.accepted.store.usage()).toEqual([]);
      expect(await prisma.usageEvent.count({ where: { modelRunId: f.accepted.id, imageGeneration: true } })).toBe(1);
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.accepted.id, eventType: "artifact" } })).toBe(1);
      const stored = await prisma.modelRunToolCall.findFirstOrThrow({ where: { modelRunId: f.accepted.id, toolName: f.call.name } });
      expect(stored.state).toBe("complete"); expect(JSON.stringify(stored)).not.toContain("SYNTHETIC_PRIVATE_IMAGE_PROMPT");
      expect((await f.dispatch()({ ...f.call, id: "same-turn-edit", arguments: { ...f.call.arguments, image_ids: [attachment.id] } }, new AbortController().signal)).status).toBe("complete");
      const page = { ...pageCall, arguments: { ...pageCall.arguments, files: [
        { path: "index.html", mimeType: "text/html", text: '<img src="picture.png" alt="Synthetic picture">' },
        { path: "picture.png", mimeType: "image/png", asset_ref: attachment.id }
      ] } };
      expect((await f.dispatch()(page, new AbortController().signal)).status).toBe("complete");
      const version = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: f.accepted.id } });
      const bundle = await f.artifacts.getPrivateBundle({ ownerUserId: f.userId, artifactId: version.artifactId });
      expect(bundle).not.toBeNull();
      const zip = await f.artifacts.getPrivateZip({ ownerUserId: f.userId, artifactId: version.artifactId });
      expect(readSkillZip(zip!.body).find(file => file.path === "picture.png")!.bytes).toEqual(f.png);
      const inputs = createPrismaWorkspaceCoordinatorRepository(prisma);
      const binding = { chatId: f.accepted.chatId, runId: f.accepted.id, assistantMessageId: f.accepted.assistantMessageId,
        userId: f.userId, projectId: null } as WorkspaceExecutionBinding;
      expect((await inputs.attachments(binding)).map(row => row.attachmentId)).toContain(attachment.id);
      const next = await f.run(); await next.store.arm(null); await f.bind(next.id);
      const later = { ...f.request, imageReferences: [{ attachmentId: attachment.id, messageId: f.accepted.assistantMessageId!, fileName: attachment.fileName, origin: "generated" as const }] };
      expect((await inputs.attachments({ ...binding, runId: next.id, assistantMessageId: next.assistantMessageId! })).map(row => row.attachmentId)).not.toContain(attachment.id);
      await prisma.modelRun.update({ where: { id: next.id }, data: { normalizedRequest: later as unknown as Prisma.InputJsonValue } });
      expect((await inputs.attachments({ ...binding, runId: next.id, assistantMessageId: next.assistantMessageId! })).map(row => row.attachmentId)).toContain(attachment.id);
      expect((await f.dispatch(later, next)({ ...f.call, id: "edit", arguments: { ...f.call.arguments, image_ids: [attachment.id] } }, new AbortController().signal)).status).toBe("complete");
      expect(f.fetchFn).toHaveBeenCalledTimes(3);
      expect((f.fetchFn.mock.calls[2]![1]!.body as FormData).get("image[]")).toBeInstanceOf(Blob);
      expect((await f.storage.getObject(attachment.storageKey)).body).toEqual(f.png);
    } finally { await f.dispose(); }
  });

  it.each(["revoke", "lease", "Stop"])("prevents a paid image dispatch after %s during input preparation", async cause => {
    const f = await imageFixture();
    try {
      const imageService = { async execute(...args: Parameters<typeof f.images.execute>) {
        const options = args[3]!;
        return f.images.execute(args[0], args[1], args[2], { ...options, beforeDispatch: async () => {
          if (cause === "revoke") await f.accepted.store.revoke(false);
          if (cause === "lease") await prisma.agentRunBinding.update({ where: { modelRunId: f.accepted.id }, data: { leaseExpiresAt: new Date(0) } });
          if (cause === "Stop") await prisma.modelRun.update({ where: { id: f.accepted.id }, data: { status: "cancelled" } });
          await options.beforeDispatch!();
        } });
      } };
      await expect(f.dispatch(f.request, f.accepted, imageService)(f.call, new AbortController().signal)).rejects.toThrow();
      expect(f.fetchFn).not.toHaveBeenCalled();
      expect(await prisma.attachment.count({ where: { producerModelRunId: f.accepted.id } })).toBe(0);
    } finally { await f.dispose(); }
  });

  it("does not retry an unknown paid outcome or authorize a foreign image", async () => {
    const f = await imageFixture();
    try {
      const invalid = await f.dispatch()({ ...f.call, id: "foreign", arguments: { ...f.call.arguments, image_ids: [randomUUID()] } }, new AbortController().signal);
      expect(invalid).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "image_reference_unavailable" } }] });
      expect(f.fetchFn).not.toHaveBeenCalled();
      f.fetchFn.mockRejectedValueOnce(new Error("synthetic_network_loss_after_dispatch"));
      const result = await f.dispatch()(f.call, new AbortController().signal);
      expect(result.status).toBe("error");
      expect(await f.dispatch()(f.call, new AbortController().signal)).toEqual(result);
      expect(f.fetchFn).toHaveBeenCalledOnce();
      expect(await prisma.attachment.count({ where: { producerModelRunId: f.accepted.id } })).toBe(0);
      expect(await prisma.usageEvent.count({ where: { modelRunId: f.accepted.id, imageGeneration: true } })).toBe(0);
    } finally { await f.dispose(); }
  });

  it("enforces the image dispatch budget and frozen credential revocation", async () => {
    const f = await imageFixture();
    try {
      for (let n = 0; n < 4; n++) expect((await f.dispatch()({ ...f.call, id: `image-${n}` }, new AbortController().signal)).status).toBe("complete");
      expect(await f.dispatch()({ ...f.call, id: "over-budget" }, new AbortController().signal))
        .toMatchObject({ status: "error", content: [{ type: "json", value: { error: "image_tool_budget_exhausted" } }] });
      expect(f.fetchFn).toHaveBeenCalledTimes(4);
      const next = await f.run(); await next.store.arm(null); await f.bind(next.id);
      await prisma.providerCredentialVersion.update({ where: { id: f.request.imagePlan!.authority.credentialVersionId }, data: { revokedAt: new Date() } });
      expect(await f.dispatch(f.request, next)(f.call, new AbortController().signal))
        .toMatchObject({ status: "error", content: [{ type: "json", value: { error: "image_provider_revoked" } }] });
      expect(f.fetchFn).toHaveBeenCalledTimes(4);
    } finally { await f.dispose(); }
  });

  it("rolls back image publication and usage with a failed receipt without repeating the paid request", async () => {
    const f = await imageFixture();
    try {
      const store = { ...f.accepted.store, async settleBuiltinToolInTransaction(...args: Parameters<typeof f.accepted.store.settleBuiltinToolInTransaction>) {
        await f.accepted.store.settleBuiltinToolInTransaction(...args);
        throw new Error("synthetic_image_receipt_failure");
      } };
      await expect(f.dispatch(f.request, f.accepted, f.images, store)(f.call, new AbortController().signal)).rejects.toThrow("synthetic_image_receipt_failure");
      expect(await prisma.attachment.count({ where: { producerModelRunId: f.accepted.id } })).toBe(0);
      expect(await prisma.usageEvent.count({ where: { modelRunId: f.accepted.id, imageGeneration: true } })).toBe(0);
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.accepted.id, eventType: "artifact" } })).toBe(0);
      expect((await f.dispatch()(f.call, new AbortController().signal)).status).toBe("error");
      expect(f.fetchFn).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });

  it("settles received image bytes, usage and output after Stop without granting Workspace writes", async () => {
    const f = await imageFixture();
    try {
      const response = f.fetchFn.getMockImplementation()!;
      f.fetchFn.mockImplementationOnce(async (...args) => {
        const value = await response(...args);
        await prisma.modelRun.update({ where: { id: f.accepted.id }, data: { status: "cancelled" } });
        await f.accepted.store.revoke(false);
        await prisma.modelRunToolCall.updateMany({ where: { modelRunId: f.accepted.id, toolName: f.call.name }, data: { state: "cancelled" } });
        return value;
      });
      const workspace = { imagePath: vi.fn<NonNullable<import("../workspace/coordinator").WorkspaceCoordinator["imagePath"]>>() };
      const dispatch = createAgentBuiltinDispatcher({ request: { ...f.request, workspace: { enabled: true } as NormalizedRunRequest["workspace"] },
        runId: f.accepted.id, userId: f.userId, store: f.accepted.store, images: f.images, workspace });
      expect((await dispatch(f.call, new AbortController().signal)).status).toBe("complete");
      expect(workspace.imagePath).not.toHaveBeenCalled();
      expect(await prisma.attachment.count({ where: { producerModelRunId: f.accepted.id } })).toBe(1);
      expect(await prisma.usageEvent.count({ where: { modelRunId: f.accepted.id, imageGeneration: true } })).toBe(1);
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.accepted.id, eventType: "artifact" } })).toBe(1);
      await expect(f.dispatch()({ ...f.call, id: "new" }, new AbortController().signal)).rejects.toThrow();
      expect(f.fetchFn).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });

  it("commits an Agent artifact, receipt and output once across concurrent gateway deliveries and a lost acknowledgement", async () => {
    const f = await artifactFixture();
    try {
      const another = createAgentRunStore(prisma, { runId: f.accepted.id, userId: f.userId, configuration });
      const lostAck = { ...f.artifacts, async execute(...args: Parameters<typeof f.artifacts.execute>) {
        await f.artifacts.execute(...args); throw new Error("synthetic_lost_acknowledgement");
      } };
      const first = f.dispatch(f.request, f.accepted, lostAck);
      const second = f.dispatch(f.request, f.accepted, f.artifacts, another);
      const results = await Promise.all([first(pageCall, new AbortController().signal), second(pageCall, new AbortController().signal)]);
      const success = results.find(result => result.status === "complete");
      expect(success).toBeDefined();
      expect(await second(pageCall, new AbortController().signal)).toEqual(success);
      await expect(second({ ...pageCall, arguments: { ...pageCall.arguments, title: "Different" } }, new AbortController().signal))
        .rejects.toThrow("agent_builtin_delivery_conflict");
      const versions = await prisma.artifactVersion.findMany({ where: { sourceModelRunId: f.accepted.id } });
      expect(versions).toHaveLength(1); expect(versions[0]!.status).toBe("READY");
      const events = await prisma.modelRunEvent.findMany({ where: { modelRunId: f.accepted.id, eventType: "artifact" } });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ artifactType: "generated_artifact", payload: { versionId: versions[0]!.id } });
      expect(JSON.stringify(events)).not.toContain("PRIVATE_SYNTHETIC_SOURCE");
      const call = await prisma.modelRunToolCall.findFirstOrThrow({ where: { modelRunId: f.accepted.id, toolName: pageCall.name } });
      expect(call.state).toBe("complete"); expect(JSON.stringify(call.arguments)).not.toContain("PRIVATE_SYNTHETIC_SOURCE");
      expect(await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: f.accepted.id } })).toMatchObject({ toolCalls: 1 });
      await prisma.agentRunBinding.update({ where: { modelRunId: f.accepted.id }, data: { leaseExpiresAt: new Date(0) } });
      await interruptExpiredAgentRun(prisma, { runId: f.accepted.id, userId: f.userId, now: new Date() });
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: f.accepted.id, status: "READY" } })).toBe(1);
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.accepted.id, eventType: "artifact" } })).toBe(1);
    } finally { await f.dispose(); }
  });

  it("reads the accepted Agent version on a later turn, edits once and rejects stale or unaccepted references", async () => {
    const f = await artifactFixture();
    try {
      await f.dispatch()(pageCall, new AbortController().signal);
      const version = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: f.accepted.id } });
      const next = await f.run(); await next.store.arm(null);
      const request = { ...f.request, artifactReferences: [{ artifactId: version.artifactId, versionId: version.id }] };
      const dispatch = f.dispatch(request, next);
      const read = { id: "read", name: "read_artifact", arguments: { artifact_id: version.artifactId } };
      const readResult = await dispatch(read, new AbortController().signal);
      expect(readResult.status).toBe("complete"); expect(JSON.stringify(readResult.content)).toContain("PRIVATE_SYNTHETIC_SOURCE");
      const edit = { id: "edit", name: "create_artifact", arguments: { intent: "update", base_version_id: version.id,
        edits: [{ path: "index.html", old_string: "PRIVATE_SYNTHETIC_SOURCE", new_string: "Updated page" }] } };
      expect((await dispatch(edit, new AbortController().signal)).status).toBe("complete");
      expect(await prisma.artifactVersion.findMany({ where: { artifactId: version.artifactId }, orderBy: { versionNumber: "asc" } }))
        .toMatchObject([{ versionNumber: 1, status: "READY" }, { versionNumber: 2, status: "READY", entrypoint: "index.html" }]);
      expect(await dispatch({ ...edit, id: "stale-edit" }, new AbortController().signal)).toMatchObject({ status: "error",
        content: [{ type: "json", value: { error: "artifact_version_conflict" } }] });
      expect(await f.dispatch(f.request, next)({ ...read, id: "unaccepted-read" }, new AbortController().signal))
        .toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_read_unavailable" } }] });
      expect(await prisma.artifactVersion.count({ where: { artifactId: version.artifactId } })).toBe(2);
    } finally { await f.dispose(); }
  });

  it.each(["revoke", "lease", "Stop", "signal"])("fences Agent artifact settlement after %s during object I/O", async cause => {
    const f = await artifactFixture();
    const controller = new AbortController();
    try {
      f.setBeforePut(async () => {
        if (cause === "revoke") await f.accepted.store.revoke(false);
        if (cause === "lease") await prisma.agentRunBinding.update({ where: { modelRunId: f.accepted.id }, data: { leaseExpiresAt: new Date(0) } });
        if (cause === "Stop") await prisma.modelRun.update({ where: { id: f.accepted.id }, data: { status: "cancelled" } });
        if (cause === "signal") controller.abort();
      });
      await expect(f.dispatch()(pageCall, controller.signal)).rejects.toThrow();
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: f.accepted.id, status: "READY" } })).toBe(0);
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.accepted.id, eventType: "artifact" } })).toBe(0);
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: f.accepted.id, status: "PENDING" } })).toBe(0);
    } finally { await f.dispose(); }
  });

  it("rolls back READY and output when the Agent receipt transaction fails", async () => {
    const f = await artifactFixture();
    try {
      const store = { ...f.accepted.store, async settleBuiltinToolInTransaction(...args: Parameters<typeof f.accepted.store.settleBuiltinToolInTransaction>) {
        await f.accepted.store.settleBuiltinToolInTransaction(...args);
        throw new Error("synthetic_receipt_failure");
      } };
      await expect(f.dispatch(f.request, f.accepted, f.artifacts, store)(pageCall, new AbortController().signal)).rejects.toThrow("synthetic_receipt_failure");
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: f.accepted.id, status: "READY" } })).toBe(0);
      expect(await prisma.modelRunEvent.count({ where: { modelRunId: f.accepted.id, eventType: "artifact" } })).toBe(0);
      expect(await prisma.modelRunToolCall.findFirstOrThrow({ where: { modelRunId: f.accepted.id, toolName: pageCall.name } })).toMatchObject({ state: "error" });
    } finally { await f.dispose(); }
  });

  it("bounds native provider reconnects across stores, retains unknown usage, and resets only after generation succeeds", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null });
    try {
      const run = await f.run(); await run.store.arm(null);
      const another = createAgentRunStore(prisma, { runId: run.id, userId: f.userId,
        configuration: { ...configuration, limitsEnabled: false, timeoutSeconds: null } });
      const attempts: string[] = [];
      for (let index = 0; index < 3; index++) {
        const id = await run.store.reserveProvider(200); attempts.push(id);
        expect(await another.canRetryProvider(id)).toBe(false);
        await run.store.settleProvider(id, index === 1 ? "ERROR" : "UNKNOWN", null);
        // Independently billed search work must not reset the reconnect limit.
        const search = await run.store.reserveProvider(20, { kind: "native_search" });
        await run.store.settleProvider(search, "COMPLETE", { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
        expect(await another.canRetryProvider(id)).toBe(index < 2);
      }
      expect(await run.store.failure()).toBeNull();
      expect(await prisma.agentProviderAttempt.count({ where: { id: { in: attempts }, state: "UNKNOWN" } })).toBe(2);
      expect((await run.store.usage()).filter(item => item.usage.totalTokens === null)).toHaveLength(3);
      const success = await run.store.reserveProvider(200);
      await run.store.settleProvider(success, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
      expect(await another.canRetryProvider(success)).toBe(false);
      expect(await another.canRetryProvider(attempts[0]!)).toBe(false);
      // Distinct persisted timestamps make this a new generation; timestamp
      // ties intentionally consume the previous failures conservatively.
      const completedAt = new Date(Date.now() - 1000);
      await prisma.agentProviderAttempt.updateMany({ where: { id: { in: attempts } }, data: { createdAt: new Date(completedAt.getTime() - 1000) } });
      await prisma.agentProviderAttempt.update({ where: { id: success }, data: { createdAt: completedAt } });
      const next = await run.store.reserveProvider(200);
      await run.store.settleProvider(next, "UNKNOWN", null);
      expect(await another.canRetryProvider(next)).toBe(true);
      await run.store.revoke(false);
      await expect(another.canRetryProvider(next)).rejects.toThrow("agent_authority_expired");
      await expect(another.reserveProvider(200)).rejects.toThrow("agent_authority_expired");
    } finally { await f.dispose(); }
  });

  it("charges each retry against the existing provider-call budget", async () => {
    const f = await fixture();
    try {
      const run = await f.run(); await run.store.arm(null);
      for (let index = 0; index < 2; index++) {
        const attempt = await run.store.reserveProvider(200);
        await run.store.settleProvider(attempt, "UNKNOWN", null);
        expect(await run.store.canRetryProvider(attempt)).toBe(true);
      }
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_model_call_limit");
      expect(await run.store.failure()).toBe("agent_model_call_limit");
      expect(await prisma.agentProviderAttempt.count({ where: { modelRunId: run.id } })).toBe(2);
    } finally { await f.dispose(); }
  });

  it("disables budgets and the deadline without disabling accounting, lease recovery or Stop", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null,
      maxModelCalls: 1, maxToolCalls: 1, tokenBudget: 1 });
    try {
      const run = await f.run();
      await run.store.arm(null);
      for (let i = 0; i < 3; i++) {
        const attempt = await run.store.reserveProvider(200);
        await run.store.settleProvider(attempt, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
        const call = await run.store.toolCall("find_tools", {}, false, `delivery-${i}`);
        await run.store.settleTool(call, "complete", {});
      }
      const binding = await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } });
      expect(binding).toMatchObject({ expiresAt: null, modelCalls: 3, toolCalls: 3, reservedTokens: 36n });
      expect((await run.store.usage()).reduce((sum, value) => sum + value.usage.totalTokens!, 0)).toBe(36);
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() })).toEqual({ kind: "active" });
      await run.store.revoke(false);
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_authority_expired");
    } finally { await f.dispose(); }
  });

  it("counts optional decision work without duplicating independently persisted charges", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null });
    const connectionId = randomUUID(), modelId = randomUUID();
    try {
      // This test also runs on an empty migrated target, independently of seed.
      await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Agent decision fixture", family: "fake",
        models: { create: { id: modelId, provider: "fake", modelId: "fixture", displayName: "Fixture", capabilities: {}, defaultParams: {} } } } });
      const run = await f.run(); await run.store.arm(null);
      const answer = await prisma.providerRunBinding.findUniqueOrThrow({ where: {
        modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" }
      } });
      const snapshot = { ...normalizeProviderExecutionSnapshot(answer.executionSnapshot),
        connectionId, providerModelId: modelId };
      const decisions = createOptionalDecisionRepository(prisma);
      const owner = { userId: f.userId, runId: run.id, purpose: "mcp_discovery" as const, operationKey: "call" };
      const claim = await decisions.start(owner, "b".repeat(64), snapshot);
      if (claim.kind !== "new") throw new Error("fixture_claim_missing");
      const attempt = await run.store.reserveProvider(32_000, { kind: "decision", snapshot });
      await run.store.settleProvider(attempt, "COMPLETE", { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
      await decisions.settle(owner, claim.id, { receipt: { model: "fixture", provider: "fake", requestId: null,
        usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.00001 } }, answers: {}, failureCode: null, dispatched: true });
      expect(await run.store.usage()).toEqual([]);
      expect(await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } }))
        .toMatchObject({ modelCalls: 1, reservedTokens: 24n });
      expect(await prisma.usageEvent.findMany({ where: { modelRunId: run.id } }))
        .toEqual([expect.objectContaining({ optionalDecision: true, totalTokens: 24, estimatedCostMicros: 10 })]);
    } finally {
      await f.dispose();
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  });

  it("keeps the first terminal budget cause through revocation and recovery", async () => {
    const f = await fixture({ ...configuration, tokenBudget: 10 });
    try {
      const run = await f.run(); await run.store.arm(null);
      await expect(run.store.reserveProvider(11)).rejects.toThrow("agent_token_limit");
      await run.store.fail("agent_provider_failed");
      await run.store.revoke(false);
      expect(await run.store.failure()).toBe("agent_token_limit");
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() }))
        .toMatchObject({ kind: "interrupted", failureCode: "agent_token_limit" });
    } finally { await f.dispose(); }
  });

  it("treats MCP exhaustion as a tool error while leaving the remaining model budget available", async () => {
    const f = await fixture({ ...configuration, maxToolCalls: 1 });
    try {
      const run = await f.run(); await run.store.arm(null);
      await run.store.toolCall("find_tools", {});
      await expect(run.store.toolCall("find_tools", {})).rejects.toThrow("agent_mcp_call_limit");
      expect(await run.store.failure()).toBeNull();
      await expect(run.store.reserveProvider(10)).resolves.toEqual(expect.any(String));
    } finally { await f.dispose(); }
  });

  it("keeps an expired time budget when transport cancellation wins the executor race", async () => {
    const f = await fixture();
    try {
      const run = await f.run(); await run.store.arm(null);
      await prisma.agentRunBinding.update({ where: { modelRunId: run.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await run.store.fail("agent_provider_interrupted");
      expect(await run.store.failure()).toBe("agent_time_limit");
    } finally { await f.dispose(); }
  });

  it("reserves source quotas across concurrent bridge instances and separates exact search billing", async () => {
    const f = await fixture({ ...configuration, limitsEnabled: false, timeoutSeconds: null });
    try {
      const run = await f.run(); await run.store.arm(null);
      const answer = await prisma.providerRunBinding.findUniqueOrThrow({ where: { modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" } } });
      const snapshot = answer.executionSnapshot as Record<string, unknown>;
      await prisma.providerRunBinding.create({ data: { modelRunId: run.id, role: "search", bindingKey: "search:source", credentialSource: "default",
        executionSnapshot: { ...snapshot, model: { ...(snapshot.model as object), upstreamModelId: "search-fixture" } } } });
      const results = await Promise.allSettled(["a", "b"].map((invocationId) => run.store.reserveProvider(100,
        { kind: "aiqsa_search", optionId: "source", invocationId, maxCalls: 1 })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const admitted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<string>;
      await run.store.settleProvider(admitted.value, "COMPLETE", { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
      expect((await run.store.usage())[0]).toMatchObject({ modelId: "search-fixture", operationCount: 1, usage: { totalTokens: 9 } });
      const continuation = await run.store.reserveProvider(100, { kind: "aiqsa_search", optionId: "source",
        invocationId: results[0]!.status === "fulfilled" ? "a" : "b", maxCalls: 1 });
      await run.store.revoke(false);
      expect((await run.store.usage())[1]!.usage.totalTokens).toBeNull();
      await run.store.settleProvider(continuation, "COMPLETE", { inputTokens: 2, outputTokens: 2, totalTokens: 4 });
      expect((await run.store.usage())[1]).toMatchObject({ modelId: "search-fixture", operationCount: 1, usage: { totalTokens: 4 } });
      expect(await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: continuation } })).toMatchObject({ state: "UNKNOWN" });
      expect(await run.store.failure()).toBeNull();
    } finally { await f.dispose(); }
  });

  it("allows native search during a generation stream without releasing its slot or changing its provider tuple", async () => {
    const f = await fixture({ ...configuration, maxModelCalls: 4 });
    try {
      const run = await f.run();
      await run.store.arm(null);
      const generation = await run.store.reserveProvider(200);
      const search = await run.store.reserveProvider(200, { kind: "native_search" });
      await run.store.settleProvider(search, "COMPLETE", null);
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_provider_busy");
      const receipts = await prisma.agentProviderAttempt.findMany({ where: { modelRunId: run.id },
        include: { providerBinding: true }, orderBy: { createdAt: "asc" } });
      expect(receipts[1]!.providerBinding.executionSnapshot).toEqual(receipts[0]!.providerBinding.executionSnapshot);
      expect(receipts[1]!.providerBinding.credentialSource).toBe(receipts[0]!.providerBinding.credentialSource);
      expect(receipts[1]!.usage).toMatchObject({ completeness: "unavailable", totalTokens: null });
      await run.store.settleProvider(generation, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
      await expect(run.store.reserveProvider(200)).resolves.toEqual(expect.any(String));
      expect((await run.store.usage()).reduce((sum, item) => sum + (item.operationCount ?? 0), 0)).toBe(3);
    } finally { await f.dispose(); }
  });

  it("can append discovery bindings while an independent usage writer checkpoints the run", async () => {
    const f = await fixture();
    let checkpoint: Promise<boolean> | undefined;
    try {
      const run = await f.run();
      const repository = createPrismaRunRepository(prisma);
      await prisma.$transaction(async (tx) => {
        await lockRunSettlementScope(tx, run.id);
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        checkpoint = repository.recordRunUsageEvents({ runId: run.id, chatId: run.chatId, userId: f.userId,
          usageAttributions: [{ provider: "fake", modelId: "fixture", operationCount: 1,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }] });
        void checkpoint.catch(() => undefined);
        // Wait for the real competing writer to reach this transaction's lock,
        // so the test covers the FK/row-lock cycle instead of relying on timing.
        const deadline = Date.now() + 3000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
          const rows = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
          waiting = rows.length > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        const answer = await tx.providerRunBinding.findUniqueOrThrow({ where: {
          modelRunId_bindingKey: { modelRunId: run.id, bindingKey: "answer" }
        } });
        await tx.providerRunBinding.create({ data: { modelRunId: run.id, bindingKey: "agent-discovery:fixture",
          role: "search", credentialSource: "default", executionSnapshot: answer.executionSnapshot! } });
      });
      expect(await checkpoint).toBe(true);
      expect(await prisma.usageEvent.count({ where: { modelRunId: run.id } })).toBe(1);
    } finally { await checkpoint?.catch(() => undefined); await f.dispose(); }
  });

  it("serializes dispatch, records only trusted usage, and fences revoked or foreign authority", async () => {
    const f = await fixture();
    try {
      const run = await f.run();
      const grant = await run.store.arm(null);
      expect(grant.token).toHaveLength(43);
      const results = await Promise.allSettled([run.store.reserveProvider(200), run.store.reserveProvider(200)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const admitted = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>;
      await run.store.settleProvider(admitted.value, "COMPLETE", { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
      expect((await prisma.agentRunBinding.findUniqueOrThrow({ where: { modelRunId: run.id } })).reservedTokens).toBe(12n);
      await run.store.reserveProvider(200);
      await expect(run.store.reserveProvider(200)).rejects.toThrow("agent_model_call_limit");
      await expect(createAgentRunStore(prisma, { runId: run.id, userId: "foreign", configuration }).assertActive()).rejects.toThrow();
      await run.store.revoke(false);
      await expect(run.store.assertActive()).rejects.toThrow("agent_authority_expired");
      expect(await prisma.agentProviderAttempt.count({ where: { modelRunId: run.id, state: "UNKNOWN" } })).toBe(1);
      expect((await run.store.usage())[0]).toMatchObject({ operationCount: 1, usage: { totalTokens: 12 } });
    } finally { await f.dispose(); }
  });

  it("resumes only a completed predecessor in the same surviving Workspace", async () => {
    const f = await fixture();
    try {
      const first = await f.run();
      await first.store.arm(null);
      const threadId = randomUUID();
      await first.store.setThread(threadId);
      await first.store.revoke(true);
      await prisma.modelRun.update({ where: { id: first.id }, data: { status: "complete" } });
      expect((await (await f.run()).store.arm(first.assistantMessageId)).threadId).toBe(threadId);
      expect((await (await f.run()).store.arm(randomUUID())).threadId).toBeUndefined();
      await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { runtimeSandboxId: null } });
      expect((await (await f.run()).store.arm(first.assistantMessageId)).threadId).toBeUndefined();
    } finally { await f.dispose(); }
  });

  it("never replays a lost executor and preserves ambiguous tool/provider outcomes", async () => {
    const f = await fixture();
    try {
      const run = await f.run();
      await run.store.arm(null);
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() })).toEqual({ kind: "active" });
      const call = await run.store.toolCall("find_tools", {}, false, "delivery-1");
      await expect(run.store.toolCall("find_tools", {}, false, "delivery-1")).rejects.toThrow();
      await prisma.agentRunBinding.update({ where: { modelRunId: run.id }, data: { leaseExpiresAt: new Date(0) } });
      expect(await interruptExpiredAgentRun(prisma, { runId: run.id, userId: f.userId, now: new Date() })).toEqual({ kind: "interrupted", failureCode: "agent_execution_interrupted", usage: [] });
      expect(await prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: call } })).toMatchObject({ state: "error", result: { outcome: "unknown" } });
      await expect(run.store.arm(null)).rejects.toThrow("agent_binding_invalid");
    } finally { await f.dispose(); }
  });
});
