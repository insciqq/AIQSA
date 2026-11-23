// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
import type { SelfServiceCallStore } from "../../tools/selfServiceCall";
import { createAgentSecretService } from "./agentSecrets";
import { workspaceSecretEnvironment, workspaceSecretVariables } from "./manifest";
import { createRunSecretSource } from "./runSecrets";
import { bindWorkspaceSecrets, createWorkspaceSecretStore, decryptWorkspaceSecret, lockWorkspaceSecretOwner } from "./store";
import { saveWorkspaceBrowserSessions, type WorkspaceBrowserSaveInput } from "./browserStore";
import { BROWSER_REFUSED_REVISIONS_LIMIT } from "./browserSignInAuthority";
import {
  decodeWorkspaceSecretList, WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES
} from "@/lib/contracts/workspaceSecrets";
import type { WorkspaceBrowserSaveItem } from "./browserCollection";

const key = Buffer.alloc(32, 37);
const users: string[] = [];
const servers: string[] = [];
const config = getWorkspaceConfig({ AIQSA_TEST_MODE: "1", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1", NODE_ENV: "test" });
const definitions = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => ({
  description: `Synthetic ${originalName}`, inputSchema: { type: "object" }, namespacedName: namespacedWorkspaceToolName(originalName), originalName
}));
const store = () => createWorkspaceSecretStore(prisma, { key: () => key, validateSshKey: vi.fn(async () => undefined) });

async function owner() {
  const id = `workspace-secret-test-${randomUUID()}`;
  await prisma.user.create({ data: { id, displayName: "Synthetic Workspace secrets", status: "active" } });
  users.push(id);
  return id;
}

/** A send's admission in a new chat, or as the next message of a chat on its Workspace session. */
async function plan(userId: string, next?: Readonly<{ chatId: string; expectedActiveLeafId: string | null; sessionId: string }>):
  Promise<PreparingRunAdmissionInput> {
  const chat = next ? { id: next.chatId }
    : await prisma.chat.create({ data: { userId, title: "Synthetic secrets admission", workspaceEnabled: true } });
  const runId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  const sessionId = next?.sessionId ?? `ws_${randomBytes(20).toString("hex")}`;
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
    admissionKind: "NORMAL_SEND", chatId: chat.id, content, expectedActiveLeafId: next?.expectedActiveLeafId ?? null, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId, workspaceEnabled: true,
    normalizedRequest: {
      attachmentIds: [], chatId: chat.id, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
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

/** The chat's next message after `previous` ended and released the VM: a new run on the same session and disk. */
async function laterBrowserRun(previous: WorkspaceBrowserSaveInput): Promise<WorkspaceBrowserSaveInput> {
  const ended = await prisma.modelRun.update({ where: { id: previous.runId }, data: { status: "complete" }, select: { chatId: true } });
  await prisma.workspaceSession.update({ where: { id: previous.sessionId }, data: { operationOwner: null, state: "STOPPED" } });
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: ended.chatId }, select: { activeLeafMessageId: true } });
  const run = await admitPreparingRunWithClient(prisma, await plan(previous.userId, { chatId: ended.chatId,
    expectedActiveLeafId: chat.activeLeafMessageId, sessionId: previous.sessionId }));
  const session = await prisma.workspaceSession.update({ where: { id: previous.sessionId },
    data: { state: "RUNNING", runtimeSandboxId: previous.runtimeSandboxId } });
  return { ...previous, runId: run.runId, operation: { owner: session.operationOwner!, generation: session.version } };
}

const saveBrowser = (input: WorkspaceBrowserSaveInput, value = "synthetic-session") => saveWorkspaceBrowserSessions(prisma,
  { ...input, files: [{ fileName: "shop.example.json", bytes: browserBytes(value) }] }, () => key);

/** A valid storage_state padded with JSON whitespace to exactly `size` raw bytes. */
function sizedBrowserBytes(size: number, value = "synthetic-session") {
  const state = browserBytes(value);
  return Buffer.concat([state, Buffer.alloc(size - state.length, 32)]);
}

async function currentBrowser(userId: string, fileName: string) {
  const row = await prisma.workspaceSecret.findFirstOrThrow({ where: { userId, browserFileName: fileName }, include: { value: true } });
  return { valueId: row.valueId, value: decryptWorkspaceSecret(row.value, userId, key).value };
}

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
    await prisma.mcpServer.deleteMany({ where: { id: { in: servers.splice(0) } } });
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

  it("keeps the cookies a browser wrote last when a run accepted earlier saves after a later one, behind the manual fence", async () => {
    const userId = await owner();
    // Guest stamps half an hour back, so neither the server's clock nor a revision's creation time caps them.
    const base = Date.now() - 30 * 60_000;
    const stamped = (value: string, minute: number) => Buffer.from(JSON.stringify({ cookies: [{ name: "session", value, domain: "shop.example",
      path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [], aiqsa: { savedAt: base + minute * 60_000 } }));
    const save = (input: WorkspaceBrowserSaveInput, bytes: Buffer) => saveWorkspaceBrowserSessions(prisma,
      { ...input, files: [{ fileName: "shop.example.json", bytes }] }, () => key);
    const value = async () => {
      const saved = (await currentBrowser(userId, "shop.example.json")).value;
      return saved.kind === "browser_session" ? Buffer.from(saved.base64, "base64").toString("utf8") : "";
    };
    const main = await browserRun(userId);
    const subagent = await browserRun(userId);
    expect(await save(main, stamped("signed-in", 0))).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    // The sub-agent, accepted later, ends first and saves what the shared files held then.
    expect(await save(subagent, stamped("rotated-once", 1))).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    // The main run ends later: its browser rotated the cookie again. Acceptance order lost this write before.
    expect(await save(main, stamped("rotated-twice", 2))).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    expect(await value()).toContain("rotated-twice");
    // The same bytes again are unchanged, not stale, whichever run sends them.
    expect(await save(subagent, stamped("rotated-twice", 2))).toEqual({ saved: 0, unchanged: 1, skipped: {} });
    // A copy only restored, older than the saved one, never undoes it, even from a run accepted later.
    const later = await browserRun(userId);
    expect(await save(later, stamped("rotated-once", 1))).toMatchObject({ saved: 0, skipped: { browser_session_stale: 1 } });
    expect(await value()).toContain("rotated-twice");
    // The manual fence stays: a change in Settings fences every run accepted before it, however fresh its file.
    const [current] = await store().list(userId);
    await store().mutate(userId, { action: "update", id: current!.id, expectedVersionId: current!.versionId, name: "Shop", description: "",
      value: { action: "preserve" } });
    expect(await save(later, stamped("after-the-change", 3))).toMatchObject({ saved: 0, skipped: { browser_session_stale: 1 } });
    const next = await browserRun(userId);
    expect(await save(next, stamped("after-the-change", 3))).toMatchObject({ saved: 1 });
    expect(await value()).toContain("after-the-change");
  });

  it("never lets a run's unchanged copy, nor a stamp past the clock, replace a revision saved since its admission", async () => {
    const userId = await owner();
    const base = Date.now() - 30 * 60_000;
    const state = (value: string, savedAt: number) => Buffer.from(JSON.stringify({ cookies: [{ name: "session", value, domain: "shop.example",
      path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], origins: [], aiqsa: { savedAt } }));
    const save = (input: WorkspaceBrowserSaveInput, bytes: Buffer) => saveWorkspaceBrowserSessions(prisma,
      { ...input, files: [{ fileName: "shop.example.json", bytes }] }, () => key);
    const first = await browserRun(userId);
    expect(await save(first, state("v1", base))).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    // Both runs are given v1; the later one saves v2 first.
    const earlier = await browserRun(userId);
    const later = await browserRun(userId);
    expect(await save(later, state("v2", base + 60_000))).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    // The earlier run ends with the copy it was given, never rewritten: no write of its own.
    expect(await save(earlier, state("v1", base))).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_stale: 1 } });
    // A copy stamped past the clock is no write time: acceptance order keeps v2, at this and every later collection.
    for (let round = 0; round < 2; round++) {
      expect(await save(earlier, state("v1-forged", Date.now() + 86_400_000))).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_stale: 1 } });
    }
    const saved = (await currentBrowser(userId, "shop.example.json")).value;
    expect(saved.kind === "browser_session" ? Buffer.from(saved.base64, "base64").toString("utf8") : "").toContain("v2");
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
      { fileName: "large.json", bytes: Buffer.alloc(WORKSPACE_BROWSER_SESSION_MAX_BYTES + 1) },
      { fileName: "shop.example.json", bytes: browserBytes() }
    ] }, () => key);
    expect(report).toEqual({ saved: 1, unchanged: 0, skipped: { browser_session_invalid: 2, browser_session_too_large: 1 } });
    const row = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: input.runId } });
    expect(row.browserSessionSave).toEqual(report);
    expect(JSON.stringify(row.browserSessionSave)).not.toMatch(/synthetic|shop|cookies|base64/);
    expect(await store().list(foreignUserId)).toEqual([]);
  });

  // Operator decision 2026-11-23: a turn the server wrote authorizes nothing, so its agent (page text may steer it)
  // cannot replace the sign-in the user saved for later chats; only a Sign in again handoff the user finished saves.
  /** Marks a run's stored message as a turn the server wrote. */
  const serverTurn = async (input: WorkspaceBrowserSaveInput, data: Readonly<{ scheduledTaskPrompt?: true;
    systemTurnKind?: "browser_sign_in_request" | "conversation_summary" | "mcp_approval_continuation" | "subagent_callback" }>) => {
    const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: input.runId }, select: { userMessageId: true } });
    await prisma.message.update({ where: { id: run.userMessageId }, data });
  };
  let ordinal = 0;
  /** A `browser_handoff` call of the run as the engine stores it, with the file its Done saved when it names one. */
  const handoff = (runId: string, reason: string, outcome: string, saved?: string) => prisma.modelRunToolCall.create({ data: {
    arguments: { message: "Please sign in, then press Done.", reason }, completedAt: new Date(), modelRunId: runId,
    ordinal: ordinal++, providerCallId: `call-${randomUUID()}`, roundIndex: 0, state: "complete", toolName: "browser_handoff",
    result: { callId: "call", name: "browser_handoff", status: "complete", content: [{ type: "json", value: {
      next: "Look at the page.", outcome, page: { title: "Shop", url: "https://shop.example/account" },
      ...(saved ? { signInSavedAfterAnswer: saved } : {}) } }] } } });

  it("lets a turn the server wrote save only a sign-in the user finished in its own run, while the user's turn saves as before", async () => {
    const userId = await owner();
    const own = await browserRun(userId);
    expect(await saveBrowser(own, "user-cookie")).toMatchObject({ saved: 1 });
    const saved = await currentBrowser(userId, "shop.example.json");

    // An Allow's continuation here names no Allow, as in a branch copy: its link is missing, so it fails closed.
    for (const turn of [{ systemTurnKind: "subagent_callback" }, { systemTurnKind: "browser_sign_in_request" },
      { systemTurnKind: "mcp_approval_continuation" }, { systemTurnKind: "conversation_summary" }, { scheduledTaskPrompt: true }] as const) {
      const input = await browserRun(userId);
      await serverTurn(input, turn);
      // Handoffs that prove nothing: another reason, no Done, a Done that saved nothing, and another run's sign-in.
      await handoff(input.runId, "captcha", "completed", "shop.example");
      await handoff(input.runId, "sign_in", "not_answered");
      await handoff(input.runId, "sign_in", "completed");
      await handoff(own.runId, "sign_in", "completed", "shop.example");
      const report = await saveWorkspaceBrowserSessions(prisma, { ...input, files: [
        { fileName: "shop.example.json", bytes: browserBytes("injected-cookie") },
        { fileName: "new.example.json", bytes: browserBytes("injected-new") }
      ] }, () => key);
      expect(report, JSON.stringify(turn)).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 2 } });
      expect(await currentBrowser(userId, "shop.example.json")).toEqual(saved);
      expect(await prisma.workspaceSecret.count({ where: { userId, browserFileName: "new.example.json" } })).toBe(0);
      // What its browser holds unchanged is no save at all.
      expect(await saveWorkspaceBrowserSessions(prisma, { ...input, files: [{ fileName: "shop.example.json",
        bytes: browserBytes("user-cookie") }] }, () => key)).toEqual({ saved: 0, unchanged: 1, skipped: {} });
    }

    // Sign in again: the user finished the handoff for that site in this run, so that site alone is saved.
    const signIn = await browserRun(userId);
    await serverTurn(signIn, { systemTurnKind: "browser_sign_in_request" });
    await handoff(signIn.runId, "sign_in", "completed", "shop.example");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...signIn, files: [
      { fileName: "shop.example.json", bytes: browserBytes("signed-in-again") },
      { fileName: "new.example.json", bytes: browserBytes("injected-new") }
    ] }, () => key)).toEqual({ saved: 1, unchanged: 0, skipped: { browser_session_server_turn: 1 } });
    expect((await currentBrowser(userId, "shop.example.json")).value).toEqual({ kind: "browser_session", originalName: "shop.example.json",
      base64: browserBytes("signed-in-again").toString("base64") });

    // The user's own turn saves what its browser holds, new sites included.
    const later = await browserRun(userId);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...later, files: [
      { fileName: "shop.example.json", bytes: browserBytes("user-again") },
      { fileName: "new.example.json", bytes: browserBytes("user-new") }
    ] }, () => key)).toEqual({ saved: 2, unchanged: 0, skipped: {} });
  });

  // The turn after an MCP Allow has exactly the authority of the turn whose call the user allowed (`storedUserRequest`).
  it("saves from the turn after an MCP Allow as the turn whose call the user allowed would", async () => {
    const userId = await owner();
    const own = await browserRun(userId);
    expect(await saveBrowser(own, "user-cookie")).toMatchObject({ saved: 1 });
    /** A run admitted as the turn after an Allow of a call that a turn of its chat made, linked as admission freezes it. */
    const continuation = async (gatedKind?: "subagent_callback") => {
      const input = await browserRun(userId);
      const run = await prisma.modelRun.findUniqueOrThrow({ where: { id: input.runId },
        select: { chatId: true, normalizedRequest: true, userMessageId: true } });
      const question = await prisma.message.create({ data: { chatId: run.chatId, content: textMessageContent("Synthetic gated turn"),
        role: "user", status: "complete", ...(gatedKind ? { systemTurnKind: gatedKind } : {}) } });
      const reply = await prisma.message.create({ data: { chatId: run.chatId, content: textMessageContent("Synthetic approval card"),
        parentMessageId: question.id, role: "assistant", status: "complete" } });
      const gated = await prisma.modelRun.create({ data: { assistantMessageId: reply.id, chatId: run.chatId, engine: "native",
        modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "cancelled", userId, userMessageId: question.id } });
      const server = await prisma.mcpServer.create({ data: { displayName: "Synthetic Records", enabled: true,
        namespace: `browser_${randomUUID().replaceAll("-", "")}` } });
      servers.push(server.id);
      const approval = await prisma.mcpToolApproval.create({ data: { argumentsDigest: "a".repeat(64), chatId: run.chatId,
        decidedAt: new Date(), decision: "allow_server", definitionHash: "b".repeat(64), modelRunId: gated.id, serverId: server.id,
        serverName: "Synthetic Records", source: "code", toolName: "mcp_records_create", toolTitle: "create_record", userId } });
      await prisma.message.update({ where: { id: run.userMessageId }, data: { systemTurnKind: "mcp_approval_continuation" } });
      await prisma.modelRun.update({ where: { id: input.runId }, data: { normalizedRequest: {
        ...(run.normalizedRequest as Prisma.InputJsonObject),
        mcpApproval: { approvedBy: approval.id, consentedServerIds: [], version: 1 } } } });
      return input;
    };

    // After the user's own turn it is that turn: it saves what its browser holds, as before.
    const ofUser = await continuation();
    expect(await saveBrowser(ofUser, "after-allow")).toMatchObject({ saved: 1, skipped: {} });
    // After a wake-up's call it is the server's turn: the saved sign-in stays.
    const ofWakeUp = await continuation("subagent_callback");
    expect(await saveBrowser(ofWakeUp, "injected-cookie")).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 1 } });
    expect((await currentBrowser(userId, "shop.example.json")).value).toEqual({ kind: "browser_session", originalName: "shop.example.json",
      base64: browserBytes("after-allow").toString("base64") });
  });

  // A refused file stays on the chat's disk, and the next run there collects it again: the refusal must outlive the turn.
  it("never saves the bytes a turn the server wrote was refused when a later run of the chat collects them", async () => {
    const userId = await owner();
    const own = await browserRun(userId);
    expect(await saveBrowser(own, "user-cookie")).toMatchObject({ saved: 1 });
    const saved = await currentBrowser(userId, "shop.example.json");
    const injected = { fileName: "shop.example.json", bytes: browserBytes("injected-cookie") };
    const refused = { saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 1 } };

    const wakeUp = await laterBrowserRun(own);
    await serverTurn(wakeUp, { systemTurnKind: "subagent_callback" });
    expect(await saveWorkspaceBrowserSessions(prisma, { ...wakeUp, files: [injected] }, () => key)).toEqual(refused);
    // The user's next message only reads a file, yet its run collects what the disk still holds.
    const reading = await laterBrowserRun(wakeUp);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...reading, files: [injected] }, () => key)).toEqual(refused);
    expect(await currentBrowser(userId, "shop.example.json")).toEqual(saved);
    // Only a sign-in the user finishes for that site in a run saves it, as a Sign in again would.
    const signIn = await laterBrowserRun(reading);
    await handoff(signIn.runId, "sign_in", "completed", "shop.example");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...signIn, files: [injected] }, () => key)).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { id: own.sessionId } })).browserRefusedRevisions).toBeNull();
    // Another chat's disk keeps no refusal of this one: what its own turn collects saves as before.
    expect(await saveBrowser(await browserRun(userId), "elsewhere")).toMatchObject({ saved: 1 });
  });

  // Settings accepts a storage state of several sites: a sign-in to one never carries the other sites' cookies along.
  // The guest names a file after the host a sign-in began on, while the site keeps its sign-in cookies on the parent.
  it("saves a finished sign-in named after the host it began on with its cookies on the site's parent, never another site's beside them", async () => {
    const userId = await owner();
    const google = (domains: readonly string[], value: string) => ({ fileName: "accounts.google.com.json", bytes: Buffer.from(
      JSON.stringify({ cookies: domains.map((domain) => ({ name: "SID", value, domain, path: "/", expires: -1, httpOnly: true, secure: true,
        sameSite: "Lax" })), origins: [{ origin: "https://accounts.google.com", localStorage: [] }] })) });
    const signIn = await browserRun(userId);
    await serverTurn(signIn, { systemTurnKind: "browser_sign_in_request" });
    await handoff(signIn.runId, "sign_in", "completed", "accounts.google.com");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...signIn, files: [google([".google.com", "accounts.google.com"], "signed-in")] },
      () => key)).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    const saved = await currentBrowser(userId, "accounts.google.com.json");
    const again = await laterBrowserRun(signIn);
    await serverTurn(again, { systemTurnKind: "browser_sign_in_request" });
    await handoff(again.runId, "sign_in", "completed", "accounts.google.com");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...again, files: [google([".google.com", ".bank.example"], "carried")] },
      () => key)).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 1 } });
    expect(await currentBrowser(userId, "accounts.google.com.json")).toEqual(saved);
  });

  // A settings change fences every run accepted before it, but the refused file stays on the disk for the next one.
  it("remembers a refused file even when a settings change fenced its save, so the next run of the chat never saves it", async () => {
    const userId = await owner();
    const own = await browserRun(userId);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...own, files: [{ fileName: "shop.example.json", bytes: browserBytes("user-cookie") },
      { fileName: "other.example.json", bytes: browserBytes("other-cookie") }] }, () => key)).toMatchObject({ saved: 2 });
    const saved = await currentBrowser(userId, "shop.example.json");
    const wakeUp = await laterBrowserRun(own);
    await serverTurn(wakeUp, { systemTurnKind: "subagent_callback" });
    // The user edits another site's sign-in in Settings while the wake-up runs.
    const other = (await store().list(userId)).find((entry) => entry.name === "other.example")!;
    await store().mutate(userId, { action: "update", id: other.id, expectedVersionId: other.versionId, name: "Other", description: "",
      value: { action: "preserve" } });
    const injected = { fileName: "shop.example.json", bytes: browserBytes("injected-cookie") };
    expect(await saveWorkspaceBrowserSessions(prisma, { ...wakeUp, files: [injected] }, () => key))
      .toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_stale: 1 } });
    const next = await laterBrowserRun(wakeUp);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...next, files: [injected] }, () => key))
      .toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 1 } });
    expect(await currentBrowser(userId, "shop.example.json")).toEqual(saved);
  });

  // Each later run collects and refuses a file still on the disk again: newer refusals must not push it out of the bound.
  it("keeps a refused file that later runs still collect when newer refusals fill the session's record", async () => {
    const userId = await owner();
    const own = await browserRun(userId);
    expect(await saveBrowser(own, "user-cookie")).toMatchObject({ saved: 1 });
    const injected = { fileName: "shop.example.json", bytes: browserBytes("injected-cookie") };
    const refused = { saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 1 } };
    const recorded = async () => (await prisma.workspaceSession.findUniqueOrThrow({ where: { id: own.sessionId } }))
      .browserRefusedRevisions as Array<[string, string]>;
    const wakeUp = await laterBrowserRun(own);
    await serverTurn(wakeUp, { systemTurnKind: "subagent_callback" });
    expect(await saveWorkspaceBrowserSessions(prisma, { ...wakeUp, files: [injected] }, () => key)).toEqual(refused);
    // Refusals of other files since fill the record to its bound, this one the oldest.
    const [shop] = await recorded();
    await prisma.workspaceSession.update({ where: { id: own.sessionId }, data: { browserRefusedRevisions: [shop!,
      ...Array.from({ length: BROWSER_REFUSED_REVISIONS_LIMIT - 1 }, (_, index) => [`s${index}.example.json`, "a".repeat(64)])] as
      Prisma.InputJsonValue } });
    const next = await laterBrowserRun(wakeUp);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...next, files: [injected] }, () => key)).toEqual(refused);
    expect((await recorded()).at(-1)).toEqual(shop);
    // A newer refusal drops the oldest file nobody collected, never this one.
    const wakeUpAgain = await laterBrowserRun(next);
    await serverTurn(wakeUpAgain, { systemTurnKind: "subagent_callback" });
    expect(await saveWorkspaceBrowserSessions(prisma, { ...wakeUpAgain, files: [{ fileName: "new.example.json",
      bytes: browserBytes("injected-new") }] }, () => key)).toEqual(refused);
    const names = (await recorded()).map(([name]) => name);
    expect(names).toHaveLength(BROWSER_REFUSED_REVISIONS_LIMIT);
    expect(names).toContain("shop.example.json");
    expect(names).not.toContain("s0.example.json");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...(await laterBrowserRun(wakeUpAgain)), files: [injected] }, () => key))
      .toEqual(refused);
  });

  it("refuses a turn the server wrote a file holding more than the site its finished sign-in saved", async () => {
    const userId = await owner();
    const own = await browserRun(userId);
    const both = (value: string) => Buffer.from(JSON.stringify({ cookies: [
      { name: "session", value, domain: ".shop.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "session", value, domain: "bank.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }
    ], origins: [{ origin: "https://www.shop.example", localStorage: [{ name: "cart", value }] }] }));
    expect(await saveWorkspaceBrowserSessions(prisma, { ...own, files: [{ fileName: "shop.example.json", bytes: both("user-cookie") }] },
      () => key)).toMatchObject({ saved: 1 });
    const saved = await currentBrowser(userId, "shop.example.json");
    const signIn = await laterBrowserRun(own);
    await serverTurn(signIn, { systemTurnKind: "browser_sign_in_request" });
    await handoff(signIn.runId, "sign_in", "completed", "shop.example");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...signIn, files: [{ fileName: "shop.example.json", bytes: both("signed-in") }] },
      () => key)).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_server_turn: 1 } });
    expect(await currentBrowser(userId, "shop.example.json")).toEqual(saved);
  });

  it("saves states between 512 KiB and 8 MiB exactly, keeps the previous version for 8 MiB + 1 and decodes the list", async () => {
    const userId = await owner();
    const first = await browserRun(userId);
    const aboveFormer = sizedBrowserBytes(512 * 1024 + 1, "above-former-cap");
    const maximum = sizedBrowserBytes(WORKSPACE_BROWSER_SESSION_MAX_BYTES, "maximum");
    expect(await saveWorkspaceBrowserSessions(prisma, { ...first, files: [
      { fileName: "above.example.json", bytes: aboveFormer }, { fileName: "max.example.json", bytes: maximum }
    ] }, () => key)).toEqual({ saved: 2, unchanged: 0, skipped: {} });
    expect((await currentBrowser(userId, "above.example.json")).value).toEqual({ kind: "browser_session", originalName: "above.example.json", base64: aboveFormer.toString("base64") });
    const saved = await currentBrowser(userId, "max.example.json");
    expect(saved.value).toEqual({ kind: "browser_session", originalName: "max.example.json", base64: maximum.toString("base64") });
    const rows = await store().list(userId);
    expect(decodeWorkspaceSecretList(rows)).toEqual(rows);
    expect(rows.map((row) => row.byteSize).sort((a, b) => a - b)).toEqual([aboveFormer.length, maximum.length]);
    // Accepted run admission freezes the large revisions for the next personal run.
    const second = await browserRun(userId);
    expect(await prisma.workspaceRunSecret.count({ where: { modelRunId: second.runId } })).toBe(2);
    const over = sizedBrowserBytes(WORKSPACE_BROWSER_SESSION_MAX_BYTES + 1, "too-large");
    const report = await saveWorkspaceBrowserSessions(prisma, { ...second, files: [{ fileName: "max.example.json", bytes: over }] }, () => key);
    expect(report).toEqual({ saved: 0, unchanged: 0, skipped: { browser_session_too_large: 1 } });
    expect((await currentBrowser(userId, "max.example.json")).valueId).toBe(saved.valueId);
    expect(await store().browserAutosave(userId)).toEqual(report);
  }, 60_000);

  it("enforces the 64 MiB aggregate for autosave and manual import without replacing kept versions", async () => {
    const userId = await owner();
    const input = await browserRun(userId);
    const count = WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES / WORKSPACE_BROWSER_SESSION_MAX_BYTES;
    // A lazy source: each state exists only while it is being committed.
    async function* states(): AsyncGenerator<WorkspaceBrowserSaveItem> {
      for (let index = 0; index < count; index++) yield { fileName: `site-${index}.example.json`, bytes: sizedBrowserBytes(WORKSPACE_BROWSER_SESSION_MAX_BYTES, `state-${index}`) };
      yield { fileName: "extra.example.json", bytes: browserBytes("over-aggregate") };
    }
    expect(await saveWorkspaceBrowserSessions(prisma, { ...input, files: states() }, () => key))
      .toEqual({ saved: count, unchanged: 0, skipped: { browser_session_total_limit: 1 } });
    expect(await prisma.workspaceSecret.count({ where: { userId, browserFileName: "extra.example.json" } })).toBe(0);
    await expect(store().mutate(userId, { action: "create", name: "Extra", description: "",
      value: { kind: "browser_session", originalName: "extra.example.json", base64: browserBytes().toString("base64") } })).rejects.toThrow("workspace_secret_limit");
    // Replacing a state counts its own old size out of the aggregate.
    const next = await browserRun(userId);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...next, files: [
      { fileName: "site-0.example.json", bytes: sizedBrowserBytes(WORKSPACE_BROWSER_SESSION_MAX_BYTES, "replacement") }
    ] }, () => key)).toEqual({ saved: 1, unchanged: 0, skipped: {} });
    const bound = await prisma.workspaceRunSecret.findMany({ where: { modelRunId: next.runId }, include: { value: { select: { byteSize: true } } } });
    expect(bound.reduce((total, row) => total + row.value.byteSize, 0)).toBe(WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES);
  }, 120_000);

  it("stops at a fence lost between states, records an unfinished save and never pulls later states", async () => {
    const userId = await owner();
    const input = await browserRun(userId);
    const pulled: string[] = [];
    async function* fenced(): AsyncGenerator<WorkspaceBrowserSaveItem> {
      pulled.push("first.example.json");
      yield { fileName: "first.example.json", bytes: browserBytes("first") };
      // Another operation takes the session, as a Stop or stale finalizer would.
      await prisma.workspaceSession.update({ where: { id: input.sessionId }, data: { version: { increment: 1 } } });
      pulled.push("second.example.json");
      yield { fileName: "second.example.json", bytes: browserBytes("second") };
      pulled.push("third.example.json");
      yield { fileName: "third.example.json", bytes: browserBytes("third") };
    }
    expect(await saveWorkspaceBrowserSessions(prisma, { ...input, files: fenced() }, () => key))
      .toEqual({ saved: 1, unchanged: 0, skipped: { browser_session_stale: 1 } });
    expect(pulled).toEqual(["first.example.json", "second.example.json"]);
    expect((await store().list(userId)).map((row) => row.originalName)).toEqual(["first.example.json"]);

    const failing = await browserRun(userId);
    async function* broken(): AsyncGenerator<WorkspaceBrowserSaveItem> {
      yield { fileName: "kept.example.json", bytes: browserBytes("kept") };
      throw new Error("synthetic private cookie");
    }
    const report = await saveWorkspaceBrowserSessions(prisma, { ...failing, files: broken() }, () => key);
    expect(report).toEqual({ saved: 1, unchanged: 0, skipped: {}, failure: "browser_session_save_failed" });
    const row = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: failing.runId } });
    expect(row.browserSessionSave).toEqual(report);
    expect(JSON.stringify(row.browserSessionSave)).not.toMatch(/synthetic|kept|cookie/);
    expect(await store().browserAutosave(userId)).toEqual(report);
    const expired = await browserRun(userId);
    expect(await saveWorkspaceBrowserSessions(prisma, { ...expired, files: [{ fileName: "late.example.json", bytes: browserBytes("late") }],
      signal: AbortSignal.abort() }, () => key)).toEqual({ saved: 0, unchanged: 0, skipped: {}, failure: "browser_session_save_failed" });
    expect(await prisma.workspaceSecret.count({ where: { userId, browserFileName: "late.example.json" } })).toBe(0);
    expect(await store().browserAutosave(await owner())).toBeNull();
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

  it("reveals the owner's current value and answers another user's or a browser session's without content", async () => {
    const userId = await owner();
    const otherId = await owner();
    const instance = store();
    await instance.mutate(userId, { action: "create", name: "Env", description: "", value: { kind: "env", entries: [{ name: "SYNTHETIC_TOKEN", value: "synthetic-value" }] } });
    const [env] = await instance.list(userId);
    expect(await instance.reveal(userId, env!.id)).toEqual({ id: env!.id, versionId: env!.versionId,
      value: { kind: "env", entries: [{ name: "SYNTHETIC_TOKEN", value: "synthetic-value" }] } });
    await expect(instance.reveal(otherId, env!.id)).rejects.toMatchObject({ code: "workspace_secret_not_found" });
    await expect(instance.reveal(userId, randomUUID())).rejects.toMatchObject({ code: "workspace_secret_not_found" });
    await instance.mutate(userId, { action: "create", name: "Shop", description: "",
      value: { kind: "browser_session", originalName: "shop.example.json", base64: browserBytes().toString("base64") } });
    const browser = (await instance.list(userId)).find(({ kind }) => kind === "browser_session")!;
    await expect(instance.reveal(userId, browser.id)).rejects.toMatchObject({ code: "workspace_secret_not_revealable" });
    await prisma.user.update({ where: { id: userId }, data: { status: "disabled" } });
    await expect(instance.reveal(userId, env!.id)).rejects.toMatchObject({ code: "workspace_secret_not_found" });
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

  it("keeps secrets out of Workspace Off admissions and another owner's chat", async () => {
    const userId = await owner();
    await store().mutate(userId, { action: "create", name: "Personal", description: "", value: { kind: "text", text: "personal synthetic token" } });
    const input = await plan(userId);
    const off = await admitPreparingRunWithClient(prisma, { ...input, workspaceEnabled: false, workspaceAdmissionPlan: undefined,
      normalizedRequest: { ...input.normalizedRequest, workspace: undefined } });
    expect(await prisma.workspaceRunBinding.findUnique({ where: { modelRunId: off.runId } })).toBeNull();
    expect(await prisma.workspaceRunSecret.count({ where: { modelRunId: off.runId } })).toBe(0);
    const chat = await prisma.chat.create({ data: { title: "Another owner", userId: await owner() } });
    await expect(prisma.$transaction((tx) => bindWorkspaceSecrets(tx, { chatId: chat.id, userId, runId: randomUUID() })))
      .rejects.toMatchObject({ code: "workspace_secret_unavailable" });
    expect(await prisma.workspaceRunSecret.count({ where: { value: { userId } } })).toBe(0);
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

  it("binds a secret the agent saved during one run to the next run's admission, whose Workspace gets its variable", async () => {
    const userId = await owner();
    const earlier = await admitPreparingRunWithClient(prisma, await plan(userId));
    // `manage_secret`'s own service, committing with a call the store lets through.
    const calls: SelfServiceCallStore = { claim: vi.fn(async () => ({ kind: "open" as const })), settle: vi.fn(async () => undefined) };
    const service = createAgentSecretService({ db: prisma, key: () => key, store: calls,
      scope: { callId: "synthetic-call", chatId: "synthetic-chat", runId: earlier.runId, userId } });
    const outcome = await service.change({ action: "create", description: "", name: "DEMO_API_TOKEN", value: { kind: "text", text: "synthetic-demo-token" } },
      (done) => ({ callId: "provider-call", content: [{ type: "json", value: { saved: true, secretId: done.secret.id } }], name: "manage_secret", status: "complete" }));
    expect(outcome.kind).toBe("changed");
    expect(calls.settle).toHaveBeenCalledOnce();
    const next = await admitPreparingRunWithClient(prisma, await plan(userId));
    const bound = async (runId: string) => (await prisma.workspaceRunSecret.findMany({ where: { modelRunId: runId }, include: { value: true } }))
      .map(({ value }) => decryptWorkspaceSecret(value, userId, key));
    // The run that saved it keeps what its own admission froze; the next one receives the secret.
    expect(await bound(earlier.runId)).toEqual([]);
    const admitted = await bound(next.runId);
    expect(admitted).toEqual([expect.objectContaining({ name: "DEMO_API_TOKEN", value: { kind: "text", text: "synthetic-demo-token" } })]);
    expect(workspaceSecretEnvironment(admitted)).toEqual({ DEMO_API_TOKEN: "synthetic-demo-token" });
    // The native prompt derives the same variable from the run's admitted list and the sizes the store recorded.
    const listed = await createRunSecretSource(prisma, () => key).list({ runId: next.runId, userId });
    expect(listed).toEqual([expect.objectContaining({ kind: "text", name: "DEMO_API_TOKEN" })]);
    expect(workspaceSecretVariables(listed)).toEqual([["DEMO_API_TOKEN"]]);
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
