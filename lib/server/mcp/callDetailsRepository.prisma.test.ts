import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { MCP_CALL_DISPLAY_BYTES } from "../../contracts/mcpCallDetails";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import type { StorageAdapter } from "../uploads/storage";
import { OBSERVATION_ENCODING } from "../toolObservations/codec";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { createPrismaMcpCallDetailsRepository } from "./callDetailsRepository";
import { mcpCallDetailsForStorage } from "./callDetailsServices";
import { encryptMcpEnvelope, mcpRuntimeGenerationEnvelopeContext, mcpSharedConfigEnvelopeContext } from "./encryption";
import { validateMcpDraft } from "./definitions";
import { namespacedMcpToolName } from "./runPlan";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const clean of cleanups.splice(0).reverse()) await clean(); }
  finally { vi.unstubAllEnvs(); }
});

const syntheticSecret = "synthetic-call-details-secret";
const syntheticKey = Buffer.alloc(32, 37);

async function fixture(options: { project?: boolean; sensitive?: boolean } = {}) {
  const userIds = Array.from({ length: 3 }, () => randomUUID());
  const [initiatorId, otherId, adminId] = userIds as [string, string, string];
  const serverId = randomUUID();
  const revisionId = randomUUID();
  const generationId = randomUUID();
  const fingerprint = createHash("sha256").update(generationId).digest("hex");
  const namespace = `details_${randomUUID().replaceAll("-", "")}`;
  const toolName = namespacedMcpToolName(namespace, "records");
  const storage = createMemoryStorageAdapter();
  let chatId: string | undefined;
  let projectId: string | undefined;
  cleanups.push(async () => {
    if (chatId) {
      await prisma.modelRun.deleteMany({ where: { chatId } });
      await prisma.chat.updateMany({ where: { id: chatId }, data: { activeLeafMessageId: null } });
      await prisma.message.deleteMany({ where: { chatId } });
      await prisma.chat.deleteMany({ where: { id: chatId } });
    }
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.mcpRuntimeGeneration.deleteMany({ where: { revisionId } });
    await prisma.mcpUserServer.deleteMany({ where: { serverId } });
    await prisma.mcpRevision.deleteMany({ where: { serverId } });
    await prisma.mcpServer.deleteMany({ where: { id: serverId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { in: [...storage.objects.keys()] } } });
  });
  await prisma.user.createMany({ data: userIds.map(id => ({
    id, displayName: "Synthetic MCP details member", status: "active", role: id === adminId ? "admin" : "user"
  })) });
  if (options.project) {
    const project = await prisma.project.create({ data: {
      name: "Synthetic MCP details Project", createdByUserId: otherId, createdByDisplayName: "Project Owner",
      grants: { create: [{ userId: otherId, role: "OWNER" }, { userId: initiatorId, role: "CONTRIBUTOR" },
        { userId: adminId, role: "VIEWER" }] }
    } });
    projectId = project.id;
  }
  const configuration = {
    auth: { mode: options.sensitive ? "static" : "none" },
    runtime: { startupTimeoutMs: 30_000, callTimeoutMs: 30_000 },
    source: { kind: "remote", url: "https://mcp.example.test/rpc" }, transport: "streamable_http",
    slots: options.sensitive ? [{ label: "Authorization", sensitive: true, slotKey: "authorization", valueType: "secret",
      policy: { kind: "shared", allowPersonalOverride: false }, target: { kind: "header", name: "Authorization" } }] : []
  };
  expect(validateMcpDraft(configuration).ok).toBe(true);
  await prisma.mcpServer.create({ data: { id: serverId, namespace, displayName: "Synthetic Records", enabled: true } });
  await prisma.mcpRevision.create({ data: { id: revisionId, serverId, revisionNumber: 1, configuration,
    validationEvidence: {}, draftHash: "a".repeat(64), identityHash: "b".repeat(64) } });
  await prisma.mcpServer.update({ where: { id: serverId }, data: { activeRevisionId: revisionId } });
  await prisma.mcpGrant.createMany({ data: userIds.map(userId => ({ serverId, userId, canUse: true })) });
  const userServer = await prisma.mcpUserServer.create({ data: { serverId, userId: initiatorId, enabled: true } });
  await prisma.mcpUserServer.createMany({ data: [otherId, adminId].map(userId => ({ serverId, userId, enabled: true })) });
  if (projectId) {
    await prisma.projectMcpBinding.create({ data: { projectId, serverId } });
    await prisma.mcpSharedRuntime.create({ data: { serverId } });
  }
  if (options.sensitive) vi.stubEnv("AIQSA_ENCRYPTION_KEY", syntheticKey.toString("base64"));
  await prisma.mcpRuntimeGeneration.create({ data: {
    id: generationId, revisionId, fingerprint, state: "ready",
    ...(projectId ? { sharedServerId: serverId } : { userServerId: userServer.id }),
    ...(options.sensitive ? { effectiveConfigEnvelope: encryptMcpEnvelope({ version: 1,
      values: { authorization: syntheticSecret } }, syntheticKey, mcpRuntimeGenerationEnvelopeContext(generationId, fingerprint)) } : {})
  } });
  const chat = await prisma.chat.create({ data: {
    title: "Historical MCP details", memoryMode: "EXCLUDED", userId: projectId ? null : initiatorId,
    ...(projectId ? { projectId, createdByUserId: initiatorId, createdByDisplayName: "Synthetic MCP details member" } : {})
  } });
  chatId = chat.id;
  const acceptedRequest = {
    workspace: { enabled: true },
    mcp: { version: 1, servers: [{ serverId, revisionId, fingerprint, serverName: "Synthetic Records" }],
      tools: [{ namespacedName: toolName, originalName: "records", serverId, serverName: "Synthetic Records" }] }
  };
  const makeCall = async (callOptions: {
    name?: string; agent?: boolean; bound?: boolean; fingerprint?: string;
  } = {}) => {
    const name = callOptions.name ?? toolName;
    const question = await prisma.message.create({ data: {
      chatId: chat.id, role: "user", status: "complete", content: textMessageContent("Synthetic request"),
      ...(projectId ? { authorUserId: initiatorId, authorDisplayName: "Synthetic MCP details member",
        authorProjectRole: "CONTRIBUTOR" as const } : {})
    } });
    const answer = await prisma.message.create({ data: {
      chatId: chat.id, parentMessageId: question.id, role: "assistant", status: "complete", content: textMessageContent("Historical answer")
    } });
    const run = await prisma.modelRun.create({ data: {
      chatId: chat.id, userId: initiatorId, userMessageId: question.id, assistantMessageId: answer.id,
      modelId: "fake-qsa", provider: "fake", status: "complete",
      normalizedRequest: { ...acceptedRequest, ...(callOptions.agent ? { agent: {} } : {}) },
      ...(projectId ? { projectRunBinding: { create: {
        projectId, initiatorUserId: initiatorId, acceptedRole: "CONTRIBUTOR", accessRevision: 1,
        policyRevision: 1, instructionsRevision: 1, memoryRevision: 0, personalMemoryDisabled: true
      } } } : {})
    } });
    const binding = callOptions.bound === false ? null : await prisma.mcpRunBinding.create({ data: {
      modelRunId: run.id, runtimeGenerationId: generationId,
      runtimeGenerationFingerprint: callOptions.fingerprint ?? fingerprint
    } });
    const call = await prisma.modelRunToolCall.create({ data: {
      modelRunId: run.id, mcpRunBindingId: binding?.id, roundIndex: 2, ordinal: 3, providerCallId: "synthetic-provider-call",
      toolName: name, arguments: { query: "Synthetic request", ...(options.sensitive ? { authorization: syntheticSecret } : {}) },
      result: { callId: "synthetic-provider-call", name, status: "complete", content: [
        { type: "text", text: options.sensitive ? `Synthetic response ${syntheticSecret}` : "Historical full response" },
        { type: "json", value: { count: 7 } }
      ], rawPreview: { isError: false, unsupportedContentTypes: ["image", "resource"] } }, state: "complete"
    } });
    return { call, key: { runId: run.id, roundIndex: 2, ordinal: 3, userId: initiatorId } };
  };
  const saved = await makeCall();
  const observation = async (mode: "INLINE" | "OBJECT", text: string, mismatched = false) => {
    const original = { text: [text], structuredContent: { count: 11 }, isError: false, unsupportedContentTypes: ["image"] };
    const bytes = Buffer.from(JSON.stringify(original));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const id = randomUUID().replaceAll("-", "");
    const storageKey = `tool-observations/v1/${id}`;
    if (mode === "OBJECT") await storage.putObject({ storageKey, body: bytes, contentType: "application/json" });
    await prisma.toolObservation.create({ data: {
      id, modelRunId: saved.key.runId, toolCallId: saved.call.id, formatVersion: 1, sourceKind: "mcp",
      sourceBinding: { version: 1, source: "mcp", serverId, revisionId, fingerprint,
        originalName: mismatched ? "another_tool" : "records" },
      state: "READY", executionOutcome: "complete", reservedBytes: bytes.length, byteSize: bytes.length, checksum,
      storageMode: mode, ...(mode === "INLINE" ? { inlineText: bytes.toString("utf8") } : { storageKey }), maskable: true
    } });
    await prisma.modelRunToolCall.update({ where: { id: saved.call.id }, data: { result: {
      callId: saved.call.providerCallId, name: toolName, status: "complete", content: [{ type: "text", text: "Preview only" }],
      observation: { version: 1, handle: `tor1_${id}`, source: "mcp", encoding: OBSERVATION_ENCODING,
        byteSize: bytes.length, checksum, sourceTruncated: false, maskable: true }
    } } });
    return { bytes, storageKey };
  };
  return { ...saved, initiatorId, otherId, adminId, serverId, projectId, chat, generationId,
    makeCall, observation, storage, repository: createPrismaMcpCallDetailsRepository(prisma),
    read: mcpCallDetailsForStorage(prisma, storage) };
}

describe("Prisma MCP call details authority and historical display", () => {
  it("reads completed historical inline calls for the initiator and denies other users, administrators and missing calls", async () => {
    const f = await fixture();
    expect(await f.repository.read(f.key)).toMatchObject({ state: "complete", values: [], observation: null });
    expect(await f.read(f.key)).toMatchObject({ requestState: "available", responseState: "available", isError: false,
      response: { text: 'Historical full response\n\n{\n  "count": 7\n}', truncated: false }, unsupportedContentTypes: ["image", "resource"] });
    for (const userId of [f.otherId, f.adminId]) {
      expect(await f.repository.read({ ...f.key, userId })).toBeNull();
      expect(await f.read({ ...f.key, userId })).toBeNull();
    }
    expect(await f.repository.read({ ...f.key, ordinal: 4 })).toBeNull();
    expect(await f.repository.read({ ...f.key, runId: randomUUID() })).toBeNull();
    await prisma.chat.update({ where: { id: f.chat.id }, data: { archived: true } });
    expect(await f.read(f.key)).toMatchObject({ requestState: "available", responseState: "available" });
    await prisma.user.update({ where: { id: f.initiatorId }, data: { status: "disabled" } });
    expect(await f.repository.read(f.key)).toBeNull();
    expect(await f.read(f.key)).toBeNull();
  });

  it("keeps Project calls initiator-only even for the Owner and an administrator with Viewer access", async () => {
    const f = await fixture({ project: true });
    expect(await f.read(f.key)).toMatchObject({ responseState: "available" });
    for (const userId of [f.otherId, f.adminId]) {
      expect(await f.repository.read({ ...f.key, userId })).toBeNull();
      expect(await f.read({ ...f.key, userId })).toBeNull();
    }
    await prisma.mcpToolAccessPolicy.create({ data: { serverId: f.serverId, toolName: "records", restricted: true,
      users: { create: { userId: f.initiatorId } } } });
    expect(await f.read(f.key)).toMatchObject({ responseState: "available" });
    await prisma.projectGrant.delete({ where: { projectId_userId: { projectId: f.projectId!, userId: f.initiatorId } } });
    expect(await f.read(f.key)).toBeNull();
  });

  it("rejects every native origin, prefix-only names, missing/mismatched MCP bindings and Agent runs", async () => {
    const f = await fixture();
    for (const name of ["find_tools", "memory_search", "load_skill", "search_knowledge", "search", "generate_image",
      "create_artifact", "session", namespacedWorkspaceToolName("sandbox_fs_read"), "mcp_prefix_only"]) {
      const rejected = await f.makeCall({ name });
      expect(await f.repository.read(rejected.key)).toBeNull();
    }
    for (const options of [{ agent: true }, { bound: false }, { fingerprint: "c".repeat(64) }]) {
      const rejected = await f.makeCall(options);
      expect(await f.repository.read(rejected.key)).toBeNull();
      expect(await f.read(rejected.key)).toBeNull();
    }
  });

  it.each(["INLINE", "OBJECT"] as const)("reads the exact %s observation rather than its preview", async mode => {
    const f = await fixture();
    const text = mode === "INLINE" ? "Exact original observation" : "🙂".repeat(20_000);
    const original = await f.observation(mode, text);
    const streamRead = vi.spyOn(f.storage, "getObjectStream");
    const result = await f.read(f.key);
    expect(result).toMatchObject({ requestState: "available", responseState: "available", unsupportedContentTypes: ["image"] });
    expect(result?.response?.text).not.toContain("Preview only");
    if (mode === "INLINE") {
      expect(result?.response?.text).toBe('Exact original observation\n\n{\n  "count": 11\n}');
      expect(streamRead).not.toHaveBeenCalled();
    } else {
      expect(result?.response?.truncated).toBe(true);
      expect(result?.response?.byteSize).toBe(Buffer.byteLength(text + '\n\n{\n  "count": 11\n}'));
      expect(Buffer.byteLength(result!.response!.text)).toBeLessThanOrEqual(MCP_CALL_DISPLAY_BYTES);
      expect(result?.response?.text).not.toContain("�");
      expect(streamRead).toHaveBeenCalledWith(original.storageKey, expect.objectContaining({ requireStreaming: true, maxBytes: original.bytes.length }));
    }
  });

  it("refuses an observation with a different accepted source identity", async () => {
    const f = await fixture();
    await f.observation("INLINE", "Wrong tool private original", true);
    expect((await f.repository.read(f.key))?.observation).toBeNull();
    expect(await f.read(f.key)).toMatchObject({ responseState: "unavailable", response: null });
  });

  it.each(["grant", "tool", "project", "user"])("suppresses an OBJECT result when %s access is revoked during streaming I/O", async authority => {
    const f = await fixture({ project: authority === "project" });
    const original = await f.observation("OBJECT", "Original before revocation ".repeat(500));
    const revoke = async () => {
      if (authority === "grant") await prisma.mcpGrant.delete({ where: { serverId_userId: {
        serverId: f.serverId, userId: f.initiatorId } } });
      else if (authority === "tool") await prisma.mcpToolAccessPolicy.create({ data: {
        serverId: f.serverId, toolName: "records", restricted: true
      } });
      else if (authority === "user") await prisma.user.update({ where: { id: f.initiatorId }, data: { status: "disabled" } });
      else await prisma.projectGrant.delete({ where: { projectId_userId: { projectId: f.projectId!, userId: f.initiatorId } } });
    };
    let bytesDelivered = 0;
    const streamRead = vi.fn<NonNullable<StorageAdapter["getObjectStream"]>>(async (storageKey, options) => {
      expect(options).toMatchObject({ requireStreaming: true, maxBytes: original.bytes.length });
      let offset = 0;
      return { storageKey, byteSize: original.bytes.length, contentType: "application/json",
        body: new ReadableStream<Uint8Array>({ async pull(controller) {
          if (offset === 0) await revoke();
          if (offset === original.bytes.length) { controller.close(); return; }
          const chunk = original.bytes.subarray(offset, offset + 127);
          offset += chunk.length; bytesDelivered += chunk.length; controller.enqueue(chunk);
        } }) };
    });
    const read = mcpCallDetailsForStorage(prisma, { ...f.storage, getObjectStream: streamRead,
      getObject: async () => { throw new Error("buffered_storage_read_forbidden"); } });
    expect(await read(f.key)).toBeNull();
    expect(streamRead).toHaveBeenCalledOnce();
    expect(bytesDelivered).toBe(original.bytes.length);
    expect(await f.repository.read(f.key)).toBeNull();
  });

  it("redacts the accepted generation's configured secret in both sections", async () => {
    const f = await fixture({ sensitive: true });
    expect((await f.repository.read(f.key))?.values).toEqual([syntheticSecret]);
    const result = await f.read(f.key);
    expect(result).toMatchObject({ requestState: "available", responseState: "available" });
    expect(result?.request?.text).toContain("[REDACTED]");
    expect(result?.response?.text).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  });

  const setSharedSecret = (serverId: string, value: string, version: number) => prisma.mcpServer.update({ where: { id: serverId }, data: {
    sharedConfigVersion: version, sharedConfigEnvelope: encryptMcpEnvelope({ version: 1, values: { authorization: value } },
      syntheticKey, mcpSharedConfigEnvelopeContext(serverId, version)) } });
  const redactedResponse = (f: Awaited<ReturnType<typeof fixture>>) => prisma.modelRunToolCall.update({ where: { id: f.call.id }, data: { result: {
    callId: f.call.providerCallId, name: f.call.toolName, status: "complete",
    content: [{ type: "text", text: "Saved [REDACTED] response" }]
  } } });

  it("shows the request after the accepted generation was deleted, redacted by the current secret value", async () => {
    const f = await fixture({ sensitive: true });
    await setSharedSecret(f.serverId, syntheticSecret, 1);
    await redactedResponse(f);
    await prisma.mcpRuntimeGeneration.delete({ where: { id: f.generationId } });
    expect(await f.repository.read(f.key)).toMatchObject({ values: [syntheticSecret] });
    const result = await f.read(f.key);
    expect(result).toMatchObject({ requestState: "available", responseState: "available",
      response: { text: "Saved [REDACTED] response" } });
    expect(result?.request?.text).toBe('{\n  "query": "Synthetic request",\n  "authorization": "[REDACTED]"\n}');
    expect(JSON.stringify(result)).not.toContain(syntheticSecret);
  });

  it("shows the request with no known values and accepts a rotated old secret the model put into the arguments", async () => {
    const f = await fixture({ sensitive: true });
    await redactedResponse(f);
    await prisma.mcpRuntimeGeneration.delete({ where: { id: f.generationId } });
    expect(await f.repository.read(f.key)).toMatchObject({ values: [] });
    expect(await f.read(f.key)).toMatchObject({ requestState: "available" });
    // Operator decision 2026-09-30: the rotated value is no longer known and
    // may appear, only to the initiator who owns it. The current one is redacted.
    const rotated = "synthetic-rotated-call-details-secret";
    await setSharedSecret(f.serverId, rotated, 2);
    await prisma.modelRunToolCall.update({ where: { id: f.call.id }, data: {
      arguments: { query: "Synthetic request", authorization: syntheticSecret, current: rotated } } });
    const result = await f.read(f.key);
    expect(result?.request?.text).toContain(`"authorization": "${syntheticSecret}"`);
    expect(result?.request?.text).toContain('"current": "[REDACTED]"');
    expect(JSON.stringify(result)).not.toContain(rotated);
    for (const userId of [f.otherId, f.adminId]) expect(await f.read({ ...f.key, userId })).toBeNull();
  });
});
