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
import { WORKSPACE_BROWSER_SESSION_MAX_BYTES } from "@/lib/contracts/workspaceSecrets";
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
/** The browser binding these runs are admitted with; the guest browser must use exactly it. */
const BROWSER_BINDING = { locale: "es-ES", timeZone: "Europe/Madrid" } as const;
/** Browser hosts and Chromium processes in the guest, counted without matching the counting command. */
const LEFTOVER_BROWSER_PROCESSES = "ps -eo args | grep -cE '[a]iqsa[.]browser[.]_host|[c]hromium-[0-9]+/chrome' || true";

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
  const workspace = { enabled: true as const, browser: BROWSER_BINDING, imageRef: config.imageRef, inboxIndexPath: "/workspace/inbox/index.json", internetEnabled: false,
    maxToolCalls: config.maxToolCalls, maxToolRounds: config.maxToolRounds, mcpVersion: catalog.mcpVersion,
    messageManifestPath: workspaceMessageManifestPath(userMessageId), outputDirectory: workspaceRunOutputDirectory(runId),
    projectDirectory: "/workspace/project", runtimeVersion: catalog.runtimeVersion, sessionId,
    syncToolTimeoutSeconds: config.syncToolTimeoutSeconds, toolCatalogHash: catalog.hash, turnTimeoutSeconds: config.turnTimeoutSeconds };
  const content = textMessageContent("Exercise the synthetic browser login and cart.");
  await admitPreparingRunWithClient(prisma, {
    admissionKind: "NORMAL_SEND", chatId: chat.id, content, expectedActiveLeafId: chat.activeLeafMessageId,
    modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId, workspaceEnabled: true,
    normalizedRequest: { attachmentIds: [], chatId: chat.id, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, toolCalling: true },
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

async function shell(run: Run, command: string): Promise<string> {
  const data = await call(run, "sandbox_shell", { command, treatNonZeroAsError: false });
  return typeof data.stdout === "string" ? data.stdout : "";
}

/** Synthetic saved sign-in of the fixture shop; typed only with `--env`, so it must never come back. */
const SHOP_LOGIN = "synthetic-login";
const SHOP_PASSWORD = "synthetic-password";
/** Everything the browser printed in this smoke, checked for the saved values once at the end of each turn. */
const browserOutputs: string[] = [];

/** One `aiqsa-browser` command as its own tool call; the browser stays open between them. */
async function aiqsaBrowser(run: Run, args: string): Promise<string> {
  const output = await shell(run, `aiqsa-browser ${args}`);
  browserOutputs.push(output);
  return output;
}

/** The number the latest page summary gives a synthetic element. */
function element(output: string, role: string, name: string): number {
  const match = new RegExp(`^\\[(\\d+)\\] ${role} "${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "mu").exec(output);
  assert.ok(match, `${role} element missing`);
  return Number(match[1]);
}

const python = (source: string) => `python3 -c "${source}"`;

async function browser(run: Run, mode: "login" | "restored" | "expired" | "deleted") {
  step = "browser_quiescence";
  // Every earlier turn of this chat ended with a VM stop: no browser host or Chromium survives into this one.
  assert.equal((await shell(run, LEFTOVER_BROWSER_PROCESSES)).trim(), "0");
  step = "browser_guest";
  const saved = mode === "restored" || mode === "expired";
  assert.equal((await shell(run, python("import importlib.metadata as m, os, pathlib, shutil; print(m.version('playwright'), " +
    "m.version('pyotp'), os.environ['PLAYWRIGHT_BROWSERS_PATH'], shutil.which('Xvfb') is None, os.getuid() == 0, " +
    "'SHOP_LOGIN' in pathlib.Path('/workspace/SECRETS.md').read_text(), pathlib.Path('/workspace/secrets/browser/shop.example.json').exists())"))).trim(),
  `1.60.0 2.10.0 /opt/aiqsa-playwright True True True ${saved ? "True" : "False"}`);
  if (mode === "expired") await shell(run, python("import os, urllib.request; urllib.request.urlopen(os.environ['SHOP_URL'] + '/expire', timeout=5).read()"));
  if (mode === "login") {
    step = "browser_default_launch";
    // A script's own default launch (no channel) still finds a browser: the shell's path runs the full build.
    assert.match(await shell(run, python("from playwright.sync_api import sync_playwright; p = sync_playwright().start(); " +
      "b = p.chromium.launch(); page = b.new_page(); page.set_content('<title>default launch</title>'); " +
      "print(page.title(), '|', b.version); b.close(); p.stop()")), /^default launch \| [0-9.]+$/mu);
  }
  step = "browser_open";
  let page = await aiqsaBrowser(run, 'open "$SHOP_URL"');
  assert.match(page, /^\[browser #1\] open @ 127\.0\.0\.1:18765\/$/mu);
  // The run's admitted language and zone reached the guest browser through the run environment.
  assert.match(page, new RegExp(`Started a new browser \\(Chromium [0-9.]+, language ${BROWSER_BINDING.locale}, time zone ` +
    `${BROWSER_BINDING.timeZone}\\); saved sign-ins restored: ${saved ? "shop\\.example" : "none"}\\.`, "u"));
  if (mode === "restored") {
    assert.match(page, /^Title: Синтетический магазин$/mu);
  } else {
    step = "browser_sign_in";
    // Separate tool calls drive one browser: the numbers of one call's output act in the next.
    await aiqsaBrowser(run, `type ${element(page, "textbox", "Login")} --env SHOP_LOGIN`);
    // The login went into a normal text field: it reads as a hidden value from now on.
    assert.match(await aiqsaBrowser(run, "info"), /^\[\d+\] textbox "Login" \(hidden value, filled[),]/mu);
    page = await aiqsaBrowser(run, `type ${element(page, "textbox", "Password")} --env SHOP_PASSWORD --submit`);
    page = await aiqsaBrowser(run, `type ${element(page, "textbox", "Verification code")} ` +
      `"$(${python("import os, pyotp; print(pyotp.TOTP(os.environ['SHOP_TOTP_SEED']).now())")})" --submit`);
    page = await aiqsaBrowser(run, `click ${element(page, "link", "Continue")}`);
    page = await aiqsaBrowser(run, `click ${element(page, "button", "Добавить в корзину")}`);
    page = await aiqsaBrowser(run, `click ${element(page, "link", "Continue")}`);
    assert.match(await aiqsaBrowser(run, "save-session shop.example"), /^\[browser #\d+\] save_session: shop\.example @ 127\.0\.0\.1:18765\/$/mu);
  }
  step = "browser_cart";
  const text = await aiqsaBrowser(run, "text");
  assert.match(text, /Корзина — тест Workspace/u);
  assert.match(text, /Книга Python/u);
  assert.equal((await shell(run, python("import json, os, urllib.request; " +
    "print(json.load(urllib.request.urlopen(os.environ['SHOP_URL'] + '/stats'))['logins'])"))).trim(), mode === "restored" ? "0" : "1");
  step = "browser_identity";
  const status = await aiqsaBrowser(run, "status --markers");
  const version = /^Chromium ([0-9.]+) \(pinned ([0-9.]+)\)/mu.exec(status);
  assert.ok(version && version[1] === version[2], "Chromium differs from the Playwright pin");
  for (const scope of ["page", "worker"]) {
    assert.match(status, new RegExp(`^Markers in ${scope} scope: webdriver=(false|null), headless user agent=false, brands=[^\\n]*, ` +
      `time zone=${BROWSER_BINDING.timeZone}, languages=${BROWSER_BINDING.locale}`, "mu"));
  }
  assert.doesNotMatch(status, /brands=[^\n]*Headless/u);
  step = "browser_screenshot";
  assert.match(await aiqsaBrowser(run, `shot --path ${run.workspace.outputDirectory}/cart.png`), /^Screenshot saved: .*\/cart\.png$/mu);
  step = "browser_saved_values";
  // Nothing the browser printed in this turn carries a value typed from the environment.
  assert.ok(browserOutputs.every((output) => !output.includes(SHOP_LOGIN) && !output.includes(SHOP_PASSWORD)));
  step = "browser_steps";
  // One browser served every call of this turn: its step numbers run on across them.
  const numbers = [...(await aiqsaBrowser(run, "steps")).matchAll(/^ {2}\[browser #(\d+)\] /gmu)].map((match) => Number(match[1]));
  assert.deepEqual(numbers, numbers.map((_, index) => index + 1));
  assert.ok(numbers.length >= (mode === "restored" ? 2 : 9));
  if (mode === "login") {
    await shell(run, python("import pathlib; state = pathlib.Path('/workspace/secrets/browser/shop.example.json'); " +
      "state.with_name('invalid.json').write_text('invalid synthetic state'); " +
      `state.with_name('oversized.json').write_bytes(b'x' * ${WORKSPACE_BROWSER_SESSION_MAX_BYTES + 1}); ` +
      "state.with_name('linked.json').symlink_to(state)"));
  }
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
      { name: "SHOP_URL", value: "http://127.0.0.1:18765" }, { name: "SHOP_LOGIN", value: SHOP_LOGIN },
      { name: "SHOP_PASSWORD", value: SHOP_PASSWORD }, { name: "SHOP_TOTP_SEED", value: "JBSWY3DPEHPK3PXP" }
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
    process.stdout.write(JSON.stringify({ ok: true, realKvm: true, fullChromium: true, chromiumMatchesPin: true, guestRoot: true,
      guestMemoryMiB: config.memoryMiB, pythonPlaywright: "1.60.0", pyotp: "2.10.0", oneBrowserAcrossCalls: true,
      noMarkersPageAndWorker: true, admittedLocaleAndZone: true, noBrowserSurvivesTurn: true, savedValuesNeverPrinted: true,
      defaultLaunchRunsFullChromium: true, totp: true, cartScreenshot: true,
      personalRuns: 5, sameChat: true, newVm: true, encryptedReverseSave: true, unchangedRevision: true, expiredRelogin: true,
      settingsDeletion: true, invalidSkipped: 3, exportExcluded: true }) + "\n");
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
