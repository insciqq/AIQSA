import { PrismaClient } from "@prisma/client";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { utils, write } from "xlsx";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { activeChatId, loginWithPassword, selectFakeModel, sendAndExpect } from "./support/workspace";
import { configureWorkspaceOnlyTools, cleanupWorkspaceFixtureChat, prepareWorkspaceFakeContext, waitForWorkspaceExport } from "./support/workspaceFixture";

/**
 * A synthetic XLSX over the spreadsheet reader's limit, through the real upload, parser and admission path, with the
 * scripted provider and the deterministic Workspace runtime. Screenshots land in each test's output directory and are
 * attached to its report; inspect them. A useful answer computed from the file needs a real model and KVM, which this
 * spec does not prove.
 *
 * Run on the disposable stand, alone, with one worker:
 *   docker compose -f docker-compose.dev.yml run --rm -T app npx playwright test --project=chromium tests/e2e/oversized-document-workspace.spec.ts
 */
const prisma = new PrismaClient();
const fileName = "oversized-ledger.xlsx";
const unavailableWorkspace = { workspace: { available: false, enabled: false, internetEnabled: null, sessionState: null,
  unavailableReason: "installation_disabled" } };
const viewports = [
  { height: 900, label: "desktop", width: 1440 },
  { height: 844, label: "phone", width: 390 }
] as const;

let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;
let restoreFakeContext: (() => Promise<void>) | null = null;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

/** 260,000 filled cells: over `SPREADSHEET_MAX_POPULATED_CELLS` and well within the upload limit. */
function oversizedWorkbook(): Buffer {
  const rows = Array.from({ length: 26_000 }, (_, row) => Array.from({ length: 10 }, (__, column) => row * 10 + column));
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Ledger");
  return write(book, { bookType: "xlsx", compression: true, type: "buffer" }) as Buffer;
}

async function enableWorkspacePolicy(page: Page): Promise<void> {
  originalPolicy ??= await prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true, internetEnabled: true },
    where: { id: "installation" }
  });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=workspace");
  const policy = page.getByRole("region", { name: "Workspace policy" });
  await expect(policy.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  const enabled = policy.getByLabel("Enable Workspace");
  if (!(await enabled.isChecked())) {
    await enabled.click();
    await expect(page.getByTestId("admin-feedback")).toContainText("Workspace policy updated.");
  }
  await expect(enabled).toBeChecked();
}

/** Attaches the workbook and waits for the real parser to refuse it. */
async function attachWorkbook(page: Page) {
  await page.getByLabel("Attach files").setInputFiles({
    buffer: oversizedWorkbook(),
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    name: fileName
  });
  const row = page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: fileName });
  await expect(row).toHaveAttribute("data-attachment-status", "failed", { timeout: 120_000 });
  return row;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { contentType: "image/png", path });
}

test.beforeAll(async ({ browser }) => {
  restoreFakeContext = await prepareWorkspaceFakeContext(prisma);
  const adminContext = await browser.newContext();
  try {
    await enableWorkspacePolicy(await adminContext.newPage());
  } finally {
    await adminContext.close();
  }
});

test.afterAll(async () => {
  await restoreFakeContext?.();
  if (originalPolicy) {
    await prisma.workspacePolicy.update({ data: originalPolicy, where: { id: "installation" } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

for (const viewport of viewports) {
  test.describe(`oversized spreadsheet · ${viewport.label}`, () => {
    const phone = viewport.label === "phone";
    test.use({ hasTouch: phone, isMobile: phone, viewport: { height: viewport.height, width: viewport.width } });

    test(`with a Workspace it is sent and its original reaches the inbox (${viewport.label})`, async ({ page }, testInfo) => {
      await loginWithPassword(page, LOCAL_MCP_MEMBER);
      await selectFakeModel(page);
      await configureWorkspaceOnlyTools(page);
      try {
        const row = await attachWorkbook(page);
        await expect(row).toContainText("No text extracted");
        await expect(row).toContainText("250,000 filled cells");
        await expect(row).toContainText("original in Workspace");
        await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, `with-workspace-tray-${viewport.label}`);

        await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:staging_probe]", "Staging metrics:");
        const chatId = await activeChatId(page);
        await waitForWorkspaceExport(prisma, chatId);
        await expect(page.locator('article[data-role="assistant"]').last()).toContainText(/Staging metrics: bodies=1 /u);
        const stored = await prisma.attachment.findFirstOrThrow({ where: { chatId, fileName },
          select: { extractedText: true, messageId: true, processingErrorCode: true, status: true } });
        expect(stored).toMatchObject({ extractedText: null, processingErrorCode: "parser_output_too_large", status: "failed" });
        expect(stored.messageId).not.toBeNull();
        await shot(page, testInfo, `with-workspace-answer-${viewport.label}`);
      } finally {
        await cleanupWorkspaceFixtureChat(prisma, page);
      }
    });

    test(`when admission refuses the Workspace the composer expected, the refusal names a recovery (${viewport.label})`, async ({ page }, testInfo) => {
      await page.route(/\/api\/chats\/[^/]+\/messages$/u, (route) => route.request().method() === "POST"
        ? route.fulfill({ json: { error: "workspace_disabled" }, status: 409 }) : route.fallback());
      await loginWithPassword(page, LOCAL_MCP_MEMBER);
      await selectFakeModel(page);
      const row = await attachWorkbook(page);
      await page.getByRole("textbox", { name: "Message" }).fill("Sum the second column");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByText(`Only Workspace can open “${fileName}”`)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /without Workspace/iu })).toHaveCount(0);
      await expect(row).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot(page, testInfo, `admission-refused-${viewport.label}`);
    });

    test(`without a Workspace it is refused visibly and Remove lets the message go (${viewport.label})`, async ({ page }, testInfo) => {
      await page.route("**/api/workspace", (route) => route.fulfill({ json: unavailableWorkspace }));
      await signInWithLocalToken(page);
      const composer = page.getByRole("textbox", { name: "Message" });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await selectFakeModel(page);
      const row = await attachWorkbook(page);
      await expect(row).toContainText("Processing failed");
      await expect(row).toContainText("250,000 filled cells");
      await expect(row).toContainText("Without Workspace");
      await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);

      await composer.fill("Sum the second column");
      const send = page.getByRole("button", { name: "Send message" });
      await expect(send).toBeDisabled();
      await expect(send).toHaveAttribute("title", `Remove “${fileName}” to send this message.`);
      await expectNoHorizontalOverflow(page);
      await shot(page, testInfo, `without-workspace-tray-${viewport.label}`);

      await row.getByRole("button", { name: `Remove ${fileName}` }).click();
      await expect(row).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
      await shot(page, testInfo, `without-workspace-removed-${viewport.label}`);
    });
  });
}
