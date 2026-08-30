// Explicitly opt-in paid browser smoke for a disposable loopback Compose stack.
const { existsSync, readFileSync } = require("node:fs");
const { chromium } = require("@playwright/test");

function unquote(value) {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}

function loadLocalEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!process.env[key]) process.env[key] = unquote(trimmed.slice(separator + 1));
  }
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function ensure(value, code) {
  if (!value) fail(code);
}

function safeFailureCode(error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(code)
    ? code
    : "deepseek_browser_smoke_failed";
}

async function responseJson(response, code) {
  ensure(response.ok(), `${code}_${response.status()}`);
  return response.json();
}

async function poll(operation, predicate, input = {}) {
  const startedAt = Date.now();
  const timeoutMs = input.timeoutMs ?? 180_000;
  while (Date.now() - startedAt < timeoutMs) {
    const value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 1_000));
  }
  return fail(input.code ?? "deepseek_browser_poll_timeout");
}

loadLocalEnv();
if (process.env.AIQSA_DEEPSEEK_BROWSER_PAID_SMOKE !== "DISPOSABLE") {
  throw new Error("deepseek_browser_smoke_opt_in_required");
}
const parsedBaseUrl = new URL(
  process.env.AIQSA_DEEPSEEK_BROWSER_BASE_URL ?? "http://127.0.0.1:3000"
);
if (parsedBaseUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedBaseUrl.hostname) ||
  parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.pathname !== "/") {
  throw new Error("deepseek_browser_smoke_loopback_required");
}
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const email = process.env.AIQSA_DEEPSEEK_BROWSER_ADMIN_EMAIL?.trim() ?? "";
const password = process.env.AIQSA_DEEPSEEK_BROWSER_ADMIN_PASSWORD ?? "";
if (!apiKey || !email || !password) {
  throw new Error("deepseek_browser_smoke_configuration_required");
}

const expectedModels = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp"
];
const checks = {};
let stage = "launch";
let browser;
let trackedChatId = null;

async function main() {
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ baseURL: parsedBaseUrl.origin });

    stage = "login";
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByTestId("app-shell").waitFor({ state: "visible", timeout: 60_000 });
    checks.login = true;

    stage = "quick_setup";
    await page.goto("/admin?section=providers", { waitUntil: "domcontentloaded" });
    const section = page.getByTestId("admin-section-providers");
    await section.getByRole("heading", { exact: true, name: "Providers" }).last()
      .waitFor({ state: "visible", timeout: 60_000 });
    await section.getByRole("button", { name: /DeepSeek Not configured/u }).click();
    await section.getByLabel("API key").fill(apiKey);
    await section.getByRole("button", { name: "Test & Save" }).click();
    await section.getByText("Ready to chat", { exact: true })
      .waitFor({ state: "visible", timeout: 180_000 });
    const readySummary = await section.getByTestId("provider-quick-ready-summary").textContent();
    checks.quickSetup = expectedModels.length === 3 &&
      readySummary?.includes("DeepSeek V4 Pro") &&
      readySummary.includes("DeepSeek V4 Flash") &&
      readySummary.includes("DeepSeek V4 Flash Vision (Experimental)") &&
      readySummary.includes("DeepSeek Search: ready");
    ensure(checks.quickSetup, "deepseek_browser_quick_setup_contract_invalid");
    const visibleText = await section.textContent();
    ensure(!visibleText?.includes(apiKey), "deepseek_browser_secret_visible");

    stage = "catalog";
    const catalogBody = await responseJson(
      await page.request.get("/api/me/catalog"),
      "deepseek_browser_catalog_failed"
    );
    const providers = Array.isArray(catalogBody?.catalog?.providers)
      ? catalogBody.catalog.providers
      : [];
    const models = Array.isArray(catalogBody?.catalog?.models) ? catalogBody.catalog.models : [];
    const provider = providers.find((candidate) => candidate?.family === "deepseek");
    const deepSeekModels = models.filter((candidate) => candidate?.provider === provider?.id);
    checks.catalog = Boolean(provider) && deepSeekModels.length === expectedModels.length &&
      expectedModels.every((modelId) =>
        deepSeekModels.some((candidate) => candidate?.upstreamModelId === modelId));
    ensure(checks.catalog, "deepseek_browser_catalog_contract_invalid");

    stage = "model_selection";
    await section.getByRole("link", { name: "Start chatting" }).click();
    await page.getByTestId("app-shell").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".v2-composer-model-trigger").click();
    const picker = page.getByRole("dialog", { name: "Choose model" });
    await picker.getByRole("searchbox", { name: "Search models" }).fill("DeepSeek V4 Pro");
    const modelOption = picker.locator(
      `[role="option"][data-provider-id="${provider.id}"]`
    ).filter({ hasText: "DeepSeek V4 Pro" }).first();
    await modelOption.waitFor({ state: "visible" });
    await modelOption.click();
    await picker.waitFor({ state: "detached" });
    checks.modelSelection = (await page.locator(".v2-composer-model-trigger").textContent())
      ?.includes("DeepSeek V4 Pro") === true;
    ensure(checks.modelSelection, "deepseek_browser_model_selection_failed");

    const searchIndicator = page.getByRole("button", { name: "Turn off Search" });
    if (await searchIndicator.isVisible()) await searchIndicator.click();
    const knowledgeIndicator = page.getByRole("button", { name: "Turn off Knowledge" });
    if (await knowledgeIndicator.isVisible()) await knowledgeIndicator.click();

    await page.getByRole("button", { name: "Capabilities" }).click();
    const capabilitiesMenu = page.getByRole("menu", { name: "Capabilities" });
    await capabilitiesMenu.getByRole("menuitemcheckbox", { name: /Model parameters/u }).click();
    const parameters = page.getByRole("dialog", { name: "Model parameters" });
    await parameters.getByLabel("Max output tokens").fill("128");
    await parameters.getByLabel("Reasoning effort").selectOption("none");
    await parameters.getByRole("button", { name: "Close parameters" }).click();

    stage = "request";
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Reply exactly AIQSA_COMPOSE_E2E_OK.");
    const messageResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname),
    { timeout: 60_000 });
    await page.getByRole("button", { name: "Send message" }).click();
    const accepted = await messageResponse;
    checks.requestAccepted = accepted.ok();
    ensure(checks.requestAccepted, `deepseek_browser_request_rejected_${accepted.status()}`);
    trackedChatId = await poll(
      () => page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId")),
      (value) => typeof value === "string" && value.length > 0,
      { code: "deepseek_browser_chat_missing", timeoutMs: 30_000 }
    );

    stage = "terminal";
    const terminal = await poll(async () => {
      const detail = await responseJson(
        await page.request.get(`/api/chats/${encodeURIComponent(trackedChatId)}`),
        "deepseek_browser_chat_read_failed"
      );
      const messages = Array.isArray(detail?.chat?.messages) ? detail.chat.messages : [];
      const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
      if (assistant?.status === "error" || assistant?.status === "cancelled") {
        fail(`deepseek_browser_assistant_${assistant.status}`);
      }
      return assistant;
    }, (assistant) => assistant?.status === "complete", {
      code: "deepseek_browser_terminal_timeout",
      timeoutMs: 180_000
    });
    checks.answerMarker = JSON.stringify(terminal?.content).includes("AIQSA_COMPOSE_E2E_OK");
    checks.terminal = terminal?.status === "complete" && typeof terminal?.modelRunId === "string";
    ensure(checks.answerMarker && checks.terminal, "deepseek_browser_terminal_contract_invalid");
    const runBody = await responseJson(
      await page.request.get(`/api/model-runs/${encodeURIComponent(terminal.modelRunId)}`),
      "deepseek_browser_run_read_failed"
    );
    checks.durableRun = runBody?.version === 1 && runBody?.run?.status === "complete";
    ensure(checks.durableRun, "deepseek_browser_run_not_complete");

    console.log(JSON.stringify({
      checks,
      modelCount: deepSeekModels.length,
      status: "passed"
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      failureCode: safeFailureCode(error),
      stage,
      status: "failed"
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (browser) {
      const contexts = browser.contexts();
      const page = contexts[0]?.pages()[0];
      if (page && trackedChatId) {
        await page.request.delete(`/api/chats/${encodeURIComponent(trackedChatId)}`)
          .catch(() => undefined);
      }
      await browser.close().catch(() => undefined);
    }
  }
}

void main();
