import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { assertDisposableStatefulTestTarget } from "./stateful-test-target";
import { textMessageContent } from "@/lib/domain/content";
import { WORKSPACE_POLICY_ID, workspaceMessageManifestPath, workspaceRunOutputDirectory, workspaceSandboxName, type WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { admitPreparingRunWithClient } from "@/lib/server/runs/prismaRepositoryPreparation";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { createPrismaWorkspaceCoordinatorRepository, createWorkspaceCoordinator } from "@/lib/server/workspace/coordinator";
import { createPrismaWorkspaceExecutionRegistry } from "@/lib/server/workspace/executionRegistry";
import { loadPinnedOfficialWorkspaceToolCatalog } from "@/lib/server/workspace/microsandboxRuntime";
import { RemoteWorkspaceRuntime } from "@/lib/server/workspace/remoteRuntime";
import { WorkspaceRuntimeError } from "@/lib/server/workspace/runtime";
import { createWorkspaceSecretStore, decryptWorkspaceSecret } from "@/lib/server/workspace/secrets/store";
import { namespacedWorkspaceToolName } from "@/lib/server/workspace/toolCatalog";
import { createFileSystemStorageAdapter } from "@/lib/server/uploads/storage";

// Run in the disposable application role, separately from the credential-free
// KVM receiver. This script never invokes a provider or a real website.
assertDisposableStatefulTestTarget(process.env);
assert.equal(process.env.AIQSA_WORKSPACE_LIVE_E2E, "DISPOSABLE");
assert.equal(process.env.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME, "0");
const endpoint = new URL(process.env.AIQSA_WORKSPACE_RUNNER_URL!);
assert.equal(endpoint.protocol, "http:");
assert.equal(endpoint.hostname, "127.0.0.1");
const config = getWorkspaceConfig(process.env);
assert.equal(config.memoryMiB, 4096);
const runtime = new RemoteWorkspaceRuntime(config);
const prisma = new PrismaClient();
const repository = createPrismaWorkspaceCoordinatorRepository(prisma);
const storageRoot = mkdtempSync(join(tmpdir(), "aiqsa-browser-smoke-objects-"));
const storage = createFileSystemStorageAdapter(storageRoot);
const coordinator = createWorkspaceCoordinator({ config, repository, runtime, storage, registry: createPrismaWorkspaceExecutionRegistry(prisma) });
const secrets = createWorkspaceSecretStore(prisma);
const userId = randomUUID();
const ownedSessions = new Set<string>();
let phase = "preflight";
let step = "preflight";
let callOrdinal = 0;
type Run = Awaited<ReturnType<typeof admit>>;

async function admit(chatId?: string) {
  step = "admission";
  const chat = chatId ? await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })
    : await prisma.chat.create({ data: { userId, title: "Synthetic browser verification", workspaceEnabled: true } });
  const existing = await prisma.workspaceSession.findUnique({ where: { chatId: chat.id } });
  const sessionId = existing?.id ?? `ws_${randomBytes(20).toString("hex")}`;
  ownedSessions.add(sessionId);
  const runId = randomUUID(), userMessageId = randomUUID(), assistantMessageId = randomUUID();
  const catalog = await loadPinnedOfficialWorkspaceToolCatalog();
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: WORKSPACE_POLICY_ID } });
  const workspace = { enabled: true as const, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
    maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds, mcpVersion: catalog.mcpVersion,
    messageManifestPath: workspaceMessageManifestPath(userMessageId), outputDirectory: workspaceRunOutputDirectory(runId),
    projectDirectory: "/workspace/project", runtimeVersion: catalog.runtimeVersion, sessionId,
    syncToolTimeoutSeconds: config.syncToolTimeoutSeconds, toolCatalogHash: catalog.hash, turnTimeoutSeconds: config.turnTimeoutSeconds };
  const content = textMessageContent("Exercise the synthetic browser login and cart.");
  await admitPreparingRunWithClient(prisma, {
    admissionKind: "NORMAL_SEND", chatId: chat.id, content, expectedActiveLeafId: chat.activeLeafMessageId,
    modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId, workspaceEnabled: true,
    normalizedRequest: { attachmentIds: [], chatId: chat.id, content, knowledgePlan: { baseIds: [], sourceIds: [], mode: "none", version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, toolCalling: true },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake", searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", workspace },
    workspaceAdmissionPlan: { assistantMessageId, chatId: chat.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), normalized: workspace,
      policyRevision: policy.version, runId, sandboxName: workspaceSandboxName(sessionId), sessionId, toolDefinitions: catalog.tools, userMessageId }
  });
  return { runId, chatId: chat.id, assistantMessageId, userId, workspace };
}

async function call(run: Run, name: WorkspaceMcpToolName, args: Record<string, unknown>) {
  step = `dispatch_${name}`;
  const id = randomUUID(), toolName = namespacedWorkspaceToolName(name);
  await prisma.modelRunToolCall.create({ data: { id, modelRunId: run.runId, workspaceRunBindingId: run.runId, roundIndex: 0,
    ordinal: callOrdinal++, providerCallId: id, toolName, arguments: args as Prisma.InputJsonValue, state: "running" } });
  const result = await coordinator.execute({ ...run, call: { id, name: toolName, arguments: args }, modelRunToolCallId: id, signal: AbortSignal.timeout(150_000) });
  let parsed: { ok?: boolean; data?: Record<string, unknown> } | undefined;
  try { parsed = JSON.parse(result.content.find((entry) => entry.type === "text")?.text ?? "null"); } catch { /* Content-free failure below. */ }
  if (result.status !== "complete" || !parsed?.ok || parsed.data?.success === false) {
    const raw = JSON.stringify(result.content);
    process.stderr.write(JSON.stringify({ phase, toolFailed: true, assertion: raw.includes("AssertionError"), timedOut: /[Tt]imeout/u.test(raw),
      missingModule: raw.includes("ModuleNotFoundError"), chromiumLaunch: raw.includes("BrowserType.launch"), missingFile: raw.includes("No such file") }) + "\n");
    throw new Error("workspace_browser_fixture_command_failed");
  }
  await prisma.modelRunToolCall.update({ where: { id }, data: { state: "complete", completedAt: new Date() } });
  return parsed.data!;
}

async function startSite(run: Run) {
  await call(run, "sandbox_fs_write", { path: "/workspace/tmp/browser-site.py", encoding: "utf8", content: await readFile("tests/fixtures/workspace-browser-site.py", "utf8") });
  await call(run, "sandbox_exec_start", { command: "/opt/aiqsa-python/bin/python", args: ["-u", "/workspace/tmp/browser-site.py"] });
}

async function browser(run: Run, mode: "login" | "restored" | "expired" | "deleted") {
  const source = `
import importlib.metadata, json, os, pathlib, shutil, urllib.request
from playwright.sync_api import sync_playwright
import pyotp
assert os.getuid() == 0
assert importlib.metadata.version('playwright') == '1.60.0'
assert importlib.metadata.version('pyotp') == '2.10.0'
assert os.environ['PLAYWRIGHT_BROWSERS_PATH'] == '/opt/aiqsa-playwright'
assert shutil.which('Xvfb') is None
assert 'SHOP_LOGIN' in pathlib.Path('/workspace/SECRETS.md').read_text()
state = pathlib.Path('/workspace/secrets/browser/shop.example.json')
mode = ${JSON.stringify(mode)}
if mode in ['login', 'deleted']: assert not state.exists()
else: assert state.exists()
url = os.environ['SHOP_URL']
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(storage_state=str(state) if state.exists() else None, viewport={'width': 900, 'height': 640})
    page = context.new_page()
    if mode == 'expired': urllib.request.urlopen(url + '/expire', timeout=5).read()
    page.goto(url, wait_until='domcontentloaded')
    if mode == 'restored':
        page.get_by_role('heading', name='Корзина — тест Workspace').wait_for()
        assert json.load(urllib.request.urlopen(url + '/stats'))['logins'] == 0
        assert page.get_by_text('Книга Python', exact=True).count() == 1
    else:
        page.get_by_label('Login', exact=True).fill(os.environ['SHOP_LOGIN'])
        page.get_by_label('Password', exact=True).fill(os.environ['SHOP_PASSWORD'])
        page.get_by_role('button', name='Sign in', exact=True).click()
        page.get_by_label('Verification code').fill(pyotp.TOTP(os.environ['SHOP_TOTP_SEED']).now())
        page.get_by_role('button', name='Verify', exact=True).click()
        page.get_by_role('link', name='Continue', exact=True).click()
        assert json.load(urllib.request.urlopen(url + '/stats'))['logins'] == 1
        page.get_by_role('button', name='Добавить в корзину').click()
        page.get_by_role('link', name='Continue', exact=True).click()
    snapshot = page.locator('main').aria_snapshot()
    assert 'Корзина' in snapshot and len(snapshot) < 4096
    context.storage_state(path=str(state))
    page.screenshot(path=${JSON.stringify(run.workspace.outputDirectory + "/cart.png")})
    browser.close()
if mode == 'login':
    state.with_name('invalid.json').write_text('invalid synthetic state')
    state.with_name('oversized.json').write_bytes(b'x' * (512 * 1024 + 1))
    state.with_name('linked.json').symlink_to(state)
print('synthetic_browser_ok')
`;
  await call(run, "sandbox_exec", { command: "/opt/aiqsa-python/bin/python", args: ["-c", source], treatNonZeroAsError: false });
}

async function finish(run: Run) {
  step = "handoff";
  // A new application coordinator must preserve the just-written guest state
  // while reinitializing the same accepted run for handoff.
  const restarted = createWorkspaceCoordinator({ config, repository, runtime, storage, registry: createPrismaWorkspaceExecutionRegistry(prisma) });
  assert.deepEqual(await restarted.handoff(run), { status: "ready" });
  step = "handoff_evidence";
  const binding = await prisma.workspaceRunBinding.findUniqueOrThrow({ where: { modelRunId: run.runId }, include: { workspaceSession: true } });
  assert.equal(binding.workspaceSession.state, "STOPPED");
  assert.equal(await prisma.workspaceExecution.count({ where: { modelRunId: run.runId, state: { in: ["ACTIVE", "TERMINATING"] } } }), 0);
  step = "terminal_transaction";
  // This fixture skips provider preparation. End its Memory gate and run
  // atomically so deferred database invariants see a valid terminal state.
  await prisma.$transaction(async (tx) => {
    await tx.memoryRetrievalAttempt.updateMany({ where: { modelRunId: run.runId }, data: { state: "CANCELLED", errorCode: "fixture_preparation_cancelled" } });
    await tx.message.update({ where: { id: run.assistantMessageId }, data: { status: "complete", content: textMessageContent("Synthetic browser task complete.") } });
    await tx.modelRun.update({ where: { id: run.runId }, data: { status: "complete", normalizedRequest: {} } });
  });
  const saved = await secrets.list(userId);
  step = "encrypted_session_evidence";
  const browserStates = saved.filter((entry) => entry.kind === "browser_session");
  assert.equal(browserStates.length, 1);
  assert.equal(browserStates[0]!.browserSession!.autoSaved, true);
  assert.equal((await restarted.finalize({ ...run, recovery: true })).status, "complete");
  step = "export_evidence";
  assert.deepEqual(await secrets.list(userId), saved, "export recovery changed personal sessions");
  const outputs = await prisma.workspaceRunOutput.findMany({ where: { workspaceRunBindingId: run.runId }, include: { attachment: true } });
  assert.deepEqual(outputs.map((entry) => entry.relativePath), ["cart.png"]);
  const screenshot = await storage.getObject(outputs[0]!.attachment.storageKey);
  assert.equal(screenshot.body.subarray(1, 4).toString(), "PNG");
  assert.ok(screenshot.body.length > 10_000);
  await writeFile("/artifacts/workspace-browser-cart.png", screenshot.body, { mode: 0o600 });
  return { session: binding.workspaceSession, report: binding.browserSessionSave, saved: browserStates[0]! };
}

async function main() {
  const oldPolicy = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: WORKSPACE_POLICY_ID }, select: { enabled: true } });
  let created = false;
  try {
    assert.equal((await runtime.health(AbortSignal.timeout(120_000))).state, "ready");
    const inventory = await runtime.listSessions!({ signal: AbortSignal.timeout(30_000) });
    assert.equal(inventory.entries.length, 0, "browser smoke requires an empty isolated runner");
    await prisma.workspacePolicy.update({ where: { id: WORKSPACE_POLICY_ID }, data: { enabled: true } });
    await prisma.user.create({ data: { id: userId, displayName: "Synthetic browser fixture", status: "active" } }); created = true;
    await prisma.userMemorySettings.update({ where: { userId }, data: { useMemoryFacts: false, learnAutomatically: false, referenceChatHistory: false } });
    await secrets.mutate(userId, { action: "create", name: "Synthetic shop", description: "Local browser verification only", value: { kind: "env", entries: [
      { name: "SHOP_URL", value: "http://127.0.0.1:18765" }, { name: "SHOP_LOGIN", value: "synthetic-login" },
      { name: "SHOP_PASSWORD", value: "synthetic-password" }, { name: "SHOP_TOTP_SEED", value: "JBSWY3DPEHPK3PXP" }
    ] } });
    phase = "first_login";
    const first = await admit(); await startSite(first); await browser(first, "login"); const initial = await finish(first);
    assert.deepEqual(initial.report, { saved: 1, unchanged: 0, skipped: { browser_session_invalid: 2, browser_session_too_large: 1 } });
    const encrypted = await prisma.workspaceSecretValue.findUniqueOrThrow({ where: { id: initial.saved.versionId } });
    const value = decryptWorkspaceSecret(encrypted, userId).value;
    assert.equal(value.kind, "browser_session");
    assert.ok(!encrypted.payloadEnvelope.includes('"cookies"'));
    phase = "same_chat_restoration";
    const second = await admit(first.chatId); await startSite(second); await browser(second, "restored"); const unchanged = await finish(second);
    assert.equal(unchanged.session.runtimeSandboxId, initial.session.runtimeSandboxId);
    assert.equal(unchanged.saved.versionId, initial.saved.versionId);
    phase = "new_vm_restoration";
    const third = await admit(); await startSite(third); await browser(third, "restored"); const restored = await finish(third);
    assert.notEqual(restored.session.runtimeSandboxId, initial.session.runtimeSandboxId);
    phase = "expired_session_relogin";
    const fourth = await admit(third.chatId); await startSite(fourth); await browser(fourth, "expired"); const renewed = await finish(fourth);
    assert.notEqual(renewed.saved.versionId, restored.saved.versionId);
    await secrets.mutate(userId, { action: "delete", id: renewed.saved.id, expectedVersionId: renewed.saved.versionId });
    phase = "manual_deletion_relogin";
    const fifth = await admit(third.chatId); await startSite(fifth); await browser(fifth, "deleted"); const recreated = await finish(fifth);
    assert.notEqual(recreated.saved.id, renewed.saved.id);
    process.stdout.write(JSON.stringify({ ok: true, realKvm: true, headlessChromium: true, guestRoot: true, guestMemoryMiB: config.memoryMiB,
      pythonPlaywright: "1.60.0", pyotp: "2.10.0", totp: true, cartScreenshot: true, personalRuns: 5, sameChat: true, newVm: true,
      encryptedReverseSave: true, unchangedRevision: true, expiredRelogin: true, settingsDeletion: true, invalidSkipped: 3, exportExcluded: true }) + "\n");
  } finally {
    step = "cleanup_sessions";
    for (const id of ownedSessions) {
      const session = await prisma.workspaceSession.findUnique({ where: { id } });
      if (!session) continue;
      const operation = { generation: session.version + 1, owner: "maintenance:browser-smoke-cleanup" };
      await runtime.claimSessionOperation!({ operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: id });
      await runtime.removeSession({ operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: id, signal: AbortSignal.timeout(60_000) });
    }
    if (created) {
      step = "cleanup_database";
      await prisma.attachment.deleteMany({ where: { userId } });
      await prisma.modelRun.deleteMany({ where: { userId } });
      await prisma.chat.updateMany({ where: { userId }, data: { activeLeafMessageId: null } });
      await prisma.message.deleteMany({ where: { chat: { userId } } });
      await prisma.workspaceSession.deleteMany({ where: { id: { in: [...ownedSessions] } } });
      await prisma.chat.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
    step = "cleanup_policy";
    await prisma.workspacePolicy.update({ where: { id: WORKSPACE_POLICY_ID }, data: oldPolicy });
    assert.equal((await runtime.listSessions!({ signal: AbortSignal.timeout(30_000) })).entries.length, 0);
    await prisma.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ cleanup: true }) + "\n");
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ ok: false, phase, step, code: error instanceof WorkspaceRuntimeError ? error.code
    : error instanceof AssertionError ? "assertion_failed" : error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "workspace_browser_smoke_failed",
    ...(error instanceof AssertionError ? { actualType: typeof error.actual, expectedType: typeof error.expected } : {}) }) + "\n");
  process.exitCode = 1;
});
