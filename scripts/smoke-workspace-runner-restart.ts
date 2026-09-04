import { execFileSync } from "node:child_process";
import { chromium, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Live KVM runner-restart proof (PRD 28.3). Runs on the Docker host against a
 * disposable Compose stack started with the `workspace-live` profile and the
 * app in remote runtime mode. It starts a real long-lived execution whose
 * delayed side effect must never land, restarts only the runner container,
 * presses Stop, and verifies quiescence plus a working follow-up turn.
 *
 *   AIQSA_WORKSPACE_LIVE_E2E=DISPOSABLE \
 *   AIQSA_LIVE_BASE_URL=http://127.0.0.1:3200 \
 *   AIQSA_LIVE_COMPOSE_FILE=docker-compose.dev.yml \
 *   npx tsx scripts/smoke-workspace-runner-restart.ts
 *
 * Output is content-free: states, counts, and booleans only.
 */

if (process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE") {
  throw new Error("workspace_live_e2e_requires_disposable_confirmation");
}

const baseUrl = process.env.AIQSA_LIVE_BASE_URL?.trim() || "http://127.0.0.1:3200";
const composeFile = process.env.AIQSA_LIVE_COMPOSE_FILE?.trim() || "docker-compose.dev.yml";
const runnerService = process.env.AIQSA_LIVE_RUNNER_SERVICE?.trim() || "workspace-runner";
const prisma = new PrismaClient();

async function login(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/`);
  const response = await page.request.post(`${baseUrl}/api/auth/token`, {
    data: { token: "aiqsa-test-token" }
  });
  if (!response.ok()) throw new Error(`test_auth_failed_${response.status()}`);
  await page.goto(`${baseUrl}/`);
  await page.getByTestId("app-shell").waitFor({ timeout: 60_000 });
}

async function selectFakeModel(page: Page): Promise<void> {
  await page.getByTestId("header-model-trigger").click();
  const search = page.getByRole("combobox").first();
  await search.fill("Fake");
  await page.getByRole("option", { name: /Fake QSA/u }).first().click();
  await page.getByTestId("header-model-trigger").filter({ hasText: "Fake QSA" }).waitFor({ timeout: 30_000 });
}

async function send(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await composer.press("Enter");
}

async function waitForText(page: Page, text: string, timeout: number): Promise<void> {
  await page.locator('article[data-role="assistant"]').last().getByText(text, { exact: false })
    .waitFor({ timeout });
}

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  let chatId: string | null = null;
  try {
    await login(page);
    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await selectFakeModel(page);
    const toggle = page.getByRole("button", { name: /^Turn on Workspace/u });
    await toggle.waitFor({ timeout: 30_000 });
    await toggle.click();
    await page.getByRole("button", { name: /^Turn off Workspace/u }).waitFor({ timeout: 30_000 });

    await send(page, "[AIQSA_WORKSPACE_E2E:live_async_stop]");
    const activity = page.getByTestId("tool-activity-disclosure").last();
    await activity.getByText("Running sleep 300", { exact: false }).waitFor({ timeout: 300_000 });
    chatId = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
    if (!chatId) throw new Error("chat_id_missing");
    const session = await prisma.workspaceSession.findUniqueOrThrow({
      select: { id: true },
      where: { chatId }
    });
    const activeBefore = await prisma.workspaceExecution.count({
      where: { state: "ACTIVE", workspaceSessionId: session.id }
    });
    if (activeBefore !== 1) throw new Error(`expected_one_active_execution_got_${activeBefore}`);

    // Restart only the runner: its process-local execution cache is gone while
    // the microVM keeps running the delayed command.
    execFileSync("docker", ["compose", "-f", composeFile, "restart", runnerService], { stdio: "inherit" });

    await page.getByRole("button", { name: "Stop answer" }).click();
    await page.getByRole("button", { name: "Stop answer" }).waitFor({ state: "detached", timeout: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 14_000));
    const after = await prisma.workspaceSession.findUniqueOrThrow({
      select: { state: true },
      where: { id: session.id }
    });
    const open = await prisma.workspaceExecution.count({
      where: { state: { in: ["ACTIVE", "TERMINATING"] }, workspaceSessionId: session.id }
    });
    const lost = await prisma.workspaceExecution.count({
      where: { state: "LOST", workspaceSessionId: session.id }
    });
    await send(page, "[AIQSA_WORKSPACE_E2E:live_marker_probe]");
    await waitForText(page, "Late marker absent after Stop.", 300_000);
    process.stdout.write(`${JSON.stringify({
      lostExecutions: lost,
      markerAbsent: true,
      openExecutionsAfterStop: open,
      sessionStateAfterStop: after.state,
      status: "passed"
    })}\n`);
  } finally {
    if (chatId) await page.request.delete(`${baseUrl}/api/chats/${chatId}`).catch(() => undefined);
    await context.close();
    await browser.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "workspace_runner_restart_smoke_failed"}\n`);
  process.exitCode = 1;
});
