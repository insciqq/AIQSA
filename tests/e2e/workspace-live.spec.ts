import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { createWorkspaceRuntime } from "../../lib/server/workspace/defaultRuntime";
import { runWorkspaceMaintenance } from "../../lib/server/workspace/cleanup";
import { removeWorkspaceForDeletion } from "../../lib/server/workspace/removal";
import { getWorkspaceConfig } from "../../lib/server/workspace/config";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import {
  activeChatId,
  bytesFromDownload,
  lastActivity,
  lastAnswer,
  loginWithPassword,
  openLastActivity,
  openWorkspaceDetails,
  selectFakeModel,
  startNewChat,
  turnWorkspaceOn
} from "./support/workspace";
import { prepareWorkspaceFakeContext } from "./support/workspaceFixture";

const prisma = new PrismaClient();
const liveEnabled = process.env.AIQSA_WORKSPACE_LIVE_E2E === "DISPOSABLE";
let restoreFakeContext: (() => Promise<void>) | null = null;

test.skip(!liveEnabled, "requires an explicitly disposable KVM Microsandbox topology");
test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

// The multi-round live tool loop does not fit Fake QSA's 8k seed window; like
// the other Workspace specs, use the 64k fake context so it never compacts.
test.beforeAll(async () => {
  restoreFakeContext = await prepareWorkspaceFakeContext(prisma);
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function tarContents(gzip: Uint8Array): Readonly<{
  entries: ReadonlySet<string>;
  files: ReadonlyMap<string, Buffer>;
  linkTargets: ReadonlyMap<string, string>;
  types: ReadonlyMap<string, string>;
}> {
  const archive = gunzipSync(gzip);
  const entries = new Set<string>();
  const files = new Map<string, Buffer>();
  const linkTargets = new Map<string, string>();
  const types = new Map<string, string>();
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start: number, end: number) => Buffer.from(header.subarray(start, end))
      .toString("utf8")
      .replace(/\0.*$/u, "");
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join("/")
      .replace(/^\.\//u, "");
    const size = Number.parseInt(text(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataOffset = offset + 512;
    entries.add(name);
    types.set(name, type);
    if (type === "0" || type === "\0") {
      files.set(name, Buffer.from(archive.subarray(dataOffset, dataOffset + size)));
    } else if (type === "2") {
      linkTargets.set(name, text(157, 257));
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return { entries, files, linkTargets, types };
}

function workspaceDetails(page: Page) {
  return page.getByRole("button", { name: /^Workspace details\./u });
}

/** The Workspace layer's administrator note about guest internet access. */
async function expectWorkspaceInternet(page: Page, state: "On" | "Off"): Promise<void> {
  const layer = await openWorkspaceDetails(page);
  await expect(layer).toContainText(`Internet: ${state}. Managed by the administrator.`);
  await page.keyboard.press("Escape");
  await expect(layer).toBeHidden();
}

/** A long Workspace turn can fill most of the fake context window, so the
 * product may suggest a continuation by opening the Chat context panel. Stay here. */
async function stayInChat(page: Page): Promise<void> {
  await expect(page.getByTestId("header-context-indicator"))
    .toHaveAttribute("data-context-estimate", "snapshot", { timeout: 30_000 });
  const context = page.getByRole("dialog", { name: "Chat context", exact: true });
  if (!await context.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) return;
  await context.getByRole("button", { name: "Stay here", exact: true }).click();
  await expect(context).toHaveCount(0);
}

async function sendAndExpect(
  page: Page,
  prompt: string,
  answer: string,
  timeout = 360_000
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    const response = page.waitForResponse((value) => value.request().method() === "POST" &&
      /\/api\/chats\/[^/]+\/messages$/u.test(new URL(value.url()).pathname));
    await composer.press("Enter");
    const admitted = await response;
    if (admitted.ok()) break;
    // Published files can precede the exporter retiring its receiver. Retry
    // only this explicit, non-admitted conflict and preserve the user's draft.
    expect(admitted.status()).toBe(409);
    expect(await admitted.json()).toMatchObject({ error: "workspace_busy" });
    await expect(composer).toHaveValue(prompt);
    expect(attempt).toBeLessThan(2);
    const chatId = await activeChatId(page);
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({
      select: { operationOwner: true }, where: { chatId }
    })).operationOwner, { timeout: 45_000 }).toBeNull();
  }
  await expect(lastAnswer(page)).toContainText(answer, { timeout });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
    timeout: 30_000
  });
  await stayInChat(page);
}

async function openChatActions(page: Page) {
  await page.getByRole("button", { exact: true, name: "Chat actions" }).click();
  const menu = page.getByRole("menu", { name: "Chat actions" });
  await expect(menu).toBeVisible();
  return menu;
}

async function resetWorkspace(page: Page): Promise<void> {
  const menu = await openChatActions(page);
  await menu.getByRole("menuitem", { name: "Reset workspace…" }).click();
  const confirmation = page.getByRole("dialog", { name: "Reset workspace" });
  await confirmation.getByRole("button", { name: "Confirm reset workspace" }).click();
  await expect(confirmation).toHaveCount(0, { timeout: 120_000 });
  await expect(workspaceDetails(page)).toHaveAccessibleName(/Workspace has not started$/u);
}

async function setAdminPolicy(
  page: Page,
  input: Readonly<{ enabled: boolean; internetEnabled: boolean }>
): Promise<void> {
  await page.goto("/admin?section=workspace");
  const policy = page.getByRole("region", { name: "Workspace policy" });
  await expect(policy.getByText("Ready", { exact: true })).toBeVisible({ timeout: 120_000 });
  // The installation may already match (the seed enables both); the admin
  // confirms only an actual change, so check the persisted policy as well.
  let changed = false;
  const enabled = policy.getByLabel("Enable Workspace");
  if ((await enabled.isChecked()) !== input.enabled) {
    await enabled.click();
    changed = true;
  }
  if (input.enabled) await expect(enabled).toBeChecked();
  else await expect(enabled).not.toBeChecked();
  const internet = policy.getByLabel("Allow public internet in new workspaces");
  if ((await internet.isChecked()) !== input.internetEnabled) {
    await internet.click();
    changed = true;
  }
  if (input.internetEnabled) await expect(internet).toBeChecked();
  else await expect(internet).not.toBeChecked();
  if (changed) await expect(page.getByTestId("admin-feedback")).toContainText("Workspace policy updated.");
  await expect.poll(() => prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true, internetEnabled: true },
    where: { id: "installation" }
  })).toEqual(input);
}

async function generatedArchive(page: Page, chatId: string): Promise<Readonly<{
  bytes: Buffer;
  href: string;
}>> {
  const files = page.getByRole("region", { name: "Generated files" }).last();
  await expect(files).toContainText("result.tar.gz", { timeout: 120_000 });
  const link = files.getByRole("link", { name: "Download" });
  const href = await link.getAttribute("href");
  if (!href) throw new Error("workspace_live_output_href_missing");
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  const bytes = await response.body();
  const output = await prisma.attachment.findFirstOrThrow({
    select: { byteSize: true, checksum: true, mimeType: true },
    where: { chatId, fileName: "result.tar.gz", origin: "WORKSPACE_OUTPUT" }
  });
  expect(bytes.byteLength).toBe(output.byteSize);
  expect(sha256(bytes)).toBe(output.checksum);
  expect(output.mimeType).toBe("application/gzip");
  return { bytes, href };
}

test("real KVM Workspace preserves its disk across terminal stop, exports, resets, and enforces no-network", async ({ browser }) => {
  const config = getWorkspaceConfig({
    ...process.env,
    AIQSA_TEST_MODE: "1",
    AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0"
  });
  expect(config.runtimeMode).toBe("remote");
  const runtime = createWorkspaceRuntime(config);
  const originalPolicy = await prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true, internetEnabled: true },
    where: { id: "installation" }
  });
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext({ acceptDownloads: true });
  const adminPage = await adminContext.newPage();
  const page = await userContext.newPage();
  const createdChatIds: string[] = [];

  try {
    await signInWithLocalToken(adminPage);
    await setAdminPolicy(adminPage, { enabled: true, internetEnabled: true });

    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await startNewChat(page);
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await selectFakeModel(page);
    await turnWorkspaceOn(page);
    await expectWorkspaceInternet(page, "On");

    const arbitraryBytes = Buffer.from(Array.from({ length: 8_192 }, (_, index) => index % 251));
    await page.getByLabel("Attach files").setInputFiles({
      buffer: arbitraryBytes,
      mimeType: "application/x-aiqsa-live-binary",
      name: "live-opaque.aiqsa-live"
    });
    const attachment = page.getByRole("region", { name: "Attachments" })
      .getByRole("listitem")
      .filter({ hasText: "live-opaque.aiqsa-live" });
    // A Workspace-only original reads "Available in Workspace" once it is ready.
    await expect(attachment).toHaveAttribute("data-attachment-status", "ready", { timeout: 30_000 });
    await expect(attachment).toContainText("Available in Workspace");

    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:live_prepare]",
      "Live Workspace completed shell, Python, Node, pip, npm, network, and archive checks."
    );
    const onlineChatId = await activeChatId(page);
    createdChatIds.push(onlineChatId);
    await expect(workspaceDetails(page)).toHaveAccessibleName(/Workspace stopped$/u, { timeout: 30_000 });
    const activity = await openLastActivity(page);
    await expect(activity).toContainText("Worked in Workspace");
    await expect(activity).toContainText("Ran set -eu && test -s /workspace/inbox/index.json");
    await expect(activity).toContainText("Exported 1 file", { timeout: 30_000 });
    expect(await activity.textContent()).not.toMatch(/sandbox_|mcp_workspace|Used Workspace/u);
    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:live_quiesce_probe]",
      "Workspace finalization stopped the long-running command."
    );

    // Incremental staging on a real guest: unchanged originals keep their mtimes across turns.
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:live_staging_probe]", "Inbox mtimes:");
    const firstMtimes = await lastAnswer(page).textContent();
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:live_staging_probe]", "Inbox mtimes:");
    const secondMtimes = await lastAnswer(page).textContent();
    // Compare only the guest's answer line: the activity timeline above it
    // legitimately differs between turns (durations).
    const mtimesLine = (text: string | null) =>
      text?.match(/Inbox mtimes: (\/workspace\/inbox\/messages\/\S+ \d+)/u)?.[1] ?? null;
    expect(mtimesLine(firstMtimes)).toMatch(/^\/workspace\/inbox\/messages\/\S+ \d+$/u);
    expect(mtimesLine(secondMtimes)).toBe(mtimesLine(firstMtimes));

    // Stop after a real exec_start: the delayed marker must never appear and no
    // registered execution may stay open.
    const stopComposer = page.getByRole("textbox", { name: "Message" });
    await stopComposer.fill("[AIQSA_WORKSPACE_E2E:live_async_stop]");
    await stopComposer.press("Enter");
    const stopButton = page.getByRole("button", { name: "Stop answer" });
    await expect(stopButton).toBeEnabled({ timeout: 30_000 });
    const liveActivity = lastActivity(page);
    await expect(liveActivity).toContainText("Running sleep 300", { timeout: 120_000 });
    await expect(liveActivity).toContainText("Running sleep 12; echo late");
    await stopButton.click();
    await expect(stopButton).toHaveCount(0, { timeout: 60_000 });
    await expect(lastAnswer(page)).toContainText("Stopped");
    // The stopped turn's own timeline closes the terminated command without
    // inventing an exit, as in the deterministic Stop scenario.
    await expect(liveActivity).toContainText(
      "sleep 300; echo late > /workspace/project/sync-after-stop.txt · exit not observed",
      { timeout: 30_000 }
    );
    await expect(liveActivity).toContainText("Workspace work stopped");
    await expect(workspaceDetails(page)).not.toHaveAccessibleName(/Running a command/u, { timeout: 30_000 });
    await page.waitForTimeout(13_000);
    const stoppedSession = await prisma.workspaceSession.findUniqueOrThrow({
      select: { id: true, state: true },
      where: { chatId: onlineChatId }
    });
    expect(stoppedSession.state).toBe("STOPPED");
    await expect.poll(async () => prisma.workspaceExecution.count({
      where: { state: { in: ["ACTIVE", "TERMINATING"] }, workspaceSessionId: stoppedSession.id }
    })).toBe(0);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:live_marker_probe]", "Late marker absent after Stop.");

    const output = await generatedArchive(page, onlineChatId);
    const outputFiles = tarContents(output.bytes).files;
    expect(outputFiles.get("persisted.txt")?.toString("utf8")).toBe("workspace-state-v1\n");
    expect(outputFiles.get("python.txt")?.toString("utf8")).toBe("python-ok\n");
    expect(outputFiles.get("node.txt")?.toString("utf8")).toBe("node-ok\n");
    expect(outputFiles.get("pip.txt")?.toString("utf8")).toBe("3.10\n");
    expect(outputFiles.get("npm.txt")?.toString("utf8")).toBe("npm-ok\n");
    expect(outputFiles.get("public.txt")?.toString("utf8")).toBe("public-ok\n");
    expect(outputFiles.get("private-blocked.txt")?.toString("utf8")).toBe("private-blocked\n");

    const onlineSession = await prisma.workspaceSession.findUniqueOrThrow({
      where: { chatId: onlineChatId }
    });
    await prisma.workspaceSession.update({
      data: { lastActiveAt: new Date(Date.now() - (config.idleTtlSeconds + 5) * 1_000) },
      where: { id: onlineSession.id }
    });
    const maintenance = await runWorkspaceMaintenance({ config, prisma, runtime });
    // Terminal retirement has already stopped this disk. Idle maintenance
    // must leave that proven state alone before the archive resumes it.
    expect(onlineSession.state).toBe("STOPPED");
    expect(maintenance.idleStopped).toBe(0);
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { id: onlineSession.id }
    })).state).toBe("STOPPED");

    const archiveResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/chats/${onlineChatId}/workspace/archive`
    );
    const archiveDownload = page.waitForEvent("download", { timeout: 360_000 });
    const actions = await openChatActions(page);
    await actions.getByRole("menuitem", { name: "Download workspace" }).click();
    const archiveHttpResponse = await archiveResponse;
    if (!archiveHttpResponse.ok()) void archiveDownload.catch(() => undefined);
    expect(archiveHttpResponse.status()).toBe(200);
    const downloaded = await archiveDownload;
    expect(downloaded.suggestedFilename()).toBe("workspace.tar.gz");
    const archiveBytes = await bytesFromDownload(downloaded);
    await expect.poll(async () => prisma.attachment.findFirst({
      select: { byteSize: true, checksum: true },
      where: { chatId: onlineChatId, origin: "WORKSPACE_EXPORT" }
    }), { timeout: 120_000 }).not.toBeNull();
    const exportAttachment = await prisma.attachment.findFirstOrThrow({
      select: { byteSize: true, checksum: true },
      where: { chatId: onlineChatId, origin: "WORKSPACE_EXPORT" }
    });
    expect(archiveBytes.byteLength).toBe(exportAttachment!.byteSize);
    expect(sha256(archiveBytes)).toBe(exportAttachment!.checksum);
    const archiveContents = tarContents(archiveBytes);
    const archiveFiles = archiveContents.files;
    expect(archiveFiles.get("persisted.txt")?.toString("utf8")).toBe("workspace-state-v1\n");
    expect(archiveFiles.get("pip.txt")?.toString("utf8")).toBe("3.10\n");
    expect(archiveFiles.get("npm.txt")?.toString("utf8")).toBe("npm-ok\n");
    expect(archiveContents.types.get("archive-symlink-must-not-export")).toBe("2");
    expect(archiveContents.linkTargets.get("archive-symlink-must-not-export")).toBe("/etc/passwd");
    expect(archiveContents.files.has("archive-symlink-must-not-export")).toBe(false);
    expect(archiveContents.types.get("archive-fifo-must-not-export")).toBe("6");
    expect(archiveContents.files.has("archive-fifo-must-not-export")).toBe(false);

    const versionBeforeReset = onlineSession.version;
    await resetWorkspace(page);
    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:reset_probe]",
      "Workspace reset removed the old state."
    );
    const resetSession = await prisma.workspaceSession.findUniqueOrThrow({
      where: { chatId: onlineChatId }
    });
    expect(resetSession.version).toBeGreaterThan(versionBeforeReset);
    const preservedOutput = await page.request.get(output.href);
    expect(preservedOutput.status()).toBe(200);
    expect((await preservedOutput.body()).equals(output.bytes)).toBe(true);
    await resetWorkspace(page);

    await setAdminPolicy(adminPage, { enabled: true, internetEnabled: false });
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await startNewChat(page);
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await selectFakeModel(page);
    await turnWorkspaceOn(page);
    await expectWorkspaceInternet(page, "Off");
    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:network_off_probe]",
      "Workspace network is blocked while execution remains available."
    );
    const offlineChatId = await activeChatId(page);
    createdChatIds.push(offlineChatId);
    const offlineSession = await prisma.workspaceSession.findUniqueOrThrow({
      select: { internetEnabled: true },
      where: { chatId: offlineChatId }
    });
    expect(offlineSession.internetEnabled).toBe(false);
    await resetWorkspace(page);
  } finally {
    for (const chatId of createdChatIds) {
      const session = await prisma.workspaceSession.findUnique({ where: { chatId } });
      if (session?.runtimeSandboxId) {
        await page.request.delete(`/api/chats/${chatId}`);
        await removeWorkspaceForDeletion({ now: new Date(), prisma, runtime, sessionId: session.id });
      }
      await page.request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    }
    await prisma.workspacePolicy.update({
      data: originalPolicy,
      where: { id: "installation" }
    }).catch(() => undefined);
    await adminContext.close();
    await userContext.close();
  }
});

test.afterAll(async () => {
  try {
    await restoreFakeContext?.();
  } finally {
    await prisma.$disconnect();
  }
});
