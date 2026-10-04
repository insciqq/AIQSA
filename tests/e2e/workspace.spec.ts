import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { modelPdfPageEndMarker, modelPdfPageStartMarker } from "../../lib/server/parsing/modelPdfOutput";
import {
  LOCAL_MCP_MEMBER,
  LOCAL_RESTRICTED_MEMBER
} from "../../prisma/local-seed-fixtures";
import { authenticateWithLocalToken, signInWithLocalToken } from "./support/localAuth";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import {
  activeChatId,
  bytesFromDownload,
  loginWithPassword,
  openWorkspaceDetails,
  selectFakeModel,
  sendAndExpect,
  setWorkspaceEnabled,
  turnWorkspaceOn
} from "./support/workspace";
import { prepareWorkspaceFakeContext } from "./support/workspaceFixture";

const prisma = new PrismaClient();
const RESULT_ZIP = Buffer.from(
  "UEsDBBQAAAAAAAAAIQDtsuv+JQAAACUAAAAKAAAAcmVzdWx0LnR4dEFJUVNBIGRldGVybWluaXN0aWMgd29ya3NwYWNlIHJlc3VsdApQSwECFAMUAAAAAAAAACEA7bLr/iUAAAAlAAAACgAAAAAAAAAAAAAApIEAAAAAcmVzdWx0LnR4dFBLBQYAAAAAAQABADgAAABNAAAAAAA=",
  "base64"
);

let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;
let restoreFakeContext: (() => Promise<void>) | null = null;

test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    link.click({ timeout: 30_000 })
  ]);
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

/** Overrides Fake QSA capabilities in both its active configuration and its catalog row. */
async function updateFakeModelCapabilities(patch: Readonly<Record<string, boolean>>): Promise<void> {
  const current = await prisma.providerModel.findUniqueOrThrow({
    select: { activeConfig: true, capabilities: true },
    where: { id: providerTemplateIds.fakeModel }
  });
  const activeConfig = jsonRecord(current.activeConfig ?? {});
  const activeCapabilities = isRecord(activeConfig.capabilities) ? activeConfig.capabilities : {};
  await prisma.providerModel.update({
    data: {
      activeConfig: { ...activeConfig, capabilities: { ...activeCapabilities, ...patch } } as Prisma.InputJsonValue,
      capabilities: { ...jsonRecord(current.capabilities), ...patch } as Prisma.InputJsonValue
    },
    where: { id: providerTemplateIds.fakeModel }
  });
}

/** Page sections the PDF reader prompt asks for, in order (a single-page batch here). */
function requestedPdfPages(serializedRequest: string): number[] {
  const pages: number[] = [];
  for (let page = 1; page <= 64; page += 1) {
    if (serializedRequest.includes(modelPdfPageStartMarker(page))) pages.push(page);
  }
  return pages;
}

/**
 * A local Responses endpoint for one synthetic deployment. It passes the
 * custom-setup checks (including the PDF input receipt probe) and answers the
 * installation PDF reader's transcription request in the page-marker format.
 */
function createPdfReaderServer() {
  return createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/pdf-reader" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const pages = requestedPdfPages(JSON.stringify(body));
      const text = pages.length > 0
        ? pages.map((page) => `${modelPdfPageStartMarker(page)}\nSynthetic original evidence, page ${page}.\n${modelPdfPageEndMarker(page)}`).join("\n")
        : wire.includes("input_image") || wire.includes("input_file") ? "PEARS"
        : body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] }) : "OK";
      const probe = pages.length > 0 ? undefined : body.tools?.find((item: { name?: string }) => item.name?.startsWith("aiqsa_"));
      const output = probe
        ? (probe.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
          type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: probe.name,
          arguments: JSON.stringify({ city }), status: "completed"
        })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const completed = { id: randomUUID(), status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [{ type: "response.created", response: { id: completed.id, status: "in_progress" } },
        { type: "response.output_text.delta", delta: text }, { type: "response.completed", response: completed }]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
}

/** Removes one synthetic deployment once nothing that RESTRICTs it remains. */
async function removePdfReaderConnection(connectionId: string, chatIds: readonly string[]): Promise<void> {
  // The asynchronous permanent chat deletion purges the runs, their PDF
  // preparations and provider bindings. Rows it has not reached in time,
  // or of a chat that was only archived, are removed here instead.
  if (chatIds.length > 0) {
    await expect.poll(() => prisma.chat.count({ where: { id: { in: [...chatIds] } } }), { timeout: 60_000 })
      .toBe(0).catch(() => undefined);
  }
  await prisma.$transaction(async (tx) => {
    await tx.chatPdfAttachmentPreparation.deleteMany({ where: { OR: [
      { providerModel: { connectionId } }, { credentialVersion: { credential: { connectionId } } }
    ] } });
    await tx.providerRunBinding.deleteMany({ where: { connectionId } });
    await tx.accessGrant.deleteMany({ where: { OR: [{ providerConnectionId: connectionId }, { providerModel: { connectionId } }] } });
    await tx.providerUserCredentialAssignment.deleteMany({ where: { connectionId } });
    await tx.providerGroupCredentialAssignment.deleteMany({ where: { connectionId } });
    await tx.providerDraftCheck.deleteMany({ where: { connectionId } });
    await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
    await tx.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await tx.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await tx.providerCredentialVersion.deleteMany({ where: { credential: { connectionId } } });
    await tx.providerCredential.deleteMany({ where: { connectionId } });
    await tx.providerModel.deleteMany({ where: { connectionId } });
    await tx.providerConnection.delete({ where: { id: connectionId } });
  });
}

/**
 * Chat admission needs an explicit PDF route and Fake QSA can never read a PDF
 * itself, so a synthetic deployment becomes the installation PDF reader. Only
 * that role changes; every other installation setting is restored at once.
 */
async function startPdfReaderFixture(browser: Browser): Promise<Readonly<{
  remove(chatIds: readonly (string | null)[]): Promise<void>;
}>> {
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorAdminSettings = await prisma.userSettings.findUniqueOrThrow({
    select: { defaultProviderModelId: true }, where: { userId: DEFAULT_BOOTSTRAP_USER_ID }
  });
  const roles = {
    ...priorRoles, id: undefined, createdAt: undefined, updatedAt: undefined,
    imageParamsJson: priorRoles.imageParamsJson as Prisma.InputJsonValue,
    decisionFeaturesJson: priorRoles.decisionFeaturesJson as Prisma.InputJsonValue
  };
  const restoreInstallation = (pdfReaderModelId?: string) => prisma.$transaction([
    prisma.systemModelPolicy.update({ where: { id: "installation" }, data: pdfReaderModelId ? {
      ...roles, chatPdfNativeProviderModelId: pdfReaderModelId, chatPdfNativeReasoningEffort: null,
      chatPdfProcessingMode: "USE_PDF_READER"
    } : roles }),
    prisma.modelPolicy.update({ where: { id: "installation" },
      data: { ...priorPolicy, id: undefined, createdAt: undefined, updatedAt: undefined } }),
    prisma.userSettings.update({ where: { userId: DEFAULT_BOOTSTRAP_USER_ID }, data: priorAdminSettings })
  ]);
  const server = createPdfReaderServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let connectionId: string | null = null;
  const remove = async (chatIds: readonly (string | null)[]) => {
    try {
      await restoreInstallation();
      if (connectionId) await removePdfReaderConnection(connectionId, chatIds.filter((id): id is string => Boolean(id)));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  try {
    const admin = await browser.newContext();
    try {
      await authenticateWithLocalToken(admin.request);
      const response = await admin.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
        allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Workspace PDF reader fixture",
        modelIds: ["fixture/pdf-reader"], protocol: "responses", responseTimeoutSeconds: 30,
        perModelCapabilities: { "fixture/pdf-reader": { contextWindow: 1_050_000, defaultMaxOutputTokens: 65_536, maxOutputTokens: 65_536 } }
      } });
      expect(response.ok(), await response.text()).toBe(true);
      const setup = await response.json() as AdminProviderCustomSetupReadyResult;
      connectionId = setup.connectionId;
      expect(setup.outcome).toBe("ready");
      await restoreInstallation(setup.providerModelId);
    } finally {
      await admin.close();
    }
  } catch (error) {
    await remove([]).catch(() => undefined);
    throw error;
  }
  return { remove };
}

// A multi-round Workspace turn with tool results and prepared PDF text does
// not fit Fake QSA's 8k window; like the other Workspace specs, these use
// the 64k fake context so the tool loop never needs context compaction.
test.beforeAll(async () => {
  restoreFakeContext = await prepareWorkspaceFakeContext(prisma);
});

test.afterAll(async () => {
  try {
    if (originalPolicy) {
      await prisma.workspacePolicy.update({
        data: originalPolicy,
        where: { id: "installation" }
      }).catch(() => undefined);
    }
    await restoreFakeContext?.();
  } finally {
    await prisma.$disconnect();
  }
});

/** Sends like `sendAndExpect`; a missing answer reports the latest run's persisted failure. */
async function sendAndExpectRun(page: Page, prompt: string, answer: string): Promise<void> {
  try {
    await sendAndExpect(page, prompt, answer);
  } catch (error) {
    const chatId = parseChatRoutePath(new URL(page.url()).pathname)?.chatId ?? null;
    const run = chatId ? await prisma.modelRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { errorPayload: true, status: true },
      where: { chatId }
    }).catch(() => null) : null;
    const payload = isRecord(run?.errorPayload) ? run.errorPayload : {};
    const failure = { status: run?.status ?? null, code: payload.code ?? null, stage: payload.stage ?? null, round: payload.round ?? null };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nLatest run of the chat: ${JSON.stringify(failure)}`, { cause: error });
  }
}

test("administrator enables a ready Workspace with public internet", async ({ page }) => {
  originalPolicy = await prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true, internetEnabled: true },
    where: { id: "installation" }
  });
  // Exercise enablement even when the installation defaults are already on.
  await prisma.workspacePolicy.update({
    data: { enabled: false, internetEnabled: false },
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
  await expect(page.getByTestId("admin-feedback")).toContainText("Workspace policy updated.");
});

test("personal Workspace runs tools, preserves state, exports bytes, stops, resets, and rejects forged admission", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  let chatId: string | null = null;
  let modelSnapshot: Readonly<{
    activeConfig: Prisma.JsonValue;
    capabilities: Prisma.JsonValue;
  }> | null = null;
  let releaseTerminalRead = () => {};
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

  const workspaceDetails = page.getByRole("button", { name: /^Workspace details\./u });
  let pdfReader: Awaited<ReturnType<typeof startPdfReaderFixture>> | null = null;

  try {
    pdfReader = await startPdfReaderFixture(browser);
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await selectFakeModel(page);
    await turnWorkspaceOn(page);
    const internetLayer = await openWorkspaceDetails(page);
    await expect(internetLayer).toContainText("Internet: On. Managed by the administrator.");
    await page.keyboard.press("Escape");
    await expect(internetLayer).toBeHidden();

    const pdfDocument = await PDFDocument.create();
    pdfDocument.addPage();
    await page.getByLabel("Attach files").setInputFiles([
      {
        buffer: Buffer.from([0, 1, 2, 3, 254, 255]),
        mimeType: "application/x-aiqsa-workspace-e2e",
        name: "opaque-input.aiqsa-e2e"
      },
      {
        buffer: Buffer.from(await pdfDocument.save()),
        mimeType: "application/pdf",
        name: "original-evidence.pdf"
      }
    ]);
    // Files upload one after another: the opaque file takes the resumable
    // Workspace upload and is verified before the PDF starts, so each file
    // is awaited until ready rather than counted at once.
    const attachments = page.getByRole("region", { name: "Attachments" });
    for (const name of ["opaque-input.aiqsa-e2e", "original-evidence.pdf"]) {
      await expect(attachments.getByRole("listitem").filter({ hasText: name }))
        .toHaveAttribute("data-attachment-status", "ready", { timeout: 30_000 });
    }
    await expect(attachments.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

    await sendAndExpectRun(
      page,
      "[AIQSA_WORKSPACE_E2E:deterministic_prepare]",
      "Workspace read the staged input and created result.zip."
    );
    chatId = await activeChatId(page);
    await expect(workspaceDetails).toHaveAccessibleName(/Workspace stopped$/u, { timeout: 30_000 });
    const activity = page.getByTestId("tool-activity-disclosure").last();
    await activity.locator(":scope > summary").click();
    await expect(activity).toContainText("Worked in Workspace");
    await expect(activity).toContainText("Prepared 2 attachments");
    await expect(activity).toContainText("Read inbox/index.json");
    await expect(activity).toContainText(/Read inbox\/(?:opaque-input\.aiqsa-e2e|original-evidence\.pdf)/u);
    await expect(activity).toContainText("Wrote project/persisted.txt");
    await expect(activity).toContainText("Exported 1 file", { timeout: 30_000 });
    expect(await activity.textContent()).not.toMatch(/sandbox_|Used Workspace/u);

    const first = await assertGeneratedZip(page);
    expect(first.checksum).toBe(sha256(RESULT_ZIP));
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const afterReload = await assertGeneratedZip(page);
    expect(afterReload).toEqual(first);

    await sendAndExpectRun(
      page,
      "[AIQSA_WORKSPACE_E2E:state_probe]",
      "Workspace state persisted."
    );

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("[AIQSA_WORKSPACE_E2E:long_command]");
    await composer.press("Enter");
    const stop = page.getByRole("button", { name: "Stop answer" });
    await expect(stop).toBeEnabled({ timeout: 15_000 });
    await expect(workspaceDetails).toHaveAccessibleName(/Running a command…$/u);
    const terminalReadReleased = new Promise<void>((resolve) => { releaseTerminalRead = resolve; });
    let terminalReadWaiting = false;
    await page.route(/\/api\/model-runs\/[^/]+$/u, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body = await response.json() as { run?: { status?: string } };
      if (body.run?.status === "cancelled") {
        terminalReadWaiting = true;
        await terminalReadReleased;
      }
      await route.fulfill({ response });
    });
    await page.route(/\/api\/model-runs\/[^/]+\/cancel$/u, async (route) => {
      const response = await route.fetch();
      // Deliver Stop after the stream has entered terminal reconciliation.
      await expect.poll(() => terminalReadWaiting, { timeout: 15_000 }).toBe(true);
      await route.fulfill({ response });
    });
    await stop.click();
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText("Stopped");

    const nextDraft = "[AIQSA_WORKSPACE_E2E:state_probe]";
    await composer.fill(nextDraft);
    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toBeDisabled();
    await expect(composer).toBeEnabled();
    await composer.press("Enter");
    await expect(composer).toHaveValue(nextDraft);
    await page.screenshot({ path: testInfo.outputPath("pending-send-reconciliation.png") });
    releaseTerminalRead();
    await expect(send).toBeEnabled({ timeout: 30_000 });
    await expect(composer).toHaveValue(nextDraft);
    await sendAndExpectRun(
      page,
      nextDraft,
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
    await expect(workspaceDetails).toHaveAccessibleName(/Workspace has not started$/u);
    await sendAndExpectRun(
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

    await setWorkspaceEnabled(page, false);
    modelSnapshot = await prisma.providerModel.findUnique({
      select: { activeConfig: true, capabilities: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    if (!modelSnapshot?.activeConfig) throw new Error("workspace_fake_model_missing");
    await updateFakeModelCapabilities({ toolCalling: false });
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const unavailableLayer = await openWorkspaceDetails(page);
    const unavailableToggle = unavailableLayer.getByRole("menuitemcheckbox", { name: /Turn on Workspace/u });
    await expect(unavailableToggle).toBeDisabled();
    await expect(unavailableToggle).toContainText("Workspace requires a model with tool support.");
    await page.keyboard.press("Escape");
    await expect(unavailableLayer).toBeHidden();

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
    releaseTerminalRead();
    if (modelSnapshot?.activeConfig) {
      await prisma.providerModel.update({
        data: {
          activeConfig: modelSnapshot.activeConfig as Prisma.InputJsonValue,
          capabilities: modelSnapshot.capabilities as Prisma.InputJsonValue
        },
        where: { id: providerTemplateIds.fakeModel }
      }).catch(() => undefined);
    }
    if (chatId) await deleteOwnedChatPermanently(page.request, chatId).catch(() => undefined);
    await context.close();
    await pdfReader?.remove([chatId]);
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
    // A Workspace-only original reads "Available in Workspace" once it is ready.
    await expect(projectAttachment).toHaveAttribute("data-attachment-status", "ready", { timeout: 30_000 });
    await expect(projectAttachment).toContainText("Available in Workspace");
    await expect(contributorPage.getByRole("button", { name: "Send message" })).toBeEnabled();
    await sendAndExpectRun(
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
