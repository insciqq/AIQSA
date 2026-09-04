import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Download, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { createWorkspaceRuntime } from "../../lib/server/workspace/defaultRuntime";
import { runWorkspaceMaintenance } from "../../lib/server/workspace/cleanup";
import { getWorkspaceConfig } from "../../lib/server/workspace/config";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { selectModel } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
const liveEnabled = process.env.AIQSA_WORKSPACE_LIVE_E2E === "DISPOSABLE";

test.skip(!liveEnabled, "requires an explicitly disposable KVM Microsandbox topology");
test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

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

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("workspace_live_download_stream_unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function login(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.removeItem("aiqsa.activeChatId"));
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_MCP_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_MCP_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
}

async function selectFakeModel(page: Page): Promise<void> {
  await selectModel(page, providerTemplateIds.fakeConnection, "Fake QSA", "Fake QSA");
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
}

async function enableWorkspace(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Turn on Workspace/u });
  await expect(toggle).toBeEnabled({ timeout: 30_000 });
  await toggle.click();
  await expect(page.getByRole("button", { name: /^Turn off Workspace/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
}

async function sendAndExpect(
  page: Page,
  prompt: string,
  answer: string,
  timeout = 360_000
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText(answer, {
    timeout
  });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
    timeout: 30_000
  });
}

async function activeChatId(page: Page): Promise<string> {
  let chatId: string | null = null;
  await expect.poll(async () => {
    chatId = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
    return chatId;
  }, { timeout: 30_000 }).not.toBeNull();
  return chatId!;
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
  await expect(page.locator(".v2-composer-workspace-state")).toHaveText(
    "Workspace has not started"
  );
}

async function setAdminPolicy(
  page: Page,
  input: Readonly<{ enabled: boolean; internetEnabled: boolean }>
): Promise<void> {
  await page.goto("/admin?section=workspace");
  const policy = page.getByRole("region", { name: "Workspace policy" });
  await expect(policy.getByText("Ready", { exact: true })).toBeVisible({ timeout: 120_000 });
  const enabled = policy.getByLabel("Enable Workspace");
  if ((await enabled.isChecked()) !== input.enabled) await enabled.click();
  if (input.enabled) await expect(enabled).toBeChecked();
  else await expect(enabled).not.toBeChecked();
  const internet = policy.getByLabel("Allow public internet in new workspaces");
  if ((await internet.isChecked()) !== input.internetEnabled) await internet.click();
  if (input.internetEnabled) await expect(internet).toBeChecked();
  else await expect(internet).not.toBeChecked();
  await expect(policy.getByRole("status")).toContainText("Workspace policy updated.");
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

test("real KVM Workspace survives idle stop, exports after restart, resets, and enforces no-network", async ({ browser }) => {
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

    await login(page);
    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await selectFakeModel(page);
    await enableWorkspace(page);
    await expect(page.getByLabel("Internet in Workspace is enabled")).toBeVisible();

    const arbitraryBytes = Buffer.from(Array.from({ length: 8_192 }, (_, index) => index % 251));
    await page.getByLabel("Attach files").setInputFiles({
      buffer: arbitraryBytes,
      mimeType: "application/x-aiqsa-live-binary",
      name: "live-opaque.aiqsa-live"
    });
    const attachment = page.getByRole("region", { name: "Attachments" })
      .getByRole("listitem")
      .filter({ hasText: "live-opaque.aiqsa-live" });
    await expect(attachment).toContainText("Ready", { timeout: 30_000 });

    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:live_prepare]",
      "Live Workspace completed shell, Python, Node, pip, npm, network, and archive checks."
    );
    const onlineChatId = await activeChatId(page);
    createdChatIds.push(onlineChatId);
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText("Workspace ready");
    const activity = page.getByTestId("tool-activity-disclosure").last();
    await activity.locator(":scope > summary").click();
    await expect(activity).toContainText("Worked in Workspace");
    await expect(activity).toContainText("Ran set -eu && test -s /workspace/inbox/index.json");
    await expect(activity).toContainText("Exported 1 file");
    expect(await activity.textContent()).not.toMatch(/sandbox_|mcp_workspace|Used Workspace/u);
    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:live_quiesce_probe]",
      "Workspace finalization stopped the long-running command."
    );

    // Incremental staging on a real guest: unchanged originals keep their mtimes across turns.
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:live_staging_probe]", "Inbox mtimes:");
    const firstMtimes = await page.locator('article[data-role="assistant"]').last().textContent();
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:live_staging_probe]", "Inbox mtimes:");
    const secondMtimes = await page.locator('article[data-role="assistant"]').last().textContent();
    expect(firstMtimes).toMatch(/Inbox mtimes: \/workspace\/inbox\/messages\/\S+ \d+/u);
    expect(secondMtimes).toBe(firstMtimes);

    // Stop after a real exec_start: the delayed marker must never appear and no
    // registered execution may stay open.
    const stopComposer = page.getByRole("textbox", { name: "Message" });
    await stopComposer.fill("[AIQSA_WORKSPACE_E2E:live_async_stop]");
    await stopComposer.press("Enter");
    const stopButton = page.getByRole("button", { name: "Stop answer" });
    await expect(stopButton).toBeEnabled({ timeout: 30_000 });
    const liveActivity = page.getByTestId("tool-activity-disclosure").last();
    await expect(liveActivity).toContainText("Running sleep 300", { timeout: 120_000 });
    await expect(liveActivity).toContainText("Running sleep 12; echo late");
    await stopButton.click();
    await expect(stopButton).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Stopped");
    await expect(page.locator(".v2-composer-workspace-state")).not.toContainText("Running a command", { timeout: 30_000 });
    await page.waitForTimeout(13_000);
    const stoppedSession = await prisma.workspaceSession.findUniqueOrThrow({
      select: { id: true, state: true },
      where: { chatId: onlineChatId }
    });
    expect(["READY", "STOPPED"]).toContain(stoppedSession.state);
    await expect.poll(async () => prisma.workspaceExecution.count({
      where: { state: { in: ["ACTIVE", "TERMINATING"] }, workspaceSessionId: stoppedSession.id }
    })).toBe(0);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:live_marker_probe]", "Late marker absent after Stop.");
    await expect(page.getByTestId("tool-activity-disclosure").last()).toContainText("Stopped sleep 300");

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
    expect(maintenance.idleStopped).toBe(1);
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
    const archiveBytes = await downloadBytes(downloaded);
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
    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await selectFakeModel(page);
    await enableWorkspace(page);
    await expect(page.getByLabel("Internet in Workspace is disabled")).toBeVisible();
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
        await runtime.removeSession({
          runtimeSandboxId: session.runtimeSandboxId,
          sessionId: session.id
        }).catch(() => undefined);
        await prisma.workspaceSession.updateMany({
          data: { runtimeSandboxId: null, state: "PENDING" },
          where: { id: session.id }
        }).catch(() => undefined);
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
  await prisma.$disconnect();
});
