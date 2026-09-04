import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import {
  RAW_WORKSPACE_IDENTIFIERS,
  activeChatId,
  lastActivity,
  lastAnswer,
  loginWithPassword,
  openLastActivity,
  selectFakeModel,
  sendAndExpect,
  sendAndStop,
  startNewChat,
  turnWorkspaceOn
} from "./support/workspace";

/**
 * Deterministic browser gates for the Workspace follow-up: human-readable
 * activity with exact sandbox: links, incremental staging, Stop after an
 * async start (with and without runner-side execution loss), export failure
 * that keeps the answer, session recreation, and downloads after removal.
 * The runtime is the deterministic one; the provider is scripted.
 */
const prisma = new PrismaClient();
let originalPolicy: { enabled: boolean; internetEnabled: boolean } | null = null;
const createdChatIds: string[] = [];

test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);

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
    await expect(policy.getByRole("status")).toContainText("Workspace policy updated.");
  }
  await expect(enabled).toBeChecked();
}

async function newWorkspaceChat(page: Page): Promise<void> {
  await startNewChat(page);
  await selectFakeModel(page);
  await turnWorkspaceOn(page);
}

async function attach(page: Page, files: readonly { buffer: Buffer; name: string }[]): Promise<void> {
  await page.getByLabel("Attach files").setInputFiles(files.map((file) => ({
    buffer: file.buffer,
    mimeType: "application/x-aiqsa-workspace-e2e",
    name: file.name
  })));
  const attachments = page.getByRole("region", { name: "Attachments" });
  for (const file of files) {
    await expect(attachments.getByRole("listitem").filter({ hasText: file.name }))
      .toContainText("Ready", { timeout: 15_000 });
  }
}

test.beforeAll(async ({ browser }) => {
  const adminContext = await browser.newContext();
  try {
    await enableWorkspacePolicy(await adminContext.newPage());
  } finally {
    await adminContext.close();
  }
});

test.afterAll(async () => {
  if (originalPolicy) {
    await prisma.workspacePolicy.update({ data: originalPolicy, where: { id: "installation" } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

test("shows a human-readable timeline, resolves exact sandbox links, and keeps downloads after reset", async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await newWorkspaceChat(page);
    await attach(page, [{ buffer: Buffer.from([0, 1, 2, 3, 254, 255]), name: "opaque-input.aiqsa-e2e" }]);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:activity_probe]", "Workspace activity probe finished.");
    const chatId = await activeChatId(page);
    createdChatIds.push(chatId);

    const activity = await openLastActivity(page);
    await expect(activity).toContainText("Worked in Workspace");
    await expect(activity).toContainText("Workspace ready");
    await expect(activity).toContainText("Prepared 1 attachment");
    await expect(activity).toContainText("Ran pwd");
    await expect(activity).toContainText("Read inbox/index.json");
    await expect(activity).toContainText("Wrote output/");
    await expect(activity).toContainText("Exported 1 file");
    // The direct-exec mistake from the dev stand: rejected before the runtime, shown as an open failure card.
    const failedCard = activity.locator("details.v2-workspace-command[data-phase='failed']");
    await expect(failedCard).toHaveAttribute("open", "");
    await expect(failedCard).toContainText("pwd && ls -la && cat > script.py <<'PY' failed");
    await expect(failedCard).toContainText("Use sandbox_shell");
    const okCard = activity.locator("details.v2-workspace-command[data-phase='succeeded']").first();
    await expect(okCard).not.toHaveAttribute("open", "");
    await okCard.locator("summary").click();
    await expect(okCard).toContainText("$ pwd");
    await expect(okCard).toContainText("/workspace/project");
    await expect(okCard).toContainText("Exit code 0");
    await expect(okCard.getByRole("button", { name: "Copy command" })).toBeVisible();
    // The rejection message legitimately names the two tools the model must
    // choose between; everything else in the timeline is free of identifiers.
    const rejection = (await failedCard.textContent()) ?? "";
    const timelineText = ((await activity.textContent()) ?? "").replace(rejection, "");
    expect(timelineText).not.toMatch(RAW_WORKSPACE_IDENTIFIERS);

    const answer = lastAnswer(page);
    const resolved = answer.getByTestId("markdown-resolved-link");
    await expect(resolved).toHaveText("Report");
    const href = await resolved.getAttribute("href");
    expect(href).toMatch(/^\/api\/attachments\/[^/]+\/content$/u);
    await expect(answer.getByTestId("markdown-inert-link")).toHaveText("Missing");
    await expect(answer.getByRole("link", { name: "Missing" })).toHaveCount(0);
    const files = page.getByRole("region", { name: "Generated files" }).last();
    await expect(files).toContainText("report.md");
    await expect(files.getByRole("link", { name: "Download" })).toHaveAttribute("href", href!);
    const first = await page.request.get(href!);
    expect(first.status()).toBe(200);
    const bytes = await first.body();
    expect(bytes.toString("utf8")).toContain("# Report");

    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const reloaded = await openLastActivity(page);
    await expect(reloaded).toContainText("Ran pwd");
    await expect(reloaded).toContainText("Exported 1 file");
    await expect(lastAnswer(page).getByTestId("markdown-resolved-link")).toHaveAttribute("href", href!);

    // Reset removes the sandbox; the exported file stays downloadable.
    await page.getByRole("button", { exact: true, name: "Chat actions" }).click();
    await page.getByRole("menu", { name: "Chat actions" }).getByRole("menuitem", { name: "Reset workspace…" }).click();
    const reset = page.getByRole("dialog", { name: "Reset workspace" });
    await reset.getByRole("button", { name: "Confirm reset workspace" }).click();
    await expect(reset).toHaveCount(0);
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText("Workspace has not started");
    const afterReset = await page.request.get(href!);
    expect(afterReset.status()).toBe(200);
    expect((await afterReset.body()).equals(bytes)).toBe(true);
  } finally {
    await context.close();
  }
});

test("stages only new originals on later turns and restages everything after the sandbox is lost", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await newWorkspaceChat(page);
    await attach(page, [
      { buffer: Buffer.from("first original\n"), name: "first.aiqsa-e2e" },
      { buffer: Buffer.from("second original\n"), name: "second.aiqsa-e2e" }
    ]);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:staging_probe]", "Staging metrics: bodies=2 calls=1 last=2.");
    createdChatIds.push(await activeChatId(page));
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:staging_probe]", "Staging metrics: bodies=2 calls=2 last=0.");
    // Nothing transferred on the second turn: no "Prepared" row at all.
    await expect(lastActivity(page)).not.toContainText("Prepared");
    await attach(page, [{ buffer: Buffer.from("third original\n"), name: "third.aiqsa-e2e" }]);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:staging_probe]", "Staging metrics: bodies=3 calls=3 last=1.");
    await expect(lastActivity(page)).toContainText("Prepared 1 attachment");

    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:lose_session]", "Runtime state was written and the sandbox was lost.");
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:recreate_probe]", "Runtime state is gone and originals were restored.");
    const recreated = await openLastActivity(page);
    await expect(recreated).toContainText("Workspace was recreated");
    await expect(recreated).toContainText("Original attachments were restored");
    await expect(recreated).toContainText("Prepared 3 attachments");
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:staging_probe]", "Staging metrics: bodies=3 calls=2 last=0.");
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByText("Workspace was recreated")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Stop after an async start prevents the delayed side effect, also after the runner forgot the execution", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await newWorkspaceChat(page);
    await sendAndStop(page, "[AIQSA_WORKSPACE_E2E:async_stop]", async () => {
      const live = lastActivity(page);
      await expect(live).toHaveAttribute("open", "", { timeout: 15_000 });
      await expect(live).toContainText("Running sleep 300", { timeout: 15_000 });
      await expect(live).toContainText("Running sleep 12 && echo late");
      await expect(page.locator(".v2-composer-workspace-state")).toContainText("Running a command");
    });
    const chatId = await activeChatId(page);
    createdChatIds.push(chatId);
    await expect(page.locator(".v2-composer-workspace-state")).not.toContainText("Running a command", { timeout: 15_000 });
    const stopped = await openLastActivity(page);
    await expect(stopped).toContainText("Stopped sleep 300");
    await expect(stopped).toContainText("Workspace work stopped");
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { chatId }
    })).state, { timeout: 30_000 }).toBe("READY");
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText("Workspace ready", { timeout: 30_000 });
    await expect(openLastActivity(page)).resolves.toBeDefined();
    await expect(lastActivity(page)).toContainText("Stopped sleep 300");
    await page.waitForTimeout(13_000);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:marker_probe]", "Late marker absent after Stop.");

    // Runner-side loss of the execution session: quiescence cannot be proven,
    // so the VM is stopped with its disk intact and the marker still never lands.
    await sendAndStop(page, "[AIQSA_WORKSPACE_E2E:forget_executions_stop]", async () => {
      await expect(lastActivity(page)).toContainText("Running sleep 300", { timeout: 15_000 });
    });
    const session = await prisma.workspaceSession.findUniqueOrThrow({
      select: { id: true },
      where: { chatId }
    });
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { id: session.id }
    })).state, { timeout: 30_000 }).toBe("STOPPED");
    await expect.poll(async () => prisma.workspaceExecution.count({
      where: { state: { in: ["ACTIVE", "TERMINATING"] }, workspaceSessionId: session.id }
    })).toBe(0);
    expect(await prisma.workspaceExecution.count({
      where: { state: "LOST", workspaceSessionId: session.id }
    })).toBeGreaterThan(0);
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText("Workspace stopped", { timeout: 30_000 });
    await page.waitForTimeout(13_000);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:marker_probe]", "Late marker absent after Stop.");
    await expect(page.locator(".v2-composer-workspace-state")).toHaveText("Workspace ready", { timeout: 30_000 });
  } finally {
    await context.close();
  }
});

test("a failed export keeps the answer complete and recovery finishes the remaining file without a new provider call", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await newWorkspaceChat(page);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:export_fault]", "Two outputs were written; the export fault is armed.");
    const chatId = await activeChatId(page);
    createdChatIds.push(chatId);
    const runsBefore = await prisma.modelRun.count({ where: { chatId } });
    expect(runsBefore).toBe(1);
    await expect(lastAnswer(page)).toHaveAttribute("data-role", "assistant");
    const status = page.getByTestId("workspace-output-status");
    await expect(status).toContainText("still being prepared", { timeout: 30_000 });
    const files = page.getByRole("region", { name: "Generated files" }).last();
    await expect(files).toContainText("first.txt");
    await expect(files).not.toContainText("second.txt");
    const run = await prisma.modelRun.findFirstOrThrow({
      select: { id: true, status: true, workspaceRunBinding: { select: { exportState: true } } },
      where: { chatId }
    });
    expect(run.status).toBe("complete");
    expect(run.workspaceRunBinding?.exportState).toBe("FAILED");

    // Background recovery (10 s cadence) completes the export; the answer never re-ran.
    await expect.poll(async () => (await prisma.workspaceRunBinding.findUniqueOrThrow({
      select: { exportState: true },
      where: { modelRunId: run.id }
    })).exportState, { timeout: 90_000 }).toBe("COMPLETE");
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const recovered = page.getByRole("region", { name: "Generated files" }).last();
    await expect(recovered).toContainText("first.txt");
    await expect(recovered).toContainText("second.txt");
    await expect(recovered.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("workspace-output-status")).toHaveCount(0);
    expect(await prisma.modelRun.count({ where: { chatId } })).toBe(runsBefore);
    expect(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: run.id } })).toBe(2);
  } finally {
    await context.close();
  }
});

test.afterAll(async () => {
  for (const chatId of createdChatIds) {
    await prisma.modelRun.deleteMany({ where: { chatId } }).catch(() => undefined);
  }
});
