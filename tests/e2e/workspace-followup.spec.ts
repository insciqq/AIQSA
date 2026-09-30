import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import { prepareWorkspaceFakeContext, configureWorkspaceOnlyTools, waitForWorkspaceExport, cleanupWorkspaceFixtureChat } from "./support/workspaceFixture";
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
let restoreFakeContext: (() => Promise<void>) | null = null;

test.describe.configure({ mode: "default" });
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
    await expect(page.getByTestId("admin-feedback")).toContainText("Workspace policy updated.");
  }
  await expect(enabled).toBeChecked();
}

async function newWorkspaceChat(page: Page): Promise<void> {
  await startNewChat(page);
  await selectFakeModel(page);
  await turnWorkspaceOn(page);
  await configureWorkspaceOnlyTools(page);
}

async function expectStaging(page: Page, bodies: number, last: number): Promise<void> {
  await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:staging_probe]", "Staging metrics:");
  await waitForWorkspaceExport(prisma, await activeChatId(page));
  // Export ownership also verifies staging. Only transferred originals and
  // the current admission's delta matter to the incremental-staging contract.
  await expect(lastAnswer(page)).toContainText(new RegExp(`Staging metrics: bodies=${bodies} calls=\\d+ last=${last}\\.`));
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
      .toHaveAttribute("data-attachment-status", "ready", { timeout: 15_000 });
  }
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
    await prisma.workspacePolicy.update({ data: originalPolicy, where: { id: "installation" } })
      .catch(() => undefined);
  }
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

    await waitForWorkspaceExport(prisma, chatId);

    const activity = await openLastActivity(page);
    await expect(activity).toContainText("Worked in Workspace");
    await expect(activity).toContainText("Workspace ready");
    await expect(activity).toContainText("Prepared 1 attachment");
    await expect(activity).toContainText("Explored pwd");
    await expect(activity).toContainText("Read inbox/index.json");
    await expect(activity).toContainText("Wrote output/");
    await expect(activity).toContainText("Exported 1 file", { timeout: 30_000 });
    // Rejected before the runtime; terminal command cards start collapsed.
    const failedCard = activity.locator("details.v2-workspace-command[data-phase='failed']");
    await expect(failedCard).not.toHaveAttribute("open", "");
    await failedCard.locator("summary").click();
    await expect(failedCard.locator("summary")).toContainText(/pwd && ls -la && cat > script\.py[\s\S]*failed/u);
    await expect(failedCard).toContainText(/Use (?:mcp_workspace_)?sandbox_shell/u);
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
    await expect(reloaded).toContainText("Explored pwd");
    await expect(reloaded).toContainText("Exported 1 file");
    await expect(lastAnswer(page).getByTestId("markdown-resolved-link")).toHaveAttribute("href", href!);

    // Reset removes the sandbox; the exported file stays downloadable.
    await page.getByRole("button", { exact: true, name: "Chat actions" }).click();
    await page.getByRole("menu", { name: "Chat actions" }).getByRole("menuitem", { name: "Reset workspace…" }).click();
    const reset = page.getByRole("dialog", { name: "Reset workspace" });
    await reset.getByRole("button", { name: "Confirm reset workspace" }).click();
    await expect(reset).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Workspace details\./u })).toHaveAccessibleName(/Workspace has not started/u);
    const afterReset = await page.request.get(href!);
    expect(afterReset.status()).toBe(200);
    expect((await afterReset.body()).equals(bytes)).toBe(true);
  } finally {
    try { await cleanupWorkspaceFixtureChat(prisma, page); } finally { await context.close(); }
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
    await expectStaging(page, 2, 2);
    await expectStaging(page, 2, 0);
    // Nothing transferred on the second turn: no "Prepared" row at all.
    await expect(lastActivity(page)).not.toContainText("Prepared");
    await attach(page, [{ buffer: Buffer.from("third original\n"), name: "third.aiqsa-e2e" }]);
    await expectStaging(page, 3, 1);
    await expect(lastActivity(page)).toContainText("Prepared 1 attachment");

    const chatId = await activeChatId(page);
    const beforeResume = await prisma.workspaceSession.findUniqueOrThrow({
      select: { runtimeSandboxId: true }, where: { chatId }
    });
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:resume_probe]", "Workspace resumed the same disk with its originals.");
    await expect(lastActivity(page)).not.toContainText("Workspace was recreated");
    await expect(lastActivity(page)).not.toContainText("Prepared");
    expect(await prisma.workspaceSession.findUniqueOrThrow({
      select: { runtimeSandboxId: true }, where: { chatId }
    })).toEqual(beforeResume);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:state_probe]", "Workspace state persisted.");

    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:lose_session]", "Runtime state was written and the sandbox was lost.");
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:recreate_probe]", "Runtime state is gone and originals were restored.");
    const recreated = await openLastActivity(page);
    await expect(recreated).toContainText("Workspace was recreated");
    await expect(recreated).toContainText("Original attachments were restored");
    await expect(recreated).toContainText("Prepared 3 attachments");
    await expectStaging(page, 3, 0);
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    const restoredTimeline = page.getByTestId("tool-activity-disclosure").filter({ hasText: "Workspace was recreated" });
    if (await restoredTimeline.getAttribute("open") === null) await restoredTimeline.locator(":scope > summary").click();
    await expect(page.getByText("Workspace was recreated")).toBeVisible();
  } finally {
    try { await cleanupWorkspaceFixtureChat(prisma, page); } finally { await context.close(); }
  }
});

test("an ordinary second answer leaves the stopped guest untouched and defers its attachment until guest use", async ({ browser }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await newWorkspaceChat(page);
    await expectStaging(page, 0, 0);
    const chatId = await activeChatId(page);
    const before = await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } });
    expect(before.state).toBe("STOPPED");
    expect(before.runtimeSandboxId).not.toBeNull();

    await attach(page, [{ buffer: Buffer.from("deferred original\n"), name: "deferred.aiqsa-e2e" }]);
    await sendAndExpect(page, "Explain this briefly without inspecting files.", "Fake answer:");
    await waitForWorkspaceExport(prisma, chatId);
    const run = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" },
      include: { workspaceRunBinding: true } });
    expect(run.status).toBe("complete");
    expect(run.workspaceRunBinding).toMatchObject({ guestUsedAt: null, exportState: "COMPLETE" });
    expect(await prisma.modelRunToolCall.count({ where: { modelRunId: run.id } })).toBe(0);
    expect(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: run.id } })).toBe(0);
    expect(await prisma.modelRunEvent.count({ where: { modelRunId: run.id, eventType: "artifact",
      payload: { path: ["artifactType"], equals: "workspace_activity" } } })).toBe(0);
    expect(await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } })).toMatchObject({
      state: "STOPPED", runtimeSandboxId: before.runtimeSandboxId, lastActiveAt: before.lastActiveAt,
      expiresAt: before.expiresAt, stoppedAt: before.stoppedAt, operationOwner: null
    });
    await expect(lastAnswer(page).getByTestId("workspace-activity-section")).toHaveCount(0);
    await page.reload();
    await expect(lastAnswer(page)).toContainText("Fake answer:");
    await expect(lastAnswer(page).getByTestId("workspace-activity-section")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("untouched-second-turn-integrated.png") });

    await expectStaging(page, 1, 1);
    await expect(lastActivity(page)).toContainText("Prepared 1 attachment");
    expect((await prisma.workspaceSession.findUniqueOrThrow({ where: { chatId } })).runtimeSandboxId)
      .toBe(before.runtimeSandboxId);
  } finally {
    try { await cleanupWorkspaceFixtureChat(prisma, page); } finally { await context.close(); }
  }
});

test("Stop prevents synchronous, async, forgotten-handle and descendant side effects", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await newWorkspaceChat(page);
    await sendAndStop(page, "[AIQSA_WORKSPACE_E2E:async_stop]", async () => {
      const live = await openLastActivity(page);
      await expect(live).toContainText("Running sleep 300", { timeout: 15_000 });
      await expect(live).toContainText("Running sleep 12 && echo late");
      await expect(page.getByRole("button", { name: /^Workspace details\./u })).toHaveAccessibleName(/Running a command/u);
    });
    const chatId = await activeChatId(page);
    await expect(page.getByRole("button", { name: /^Workspace details\./u })).not.toHaveAccessibleName(/Running a command/u, { timeout: 15_000 });
    const stopped = await openLastActivity(page);
    await expect(stopped).toContainText("sleep 300; echo late > /workspace/project/sync-after-stop.txt · exit not observed");
    await expect(stopped).toContainText("Workspace work stopped");
    await expect.poll(async () => (await prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { chatId }
    })).state, { timeout: 30_000 }).toBe("STOPPED");
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Workspace details\./u })).toHaveAccessibleName(/Workspace stopped/u, { timeout: 30_000 });
    await expect(openLastActivity(page)).resolves.toBeDefined();
    await expect(lastActivity(page)).toContainText("sleep 300; echo late > /workspace/project/sync-after-stop.txt · exit not observed");
    await page.waitForTimeout(13_000);
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:marker_probe]", "Late marker absent after Stop.");
    await waitForWorkspaceExport(prisma, chatId);

    // Both lost observation and a terminal leader with a surviving child
    // require the disk-preserving VM fallback before another turn can run.
    for (const scenario of ["forget_executions_stop", "descendant_stop"]) {
      await sendAndStop(page, `[AIQSA_WORKSPACE_E2E:${scenario}]`, async () => {
        await expect(await openLastActivity(page)).toContainText("Running sleep 300", { timeout: 15_000 });
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
      await expect(page.getByRole("button", { name: /^Workspace details\./u })).toHaveAccessibleName(/Workspace stopped/u, { timeout: 30_000 });
      await page.waitForTimeout(13_000);
      await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:marker_probe]", "Late marker absent after Stop.");
      await waitForWorkspaceExport(prisma, chatId);
      await expect(page.getByRole("button", { name: /^Workspace details\./u })).toHaveAccessibleName(/Workspace stopped/u, { timeout: 30_000 });
    }

  } finally {
    try { await cleanupWorkspaceFixtureChat(prisma, page); } finally { await context.close(); }
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
    const runsBefore = await prisma.modelRun.count({ where: { chatId } });
    expect(runsBefore).toBe(1);
    await expect(lastAnswer(page)).toHaveAttribute("data-role", "assistant");
    const status = page.getByTestId("workspace-output-status");
    await expect(status).toContainText("still being prepared", { timeout: 30_000 });
    const files = page.getByRole("region", { name: "Generated files" }).last();
    await expect(files).toContainText("first.txt", { timeout: 30_000 });
    await expect(files).not.toContainText("second.txt");
    const run = await prisma.modelRun.findFirstOrThrow({
      select: { id: true, status: true, workspaceRunBinding: { select: { exportState: true } } },
      where: { chatId }
    });
    expect(run.status).toBe("complete");
    expect(run.workspaceRunBinding?.exportState).toBe("FAILED");

    const draft = "Keep this unsent follow-up while files recover";
    await page.getByRole("textbox", { name: "Message" }).fill(draft);
    // Background recovery completes the export and the open chat refreshes;
    // no reload, user send or provider dispatch is needed.
    await expect.poll(async () => (await prisma.workspaceRunBinding.findUniqueOrThrow({
      select: { exportState: true },
      where: { modelRunId: run.id }
    })).exportState, { timeout: 90_000 }).toBe("COMPLETE");
    const recovered = page.getByRole("region", { name: "Generated files" }).last();
    await expect(recovered).toContainText("first.txt");
    await expect(recovered).toContainText("second.txt", { timeout: 45_000 });
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(draft);
    await expect(recovered.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByTestId("workspace-output-status")).toHaveCount(0);
    expect(await prisma.modelRun.count({ where: { chatId } })).toBe(runsBefore);
    expect(await prisma.workspaceRunOutput.count({ where: { workspaceRunBindingId: run.id } })).toBe(2);
  } finally {
    try { await cleanupWorkspaceFixtureChat(prisma, page); } finally { await context.close(); }
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
