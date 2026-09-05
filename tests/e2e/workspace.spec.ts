import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Download, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import {
  LOCAL_MCP_MEMBER,
  LOCAL_RESTRICTED_MEMBER
} from "../../prisma/local-seed-fixtures";
import { selectModel } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";
import { disableMemoryRecall } from "./support/workspace";

const prisma = new PrismaClient();
const RESULT_ZIP = Buffer.from(
  "UEsDBBQAAAAAAAAAIQDtsuv+JQAAACUAAAAKAAAAcmVzdWx0LnR4dEFJUVNBIGRldGVybWluaXN0aWMgd29ya3NwYWNlIHJlc3VsdApQSwECFAMUAAAAAAAAACEA7bLr/iUAAAAlAAAACgAAAAAAAAAAAAAApIEAAAAAcmVzdWx0LnR4dFBLBQYAAAAAAQABADgAAABNAAAAAAA=",
  "base64"
);

let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;

test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loginWithPassword(
  page: Page,
  user: Readonly<{ email: string; password: string }>
): Promise<void> {
  await page.addInitScript(() => {
    const key = "aiqsa.workspace.e2e.cleared";
    if (window.sessionStorage.getItem(key) === "1") return;
    window.localStorage.removeItem("aiqsa.activeChatId");
    window.sessionStorage.setItem(key, "1");
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await disableMemoryRecall(page);
}

async function selectFakeModel(page: Page): Promise<void> {
  await selectModel(page, providerTemplateIds.fakeConnection, "Fake QSA", "Fake QSA");
  await expect(page.getByTestId("header-model-trigger")).toContainText("Fake QSA");
}

async function turnWorkspaceOn(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Turn on Workspace/u });
  await expect(toggle).toBeEnabled({ timeout: 15_000 });
  await toggle.click();
  await expect(page.getByRole("button", { name: /^Turn off Workspace/u })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
}

async function activeChatId(page: Page): Promise<string> {
  let value: string | null = null;
  await expect.poll(async () => {
    value = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
    return value;
  }).not.toBeNull();
  return value!;
}

async function sendAndExpect(page: Page, prompt: string, answer: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await composer.press("Enter");
  await expect(page.locator('article[data-role="assistant"]').last()).toContainText(answer, {
    timeout: 45_000
  });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, {
    timeout: 45_000
  });
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("workspace_download_stream_unavailable");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function assertGeneratedZip(page: Page): Promise<Readonly<{
  checksum: string;
  href: string;
}>> {
  const files = page.getByRole("region", { name: "Generated files" }).last();
  await expect(files).toContainText("result.zip", { timeout: 30_000 });
  const link = files.getByRole("link", { name: "Download" });
  const href = await link.getAttribute("href");
  if (!href) throw new Error("workspace_download_href_missing");

  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/^application\/zip(?:;|$)/u);
  const responseBytes = await response.body();
  expect(responseBytes.equals(RESULT_ZIP)).toBe(true);
  expect(responseBytes.includes(Buffer.from("result.txt"))).toBe(true);
  expect(responseBytes.includes(Buffer.from("AIQSA deterministic workspace result\n"))).toBe(true);

  const pending = page.waitForEvent("download");
  await link.click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("result.zip");
  const browserBytes = await bytesFromDownload(download);
  expect(browserBytes.equals(RESULT_ZIP)).toBe(true);
  return { checksum: sha256(browserBytes), href };
}

function sharedProjects(page: Page) {
  return page.locator('section[aria-label="Shared projects"]');
}

function projectRow(page: Page, projectName: string) {
  return sharedProjects(page).locator(".v2-project-row").filter({ hasText: projectName });
}

async function createProjectThroughUi(page: Page, projectName: string): Promise<string> {
  await page.getByRole("button", { exact: true, name: "Projects" }).click();
  await expect(sharedProjects(page)).toBeVisible();
  await sharedProjects(page).getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByLabel("Name", { exact: true }).fill(projectName);
  await dialog.getByLabel("Description").fill("Disposable Workspace permission test.");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("project-overview-page").getByRole("heading", {
    level: 1,
    name: projectName
  })).toBeVisible();
  return (await prisma.project.findFirstOrThrow({
    select: { id: true },
    where: { name: projectName }
  })).id;
}

async function addContributorThroughUi(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { exact: true, name: `${projectName} details` }).click();
  const settings = page.getByRole("dialog", { name: `${projectName} settings` });
  await settings.getByRole("button", { name: "Members", exact: true }).dispatchEvent("click");
  await settings.getByLabel("Search people").fill(LOCAL_RESTRICTED_MEMBER.email);
  const candidate = settings.getByRole("option", {
    name: new RegExp(LOCAL_RESTRICTED_MEMBER.displayName, "u")
  });
  await expect(candidate).toBeVisible({ timeout: 30_000 });
  await candidate.click();
  await settings.getByLabel("Project role").selectOption("CONTRIBUTOR");
  await settings.getByRole("button", { name: "Add access", exact: true }).click();
  const confirmation = settings.getByRole("alertdialog", { name: "Confirm Project access" });
  await confirmation.getByRole("button", { name: "Add access" }).click();
  await expect(settings.locator(".v2-project-list-row").filter({
    hasText: LOCAL_RESTRICTED_MEMBER.email
  })).toBeVisible();
  await settings.getByRole("button", { name: "Close project settings" }).click();
}

async function openProject(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { exact: true, name: "Projects" }).click();
  await expect(projectRow(page, projectName)).toBeVisible({ timeout: 30_000 });
  await projectRow(page, projectName).click();
  await expect(page.getByTestId("project-overview-page").getByRole("heading", {
    level: 1,
    name: projectName
  })).toBeVisible();
  await page.getByRole("button", { name: "Start shared chat" }).click();
  await expect(page.getByTestId("header-model-trigger")).toBeVisible({ timeout: 15_000 });
}

async function revokeContributorThroughUi(page: Page, projectName: string): Promise<void> {
  const overviewDetails = page.getByRole("button", { exact: true, name: `${projectName} details` });
  if (await overviewDetails.isVisible()) {
    await overviewDetails.click();
  } else {
    const context = page.getByRole("complementary", { name: "Shared project context" });
    await context.getByTestId("project-context-trigger").click();
    await page.getByRole("dialog", { name: `${projectName} project context` })
      .getByRole("button", { name: "Project details" })
      .click();
  }
  const settings = page.getByRole("dialog", { name: `${projectName} settings` });
  await settings.getByRole("button", { name: "Members", exact: true }).dispatchEvent("click");
  const member = settings.locator(".v2-project-list-row").filter({
    hasText: LOCAL_RESTRICTED_MEMBER.email
  });
  await member.getByRole("button", { name: "Remove access" }).click();
  const confirmation = settings.getByRole("alertdialog", {
    name: "Confirm Project access removal"
  });
  await confirmation.getByRole("button", { name: "Remove access" }).click();
  await expect(member).toHaveCount(0);
}

function jsonRecord(value: Prisma.JsonValue): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(cloned)) throw new Error("workspace_model_config_invalid");
  return cloned;
}

test.afterAll(async () => {
  if (originalPolicy) {
    await prisma.workspacePolicy.update({
      data: originalPolicy,
      where: { id: "installation" }
    }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

test("administrator enables a ready Workspace with public internet", async ({ page }) => {
  originalPolicy = await prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true, internetEnabled: true },
    where: { id: "installation" }
  });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=workspace");
  const policy = page.getByRole("region", { name: "Workspace policy" });
  await expect(policy.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(policy).toContainText("Runtime 0.6.16 · MCP 0.6.16");
  const enabled = policy.getByLabel("Enable Workspace");
  if (!(await enabled.isChecked())) await enabled.click();
  await expect(enabled).toBeChecked();
  const internet = policy.getByLabel("Allow public internet in new workspaces");
  if (!(await internet.isChecked())) await internet.click();
  await expect(internet).toBeChecked();
  await expect(policy.getByRole("status")).toContainText("Workspace policy updated.");
});

test("personal Workspace runs tools, preserves state, exports bytes, stops, resets, and rejects forged admission", async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let chatId: string | null = null;
  let modelSnapshot: Readonly<{
    activeConfig: Prisma.JsonValue;
    capabilities: Prisma.JsonValue;
  }> | null = null;
  let latestMessageBody: Record<string, unknown> | null = null;
  page.on("request", (request) => {
    if (request.method() !== "POST" || !/\/api\/chats\/[^/]+\/messages$/u.test(request.url())) return;
    try {
      const body = request.postDataJSON() as unknown;
      if (isRecord(body)) latestMessageBody = body;
    } catch {
      // Only ordinary JSON message admission requests are relevant here.
    }
  });

  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await selectFakeModel(page);
    await turnWorkspaceOn(page);
    await expect(page.getByLabel("Internet in Workspace is enabled")).toBeVisible();

    await page.getByLabel("Attach files").setInputFiles([
      {
        buffer: Buffer.from([0, 1, 2, 3, 254, 255]),
        mimeType: "application/x-aiqsa-workspace-e2e",
        name: "opaque-input.aiqsa-e2e"
      },
      {
        buffer: Buffer.from("%PDF-not-a-complete-document\n", "ascii"),
        mimeType: "application/pdf",
        name: "processing-evidence.pdf"
      }
    ]);
    const attachments = page.getByRole("region", { name: "Attachments" });
    await expect(attachments.getByRole("listitem")).toHaveCount(2);
    const pdf = attachments.getByRole("listitem").filter({ hasText: "processing-evidence.pdf" });
    await expect(pdf).toHaveAttribute("data-attachment-status", /^(processing|failed)$/u);
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:deterministic_prepare]",
      "Workspace read the staged input and created result.zip."
    );
    chatId = await activeChatId(page);
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText("Workspace stopped", { timeout: 30_000 });
    const activity = page.getByTestId("tool-activity-disclosure").last();
    await activity.locator(":scope > summary").click();
    await expect(activity).toContainText("Worked in Workspace");
    await expect(activity).toContainText("Prepared 2 attachments");
    await expect(activity).toContainText("Read inbox/index.json");
    await expect(activity).toContainText(/Read inbox\/(?:opaque-input\.aiqsa-e2e|processing-evidence\.pdf)/u);
    await expect(activity).toContainText("Wrote project/persisted.txt");
    await expect(activity).toContainText("Exported 1 file", { timeout: 30_000 });
    expect(await activity.textContent()).not.toMatch(/sandbox_|Used Workspace/u);

    const first = await assertGeneratedZip(page);
    expect(first.checksum).toBe(sha256(RESULT_ZIP));
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const afterReload = await assertGeneratedZip(page);
    expect(afterReload).toEqual(first);

    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:state_probe]",
      "Workspace state persisted."
    );

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("[AIQSA_WORKSPACE_E2E:long_command]");
    await composer.press("Enter");
    const stop = page.getByRole("button", { name: "Stop answer" });
    await expect(stop).toBeEnabled({ timeout: 15_000 });
    await expect(page.locator(".v2-composer-workspace-state")).toContainText("Running a command");
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Stopped");

    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:state_probe]",
      "Workspace state persisted."
    );

    const chatActions = page.getByRole("button", { exact: true, name: "Chat actions" });
    await expect(chatActions).toBeVisible({ timeout: 10_000 });
    await chatActions.click({ timeout: 10_000 });
    const actionsMenu = page.getByRole("menu", { name: "Chat actions" });
    await expect(actionsMenu).toBeVisible({ timeout: 10_000 });
    const resetAction = actionsMenu.getByRole("menuitem", { name: "Reset workspace…" });
    await expect(resetAction).toBeEnabled({ timeout: 10_000 });
    await resetAction.click();
    const reset = page.getByRole("dialog", { name: "Reset workspace" });
    await expect(reset).toBeVisible({ timeout: 10_000 });
    await reset.getByRole("button", { name: "Confirm reset workspace" }).click();
    await expect(reset).toHaveCount(0);
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText(
      "Workspace has not started"
    );
    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:reset_probe]",
      "Workspace reset removed the old state."
    );

    const unauthorizedContext = await browser.newContext();
    const unauthorizedPage = await unauthorizedContext.newPage();
    try {
      await loginWithPassword(unauthorizedPage, LOCAL_RESTRICTED_MEMBER);
      expect((await unauthorizedPage.request.get(first.href)).status()).toBe(404);
    } finally {
      await unauthorizedContext.close();
    }

    await page.getByRole("button", { name: /^Turn off Workspace/u }).click();
    await expect(page.getByRole("button", { name: /^Turn on Workspace/u })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    modelSnapshot = await prisma.providerModel.findUnique({
      select: { activeConfig: true, capabilities: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    if (!modelSnapshot?.activeConfig) throw new Error("workspace_fake_model_missing");
    const activeConfig = jsonRecord(modelSnapshot.activeConfig);
    const activeCapabilities = isRecord(activeConfig.capabilities)
      ? activeConfig.capabilities
      : {};
    await prisma.providerModel.update({
      data: {
        activeConfig: {
          ...activeConfig,
          capabilities: { ...activeCapabilities, toolCalling: false }
        } as Prisma.InputJsonValue,
        capabilities: {
          ...jsonRecord(modelSnapshot.capabilities),
          toolCalling: false
        } as Prisma.InputJsonValue
      },
      where: { id: providerTemplateIds.fakeModel }
    });
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const unavailableToggle = page.getByRole("button", { name: /^Turn on Workspace/u });
    await expect(unavailableToggle).toBeDisabled();
    await expect(unavailableToggle).toHaveAttribute("title", /requires a model with tool support/iu);

    const messageTemplate = latestMessageBody as Record<string, unknown> | null;
    if (!messageTemplate) throw new Error("workspace_message_admission_template_missing");
    const detailResponse = await page.request.get(`/api/chats/${chatId}`);
    expect(detailResponse.ok()).toBe(true);
    const detail = await detailResponse.json() as {
      chat: { activeLeafMessageId: string | null };
    };
    const forged = await page.request.post(`/api/chats/${chatId}/messages`, {
      data: {
        ...messageTemplate,
        content: { blocks: [{ text: "forged workspace admission", type: "text" }] },
        expectedActiveLeafId: detail.chat.activeLeafMessageId,
        workspace: { enabled: true }
      }
    });
    expect(forged.status()).toBe(400);
    await expect(forged.json()).resolves.toEqual({ error: "workspace_model_tools_required" });
  } finally {
    if (modelSnapshot?.activeConfig) {
      await prisma.providerModel.update({
        data: {
          activeConfig: modelSnapshot.activeConfig as Prisma.InputJsonValue,
          capabilities: modelSnapshot.capabilities as Prisma.InputJsonValue
        },
        where: { id: providerTemplateIds.fakeModel }
      }).catch(() => undefined);
    }
    if (chatId) await page.request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    await context.close();
  }
});

test("Project Contributor uses Workspace until the owner revokes access", async ({ browser }) => {
  const projectName = `Workspace project ${randomUUID()}`;
  const ownerContext = await browser.newContext({ acceptDownloads: true });
  const contributorContext = await browser.newContext({ acceptDownloads: true });
  const ownerPage = await ownerContext.newPage();
  const contributorPage = await contributorContext.newPage();
  let projectId: string | null = null;

  try {
    await loginWithPassword(ownerPage, LOCAL_MCP_MEMBER);
    projectId = await createProjectThroughUi(ownerPage, projectName);
    await addContributorThroughUi(ownerPage, projectName);

    await loginWithPassword(contributorPage, LOCAL_RESTRICTED_MEMBER);
    await openProject(contributorPage, projectName);
    await selectFakeModel(contributorPage);
    await turnWorkspaceOn(contributorPage);
    await contributorPage.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("project workspace input\n"),
      mimeType: "application/x-aiqsa-workspace-e2e",
      name: "project-input.aiqsa-e2e"
    });
    const projectAttachment = contributorPage.getByRole("region", { name: "Attachments" })
      .getByRole("listitem")
      .filter({ hasText: "project-input.aiqsa-e2e" });
    await expect(projectAttachment).toContainText("Ready", { timeout: 15_000 });
    await expect(contributorPage.getByRole("button", { name: "Send message" })).toBeEnabled();
    await sendAndExpect(
      contributorPage,
      "[AIQSA_WORKSPACE_E2E:deterministic_prepare]",
      "Workspace read the staged input and created result.zip."
    );
    const output = await assertGeneratedZip(contributorPage);

    await ownerPage.bringToFront();
    await revokeContributorThroughUi(ownerPage, projectName);
    await expect(contributorPage.getByText(
      "Project access changed. The shared workspace was closed."
    )).toBeVisible({ timeout: 15_000 });
    expect((await contributorPage.request.get(`/api/projects/${projectId}`)).status()).toBe(404);
    expect((await contributorPage.request.get(output.href)).status()).toBe(404);
  } finally {
    if (projectId) await ownerPage.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
    await ownerContext.close();
    await contributorContext.close();
  }
});
