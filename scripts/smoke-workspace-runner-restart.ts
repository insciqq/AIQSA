import { execFileSync } from "node:child_process";
import { chromium, type Page } from "@playwright/test";

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
const postgresService = process.env.AIQSA_LIVE_POSTGRES_SERVICE?.trim() || "postgres";

/** Runs one SQL statement inside the stack's postgres container; the host needs no database route. */
function sql(query: string): string {
  return execFileSync(
    "docker",
    ["compose", "-f", composeFile, "exec", "-T", postgresService, "sh", "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At'],
    { encoding: "utf8", input: query, stdio: ["pipe", "pipe", "inherit"] }
  ).trim();
}

async function waitForRunnerHealth(): Promise<void> {
  const container = execFileSync(
    "docker", ["compose", "-f", composeFile, "ps", "-q", runnerService], { encoding: "utf8" }
  ).trim();
  if (!container) throw new Error("runner_container_missing");
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const health = execFileSync(
      "docker", ["inspect", "-f", "{{.State.Health.Status}}", container], { encoding: "utf8" }
    ).trim();
    if (health === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("runner_not_healthy_after_restart");
}

type Settlement = Readonly<{ lost: number; open: number; state: string }>;

function settlement(sessionId: string): Settlement {
  return {
    lost: Number(sql(
      `select count(*) from "WorkspaceExecution" where state = 'LOST' and "workspaceSessionId" = '${sessionId}';`
    )),
    open: Number(sql(
      `select count(*) from "WorkspaceExecution" where state in ('ACTIVE', 'TERMINATING') and "workspaceSessionId" = '${sessionId}';`
    )),
    state: sql(`select state from "WorkspaceSession" where id = '${sessionId}';`)
  };
}

async function pollSettlement(sessionId: string, timeoutMs: number): Promise<Settlement> {
  const deadline = Date.now() + timeoutMs;
  let current = settlement(sessionId);
  while (Date.now() < deadline) {
    if (current.open === 0 && current.state !== "RUNNING" && current.state !== "CREATING") return current;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    current = settlement(sessionId);
  }
  return current;
}

function uuidOrThrow(value: string | null, code: string): string {
  if (!value || !/^[0-9a-f-]{36}$/u.test(value)) throw new Error(code);
  return value;
}

async function login(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/`);
  const response = await page.request.post(`${baseUrl}/api/auth/token`, {
    data: { token: "aiqsa-test-token" }
  });
  if (!response.ok()) throw new Error(`test_auth_failed_${response.status()}`);
  await page.goto(`${baseUrl}/`);
  await page.getByTestId("app-shell").waitFor({ timeout: 60_000 });
  // The test-token user is an administrator; the disposable stack starts
  // with Workspace disabled after its seed.
  const current = await page.request.get(`${baseUrl}/api/admin/workspace`);
  if (!current.ok()) throw new Error(`workspace_policy_read_failed_${current.status()}`);
  const body = await current.json() as { workspace?: { version?: number; policy?: { version?: number } } };
  const expectedVersion = body.workspace?.version ?? body.workspace?.policy?.version;
  if (!Number.isSafeInteger(expectedVersion)) throw new Error("workspace_policy_version_missing");
  const policy = await page.request.patch(`${baseUrl}/api/admin/workspace`, {
    data: { enabled: true, expectedVersion, internetEnabled: true }
  });
  if (!policy.ok()) throw new Error(`workspace_policy_enable_failed_${policy.status()}`);
}

async function selectFakeModel(page: Page): Promise<void> {
  // Same steps as tests/e2e/shell/composer.ts `selectModel`.
  const picker = page.getByRole("dialog", { name: "Choose model" });
  await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 60_000 });
  await page.getByTestId("header-model-trigger").click();
  await picker.waitFor({ timeout: 30_000 });
  await picker.getByRole("searchbox", { name: "Search models" }).fill("Fake QSA");
  await picker.locator('[role="option"][data-provider-id="00000000-0000-4000-8000-000000001101"]')
    .filter({ hasText: "Fake QSA" })
    .first()
    .click();
  await picker.waitFor({ state: "detached", timeout: 30_000 });
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
    // The live label and the timeline row both carry the command text.
    await activity.getByText("Running sleep 300", { exact: false }).first().waitFor({ timeout: 300_000 });
    chatId = uuidOrThrow(await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId")), "chat_id_missing");
    const sessionId = sql(`select id from "WorkspaceSession" where "chatId" = '${chatId}';`);
    if (!/^ws_[0-9a-f]{40}$/u.test(sessionId)) throw new Error("workspace_session_missing");
    const activeBefore = Number(sql(
      `select count(*) from "WorkspaceExecution" where state = 'ACTIVE' and "workspaceSessionId" = '${sessionId}';`
    ));
    if (activeBefore !== 1) throw new Error(`expected_one_active_execution_got_${activeBefore}`);

    // Restart only the runner: its process-local execution cache is gone and,
    // for a few seconds, it is unreachable. Stop lands in that window, so the
    // run's own settlement cannot prove quiescence; the maintenance backstop
    // must then terminate (unknown → VM stop, disk kept) and settle the session.
    execFileSync("docker", ["compose", "-f", composeFile, "restart", runnerService], { stdio: "inherit" });

    // The in-flight turn usually ends on its own first (its poll fails on the
    // restarted runner); Stop is pressed when the run is still open. Either way
    // the registered execution survives the restart only in the registry and
    // the outcome below must hold.
    const stoppedAt = Date.now();
    const stopButton = page.getByRole("button", { name: "Stop answer" });
    let stopPressed = false;
    try {
      await stopButton.click({ timeout: 5_000 });
      stopPressed = true;
    } catch {
      // The run already completed with the failed poll.
    }
    await stopButton.waitFor({ state: "detached", timeout: 120_000 });
    await waitForRunnerHealth();
    const settled = await pollSettlement(sessionId, 150_000);
    const settleMs = Date.now() - stoppedAt;
    if (settled.open !== 0 || settled.state === "RUNNING" || settled.state === "CREATING") {
      throw new Error(`session_not_settled_after_stop state=${settled.state} open=${settled.open} lost=${settled.lost}`);
    }
    if (settled.lost !== 1) throw new Error(`expected_one_lost_execution_got_${settled.lost}`);
    await send(page, "[AIQSA_WORKSPACE_E2E:live_marker_probe]");
    await waitForText(page, "Late marker absent after Stop.", 300_000);
    process.stdout.write(`${JSON.stringify({
      lostExecutions: settled.lost,
      markerAbsent: true,
      openExecutionsAfterStop: settled.open,
      sessionStateAfterStop: settled.state,
      settleMs,
      status: "passed",
      stopPressed
    })}\n`);
  } finally {
    if (chatId) await page.request.delete(`${baseUrl}/api/chats/${chatId}`).catch(() => undefined);
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "workspace_runner_restart_smoke_failed"}\n`);
  process.exitCode = 1;
});
