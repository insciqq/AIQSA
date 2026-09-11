// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/server/prisma";
import { textMessageContent } from "@/lib/domain/content";
import { WORKSPACE_MCP_TOOL_ALLOWLIST, WORKSPACE_POLICY_ID, workspaceMessageManifestPath, workspaceRunOutputDirectory, workspaceSandboxName } from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { admitPreparingRunWithClient } from "@/lib/server/runs/prismaRepositoryPreparation";
import type { PreparingRunAdmissionInput } from "@/lib/server/runs/runRepositoryContract";
import { getWorkspaceConfig } from "../config";
import { createPrismaWorkspaceCoordinatorRepository } from "../coordinator";
import { namespacedWorkspaceToolName } from "../toolCatalog";
import { bindWorkspaceSecrets, createWorkspaceSecretStore, decryptWorkspaceSecret, lockWorkspaceSecretOwner } from "./store";
import { saveWorkspaceBrowserSessions, type WorkspaceBrowserSaveInput } from "./browserStore";
import { decodeWorkspaceSecretList } from "@/lib/contracts/workspaceSecrets";

const key = Buffer.alloc(32, 37);
const users: string[] = [];
const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const definitions = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => ({
  description: `Synthetic ${originalName}`, inputSchema: { type: "object" }, namespacedName: namespacedWorkspaceToolName(originalName), originalName
}));
const store = () => createWorkspaceSecretStore(prisma, { key: () => key, validateSshKey: vi.fn(async () => undefined) });

async function owner() {
  const id = `workspace-secret-test-${randomUUID()}`;
  await prisma.user.create({ data: { id, displayName: "Synthetic Workspace secrets", status: "active" } });
  users.push(id);
  await prisma.userMemorySettings.update({ where: { userId: id }, data: { useMemoryFacts: false, learnAutomatically: false, referenceChatHistory: false } });
  return id;
}

async function plan(userId: string): Promise<PreparingRunAdmissionInput> {
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic secrets admission", workspaceEnabled: true } });
  const runId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  const sessionId = `ws_${randomBytes(20).toString("hex")}`;
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: WORKSPACE_POLICY_ID } });
  const normalized = {
    enabled: true as const, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
    maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds, mcpVersion: "0.6.16",
    messageManifestPath: workspaceMessageManifestPath(userMessageId), outputDirectory: workspaceRunOutputDirectory(runId),
    projectDirectory: "/workspace/project", runtimeVersion: "0.6.16", sessionId,
    syncToolTimeoutSeconds: config.syncToolTimeoutSeconds, toolCatalogHash: hashCanonicalMcpValue(definitions), turnTimeoutSeconds: config.turnTimeoutSeconds
  };
  const content = textMessageContent("Use my synthetic Workspace access");
  return {
    admissionKind: "NORMAL_SEND", chatId: chat.id, content, expectedActiveLeafId: null, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId, workspaceEnabled: true,
    normalizedRequest: {
      attachmentIds: [], chatId: chat.id, content, knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", workspace: normalized
    },
    workspaceAdmissionPlan: {
      assistantMessageId, chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), normalized,
      policyRevision: policy.version, runId, sandboxName: workspaceSandboxName(sessionId), sessionId, toolDefinitions: definitions, userMessageId
    }
  };
}

function browserBytes(value = "synthetic-session") {
  return Buffer.from(JSON.stringify({ cookies: [{ name: "session", value, domain: "shop.example", path: "/", expires: -1,
    httpOnly: true, secure: true, sameSite: "Lax" }], origins: [] }) + "\r\n");
}

async function browserRun(userId: string): Promise<WorkspaceBrowserSaveInput> {
  const run = await admitPreparingRunWithClient(prisma, await plan(userId));
  const binding = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.runId } });
  const session = await prisma.workspaceSession.update({ where: { id: binding.workspaceSessionId },
    data: { state: "RUNNING", runtimeSandboxId: `synthetic_${randomUUID()}` } });
  return { userId, runId: run.runId, sessionId: session.id, runtimeSandboxId: session.runtimeSandboxId!,
    operation: { owner: session.operationOwner!, generation: session.version }, files: [], skipped: [] };
}

const saveBrowser = (input: WorkspaceBrowserSaveInput, value = "synthetic-session") => saveWorkspaceBrowserSessions(prisma,
  { ...input, files: [{ fileName: "shop.example.json", bytes: browserBytes(value) }] }, () => key);

describe("persisted personal Workspace secrets", () => {
  let originalPolicy: Awaited<ReturnType<typeof prisma.workspacePolicy.findUnique>>;
  beforeAll(async () => {
    originalPolicy = await prisma.workspacePolicy.findUnique({ where: { id: WORKSPACE_POLICY_ID } });
    await prisma.workspacePolicy.upsert({ where: { id: WORKSPACE_POLICY_ID }, create: { id: WORKSPACE_POLICY_ID, enabled: true }, update: { enabled: true } });
  });
  afterEach(async () => {
    const ids = users.splice(0);
    const chats = await prisma.chat.findMany({ select: { id: true }, where: { userId: { in: ids } } });
    const chatIds = chats.map(({ id }) => id);
    await prisma.modelRun.deleteMany({ where: { userId: { in: ids } } });
    await prisma.chat.updateMany({ where: { id: { in: chatIds } }, data: { activeLeafMessageId: null } });
    await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  afterAll(async () => {
    if (originalPolicy) await prisma.workspacePolicy.update({ where: { id: WORKSPACE_POLICY_ID }, data: { enabled: originalPolicy.enabled } });
    else await prisma.workspacePolicy.deleteMany({ where: { id: WORKSPACE_POLICY_ID } });
    await prisma.$disconnect();
  });

  it("stores fifty write-only browser sessions independently of ordinary secret limits and cascades account deletion", async () => {
    const userId = await owner();
    const instance = store();
    for (let index = 0; index < 32; index++) await instance.mutate(userId, {
      action: "create", name: `Access ${index}`, description: "", value: { kind: "text", text: "synthetic" }
    });
    for (let index = 0; index < 50; index++) await instance.mutate(userId, {
      action: "create", name: `Site ${index}`, description: "", value: { kind: "browser_session", originalName: `site-${index}.json`, base64: browserBytes().toString("base64") }
    });
    const rows = await instance.list(userId);
    expect(rows).toHaveLength(82);
    expect(decodeWorkspaceSecretList(rows)).toEqual(rows);
    expect(rows.filter((entry) => entry.browserSession).every((entry) => entry.byteSize === browserBytes().length && !entry.browserSession!.autoSaved)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/synthetic-session|base64|payloadEnvelope/);
    await expect(instance.mutate(userId, { action: "create", name: "Overflow", description: "",
      value: { kind: "browser_session", originalName: "overflow.json", base64: browserBytes().toString("base64") } })).rejects.toThrow("workspace_secret_limit");
    await expect(instance.mutate(userId, { action: "create", name: "Duplicate", description: "",
      value: { kind: "browser_session", originalName: "site-0.json", base64: browserBytes().toString("base64") } })).rejects.toThrow("workspace_browser_session_conflict");
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.workspaceSecretValue.count({ where: { userId } })).toBe(0);
  });

  it("orders cache saves by accepted run, skips unchanged encryption and prevents deleted sessions from returning", async () => {
    const userId = await owner();
    const first = await browserRun(userId);
    expect(await saveBrowser(first)).toMatchObject({ saved: 1 });
    const [initial] = await store().list(userId);
    expect(initial).toMatchObject({ name: "shop.example", browserSession: { autoSaved: true } });
    const second = await browserRun(userId);
    const unusedKey = vi.fn(() => key);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...second, files: [{ fileName: "shop.example.json", bytes: browserBytes() }] }, unusedKey))
      .toMatchObject({ saved: 0, unchanged: 1 });
    expect(unusedKey).not.toHaveBeenCalled();
    expect((await store().list(userId))[0]!.versionId).toBe(initial!.versionId);
    expect(await saveBrowser(first, "stale-cookie")).toMatchObject({ saved: 0, skipped: { browser_session_stale: 1 } });
    expect(await saveBrowser(second, "new-cookie")).toMatchObject({ saved: 1 });
    const [current] = await store().list(userId);
    await store().mutate(userId, { action: "delete", id: current!.id, expectedVersionId: current!.versionId });
    expect(await saveBrowser(second, "must-not-return")).toMatchObject({ saved: 0, skipped: { browser_session_stale: 1 } });
    expect(await store().list(userId)).toEqual([]);
    const accepted = await prisma.workspaceRunSecret.findMany({ where: { modelRunId: second.runId }, include: { value: true } });
    expect(accepted).toHaveLength(1);
    expect(decryptWorkspaceSecret(accepted[0]!.value, userId, key).value).toEqual({ kind: "browser_session", originalName: "shop.example.json", base64: browserBytes().toString("base64") });
    const third = await browserRun(userId);
    expect(await saveBrowser(third, "fresh-login")).toMatchObject({ saved: 1 });
    expect((await store().list(userId))[0]!.id).not.toBe(initial!.id);
    await expect(prisma.workspaceRunBinding.update({ where: { modelRunId: first.runId }, data: { browserSessionSequence: 1000n } })).rejects.toThrow();
  });

  it("records only safe skip codes and rejects foreign, stale and Workspace-Off authority", async () => {
    const userId = await owner(), foreignUserId = await owner();
    const input = await browserRun(userId);
    expect(await saveBrowser({ ...input, userId: foreignUserId })).toBeNull();
    expect(await saveBrowser({ ...input, operation: { ...input.operation, generation: input.operation.generation + 1 } })).toBeNull();
    const offPlan = await plan(userId);
    const off = await admitPreparingRunWithClient(prisma, { ...offPlan, workspaceEnabled: false, workspaceAdmissionPlan: undefined,
      normalizedRequest: { ...offPlan.normalizedRequest, workspace: undefined } });
    expect(await saveBrowser({ ...input, runId: off.runId })).toBeNull();
    const report = await saveWorkspaceBrowserSessions(prisma, { ...input, files: [
      { fileName: "../synthetic-private.json", bytes: browserBytes() },
      { fileName: "broken.json", bytes: Buffer.from("not JSON") },
      { fileName: "large.json", bytes: Buffer.alloc(512 * 1024 + 1) },
      { fileName: "shop.example.json", bytes: browserBytes() }
    ] }, () => key);
    expect(report).toEqual({ saved: 1, unchanged: 0, skipped: { browser_session_invalid: 2, browser_session_too_large: 1 } });
    const row = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: input.runId } });
    expect(row.browserSessionSave).toEqual(report);
    expect(JSON.stringify(row.browserSessionSave)).not.toMatch(/synthetic|shop|cookies|base64/);
    expect(await store().list(foreignUserId)).toEqual([]);
  });

  it("accepts only an active run's exact foreground handoff lease and excludes subsequent export recovery", async () => {
    const userId = await owner();
    const input = await browserRun(userId);
    const claim = await createPrismaWorkspaceCoordinatorRepository(prisma).claimExport({ handoff: true, leaseMs: 60_000,
      runId: input.runId, sessionId: input.sessionId, runtimeSandboxId: input.runtimeSandboxId, operation: input.operation });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("synthetic_handoff_not_claimed");
    const handoff = { ...input, operation: claim.operation };
    expect(await saveBrowser(handoff)).toBeNull();
    expect(await saveBrowser({ ...handoff, handoffToken: "incorrect" })).toBeNull();
    expect(await saveBrowser({ ...handoff, handoffToken: claim.token })).toMatchObject({ saved: 1 });
    await prisma.$transaction(async (tx) => {
      await tx.memoryRetrievalAttempt.updateMany({ where: { modelRunId: input.runId }, data: { state: "CANCELLED", errorCode: "fixture_preparation_cancelled" } });
      const run = await tx.modelRun.findUniqueOrThrow({ where: { id: input.runId }, select: { assistantMessageId: true } });
      await tx.message.update({ where: { id: run.assistantMessageId! }, data: { status: "complete", content: textMessageContent("Synthetic task complete") } });
      await tx.modelRun.update({ where: { id: input.runId }, data: { status: "complete", normalizedRequest: {} } });
    });
    expect(await saveBrowser({ ...handoff, handoffToken: claim.token }, "must-not-export")).toBeNull();
  });

  it("fences an old autosave queued behind a manual deletion under the owner lock", async () => {
    const userId = await owner();
    const input = await browserRun(userId);
    await saveBrowser(input);
    const [current] = await store().list(userId);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const blocker = prisma.$transaction(async (tx) => { await lockWorkspaceSecretOwner(tx, userId); locked(); await gate; }, { timeout: 10_000 });
    await ready;
    const waitForBlocked = (count: number) => vi.waitFor(async () => {
      const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"User"%'`;
      expect(Number(row!.count)).toBeGreaterThanOrEqual(count);
    }, { interval: 10, timeout: 1_500 });
    const removal = store().mutate(userId, { action: "delete", id: current!.id, expectedVersionId: current!.versionId });
    let saved: ReturnType<typeof saveBrowser> | undefined;
    try {
      await waitForBlocked(1);
      saved = saveBrowser(input, "stale-after-delete");
      await waitForBlocked(2);
    } finally {
      release();
      await Promise.allSettled([blocker, removal, ...(saved ? [saved] : [])]);
    }
    await removal;
    expect(await saved!).toMatchObject({ skipped: { browser_session_stale: 1 } });
    expect(await store().list(userId)).toEqual([]);
  });

  it("persists all four types, preserves exact bytes and write-only metadata across restart, and cascades account deletion", async () => {
    const userId = await owner();
    const otherId = await owner();
    const instance = store();
    const values = [
      { kind: "ssh_key" as const, privateKey: "synthetic validated key", passphrase: "synthetic passphrase" },
      { kind: "env" as const, entries: [{ name: "TOKEN", value: "'\"$HOME`command`\nПривет" }] },
      { kind: "text" as const, text: "synthetic password\r\nsecond line" },
      { kind: "file" as const, originalName: "credentials.bin", base64: Buffer.from([0, 255, 13, 10]).toString("base64") }
    ];
    for (const value of values) await instance.mutate(userId, { action: "create", name: value.kind, description: "Purpose", value });
    const metadata = await store().list(userId);
    expect(metadata).toHaveLength(4);
    expect(JSON.stringify(metadata)).not.toMatch(/synthetic password|synthetic passphrase|synthetic validated key|\$HOME|payloadEnvelope/);
    const stored = await prisma.workspaceSecretValue.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    expect(stored.map((row) => decryptWorkspaceSecret(row, userId, key).value)).toEqual(values);
    const first = metadata[0]!;
    await instance.mutate(userId, { action: "update", id: first.id, expectedVersionId: first.versionId, name: "Renamed key", description: "Updated purpose", value: { action: "preserve" } });
    const renamed = (await instance.list(userId)).find(({ id }) => id === first.id)!;
    expect(renamed).toMatchObject({ id: first.id, name: "Renamed key" });
    expect(renamed.versionId).not.toBe(first.versionId);
    await expect(instance.mutate(otherId, { action: "delete", id: first.id, expectedVersionId: renamed.versionId })).rejects.toThrow("workspace_secret_conflict");
    expect(await instance.list(otherId)).toEqual([]);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.workspaceSecret.count({ where: { userId } })).toBe(0);
    expect(await prisma.workspaceSecretValue.count({ where: { userId } })).toBe(0);
  });

  it("serializes conflicting env writes and rejects stale replacement without changing the saved value", async () => {
    const userId = await owner();
    const instance = store();
    const results = await Promise.allSettled(["one", "two"].map((name) => instance.mutate(userId, {
      action: "create", name, description: "", value: { kind: "env", entries: [{ name: "SAME_NAME", value: name }] }
    })));
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const [saved] = await instance.list(userId);
    await expect(instance.mutate(userId, { action: "update", id: saved!.id, expectedVersionId: randomUUID(), name: "Stale", description: "",
      value: { action: "replace", content: { kind: "env", entries: [{ name: "SAME_NAME", value: "replacement" }] } } })).rejects.toThrow("workspace_secret_conflict");
    expect(await instance.list(userId)).toEqual([saved]);
  });

  it("enforces account state and the total entry bound without deleting existing values", async () => {
    const userId = await owner();
    const instance = store();
    for (let index = 0; index < 32; index++) await instance.mutate(userId, {
      action: "create", name: `Entry ${index}`, description: "", value: { kind: "text", text: "synthetic" }
    });
    await expect(instance.mutate(userId, { action: "create", name: "Overflow", description: "", value: { kind: "text", text: "synthetic" } }))
      .rejects.toThrow("workspace_secret_limit");
    expect(await instance.list(userId)).toHaveLength(32);
    await prisma.user.update({ where: { id: userId }, data: { status: "disabled" } });
    await expect(instance.list(userId)).rejects.toThrow("workspace_secret_unavailable");
    await expect(instance.mutate(userId, { action: "create", name: "Blocked", description: "", value: { kind: "text", text: "synthetic" } }))
      .rejects.toThrow("workspace_secret_unavailable");
    expect(await prisma.workspaceSecret.count({ where: { userId } })).toBe(32);
  });

  it("keeps secrets out of Workspace Off admissions and Project bindings", async () => {
    const userId = await owner();
    await store().mutate(userId, { action: "create", name: "Personal", description: "", value: { kind: "text", text: "personal synthetic token" } });
    const input = await plan(userId);
    const off = await admitPreparingRunWithClient(prisma, { ...input, workspaceEnabled: false, workspaceAdmissionPlan: undefined,
      normalizedRequest: { ...input.normalizedRequest, workspace: undefined } });
    expect(await prisma.workspaceRunBinding.findUnique({ where: { modelRunId: off.runId } })).toBeNull();
    expect(await prisma.workspaceRunSecret.count({ where: { modelRunId: off.runId } })).toBe(0);
    const project = await prisma.project.create({ data: { name: "Synthetic secret boundary", createdByUserId: userId, createdByDisplayName: "Synthetic",
      grants: { create: { role: "OWNER", userId } } } });
    try {
      const chat = await prisma.chat.create({ data: { title: "Project boundary", userId: null, projectId: project.id, memoryMode: "EXCLUDED",
        createdByUserId: userId, createdByDisplayName: "Synthetic" } });
      try {
        await prisma.$transaction((tx) => bindWorkspaceSecrets(tx, { chatId: chat.id, userId, runId: randomUUID() }));
        expect(await prisma.workspaceRunSecret.count({ where: { value: { userId } } })).toBe(0);
      } finally { await prisma.chat.delete({ where: { id: chat.id } }); }
    } finally { await prisma.project.delete({ where: { id: project.id } }); }
  });

  it("freezes private revisions through actual admission, replacement and deletion; new requests receive the current set", async () => {
    const userId = await owner();
    const instance = store();
    await instance.mutate(userId, { action: "create", name: "Access", description: "", value: { kind: "text", text: "old synthetic token" } });
    const [before] = await instance.list(userId);
    const first = await admitPreparingRunWithClient(prisma, await plan(userId));
    await instance.mutate(userId, { action: "update", id: before!.id, expectedVersionId: before!.versionId, name: "Updated access", description: "",
      value: { action: "replace", content: { kind: "text", text: "new synthetic token" } } });
    const second = await admitPreparingRunWithClient(prisma, await plan(userId));
    const bound = async (runId: string) => (await prisma.workspaceRunSecret.findMany({ where: { modelRunId: runId }, include: { value: true } }))
      .map(({ value }) => decryptWorkspaceSecret(value, userId, key));
    expect(await bound(first.runId)).toEqual([expect.objectContaining({ versionId: before!.versionId, name: "Access", value: { kind: "text", text: "old synthetic token" } })]);
    expect(await bound(second.runId)).toEqual([expect.objectContaining({ name: "Updated access", value: { kind: "text", text: "new synthetic token" } })]);
    const [current] = await instance.list(userId);
    await instance.mutate(userId, { action: "delete", id: current!.id, expectedVersionId: current!.versionId });
    expect(await bound(first.runId)).toHaveLength(1);
    const third = await admitPreparingRunWithClient(prisma, await plan(userId));
    expect(await bound(third.runId)).toEqual([]);
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: first.runId } });
    expect(JSON.stringify(run.normalizedRequest)).not.toMatch(/old synthetic token|payloadEnvelope|versionId/);
    await expect(prisma.workspaceSecretValue.update({ where: { id: before!.versionId }, data: { name: "retarget" } })).rejects.toThrow();
    await expect(prisma.workspaceRunSecret.update({ where: { modelRunId_secretId: { modelRunId: first.runId, secretId: before!.id } }, data: { valueId: current!.versionId } })).rejects.toThrow();
  });

  it("retries a repeatable-read admission racing with revision cleanup under the owner lock", async () => {
    const userId = await owner();
    const instance = store();
    await instance.mutate(userId, { action: "create", name: "Race", description: "", value: { kind: "text", text: "before" } });
    const [initial] = await instance.list(userId);
    const admission = await plan(userId);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const blocker = prisma.$transaction(async (tx) => { await lockWorkspaceSecretOwner(tx, userId); locked(); await gate; }, { timeout: 10_000 });
    await ready;
    const waitForBlocked = (count: number) => vi.waitFor(async () => {
      const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"User"%'
      `;
      expect(Number(row!.count)).toBeGreaterThanOrEqual(count);
    }, { interval: 10, timeout: 1_500 });
    const update = instance.mutate(userId, { action: "update", id: initial!.id, expectedVersionId: initial!.versionId, name: "Race", description: "",
      value: { action: "replace", content: { kind: "text", text: "after" } } });
    let accepted: ReturnType<typeof admitPreparingRunWithClient> | undefined;
    try {
      await waitForBlocked(1);
      accepted = admitPreparingRunWithClient(prisma, admission);
      await waitForBlocked(2);
    } finally {
      release();
      await Promise.allSettled([blocker, update, ...(accepted ? [accepted] : [])]);
    }
    await update;
    const run = await accepted!;
    const rows = await prisma.workspaceRunSecret.findMany({ where: { modelRunId: run.runId }, include: { value: true } });
    expect(rows).toHaveLength(1);
    expect(decryptWorkspaceSecret(rows[0]!.value, userId, key).value).toEqual({ kind: "text", text: "after" });
    expect(await instance.list(userId)).toEqual([expect.objectContaining({ name: "Race" })]);
  });
});
