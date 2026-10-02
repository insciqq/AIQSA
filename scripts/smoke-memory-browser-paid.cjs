// Explicitly opt-in paid browser smoke for the disposable local development stand.
const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");
const { chromium } = require("@playwright/test");
const { Client } = require("pg");

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

loadLocalEnv();
if (process.env.AIQSA_MEMORY_BROWSER_PAID_SMOKE !== "DISPOSABLE") {
  throw new Error("memory_browser_paid_smoke_opt_in_required");
}
const scenario = process.env.AIQSA_MEMORY_BROWSER_PAID_SMOKE_SCENARIO?.trim().toUpperCase();
if (scenario !== "DIRECT") {
  throw new Error("memory_browser_paid_smoke_scenario_required");
}
const parsedBaseUrl = new URL(
  process.env.AIQSA_MEMORY_BROWSER_PAID_SMOKE_BASE_URL ?? "http://127.0.0.1:3000"
);
if (parsedBaseUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedBaseUrl.hostname) ||
  parsedBaseUrl.username || parsedBaseUrl.password || parsedBaseUrl.pathname !== "/") {
  throw new Error("memory_browser_paid_smoke_loopback_required");
}
const databaseUrl = process.env.AIQSA_MEMORY_BROWSER_PAID_SMOKE_DATABASE_URL ?? "";
let parsedDatabaseUrl;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error("memory_browser_paid_smoke_database_url_required");
}
if (parsedDatabaseUrl.protocol !== "postgresql:" ||
  parsedDatabaseUrl.username !== "aiqsa" || !parsedDatabaseUrl.password ||
  !["127.0.0.1", "localhost", "[::1]"].includes(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.port !== "5432" || parsedDatabaseUrl.pathname !== "/aiqsa" ||
  parsedDatabaseUrl.searchParams.get("schema") !== "public" ||
  [...parsedDatabaseUrl.searchParams.keys()].some((key) => key !== "schema")) {
  throw new Error("memory_browser_paid_smoke_disposable_database_required");
}
const bootstrapToken = process.env.AIQSA_BOOTSTRAP_AUTH_TOKEN ?? "";
if (!bootstrapToken) throw new Error("memory_browser_paid_smoke_auth_token_required");
const baseUrl = parsedBaseUrl.origin;
const runStartedAt = new Date();
const qualificationWords = [
  "amber", "birch", "cedar", "coral", "fern", "harbor", "indigo", "juniper",
  "linen", "maple", "meadow", "orchard", "pebble", "saffron", "willow", "zephyr"
];
const qualificationSeed = Number.parseInt(
  randomUUID().replaceAll("-", "").slice(0, 12),
  16
);
function qualificationWord(offset) {
  return qualificationWords[
    Math.floor(qualificationSeed / qualificationWords.length ** offset) %
      qualificationWords.length
  ];
}
const marker = [
  qualificationWord(0),
  qualificationWord(1),
  "studio",
  qualificationWord(2),
  qualificationWord(3)
].join(" ");
const corePreference = "soft teal";
const trackedChatIds = [];
const trackedMemoryRefs = [];
let currentStage = "bootstrap";

function emit(stage, details = {}) {
  process.stdout.write(`${JSON.stringify({ stage, ...details })}\n`);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** Mirrors lib/domain/chatRoute.ts: `/c/<id>` and `/p/<project>/c/<id>` name the open chat. */
function chatIdFromPathname(pathname) {
  const match = /^\/(?:p\/[^/]+\/)?c\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function ensure(value, code) {
  if (!value) fail(code);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(operation, predicate, input = {}) {
  const timeoutMs = input.timeoutMs ?? 600_000;
  const intervalMs = input.intervalMs ?? 2_000;
  const startedAt = Date.now();
  let value;
  while (Date.now() - startedAt < timeoutMs) {
    value = await operation();
    if (predicate(value)) return value;
    await sleep(intervalMs);
  }
  return fail(input.code ?? "poll_timeout");
}

async function responseJson(response, code) {
  ensure(response.ok(), `${code}_${response.status()}`);
  return response.json();
}

async function authenticate(page) {
  const response = await page.request.post("/api/auth/token", {
    data: { token: bootstrapToken }
  });
  const body = await responseJson(response, "browser_auth_failed");
  ensure(typeof body?.user?.id === "string", "browser_auth_contract_invalid");
  return body.user.id;
}

async function newChat(page) {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) {
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await navigation.waitFor({ state: "visible" });
  }
  await navigation.getByRole("button", { exact: true, name: "New chat" }).click();
  await page.getByRole("textbox", { name: "Message" }).waitFor({ state: "visible" });
}

async function configureLuna(page) {
  const catalogResponse = await page.request.get("/api/me/catalog");
  const body = await responseJson(catalogResponse, "catalog_read_failed");
  const providers = Array.isArray(body?.catalog?.providers) ? body.catalog.providers : [];
  const models = Array.isArray(body?.catalog?.models) ? body.catalog.models : [];
  const provider = providers.find((candidate) =>
    typeof candidate?.name === "string" && candidate.name.toLowerCase().includes("codex-lb"));
  const model = models.find((candidate) =>
    candidate?.provider === provider?.id &&
    typeof candidate?.displayName === "string" &&
    candidate.displayName.toLowerCase() === "gpt-5.6-luna");
  ensure(provider && model, "codex_lb_luna_catalog_missing");

  await page.locator(".v2-composer-model-trigger").click();
  const picker = page.getByRole("dialog", { name: "Choose model" });
  await picker.waitFor({ state: "visible" });
  await picker.getByRole("searchbox", { name: "Search models" }).fill("gpt-5.6-luna");
  const option = picker.locator(
    `[role="option"][data-provider-id="${provider.id}"][data-model-id="${model.modelId}"]`
  );
  await option.waitFor({ state: "visible" });
  await option.click();
  await picker.waitFor({ state: "detached" });
  const summary = page.locator(".v2-composer-model-trigger");
  await poll(
    () => summary.textContent(),
    (value) => typeof value === "string" && value.toLowerCase().includes("luna"),
    { code: "luna_selection_not_visible", timeoutMs: 30_000 }
  );

  const searchIndicator = page.getByRole("button", { name: "Turn off Search" });
  if (await searchIndicator.isVisible()) await searchIndicator.click();
  const knowledgeIndicator = page.getByRole("button", { name: "Turn off Knowledge" });
  if (await knowledgeIndicator.isVisible()) await knowledgeIndicator.click();

  const toolsTrigger = page.getByRole("button", { name: "Change MCP mode" });
  await toolsTrigger.click();
  const tools = page.getByRole("menu", { name: "MCP tools" });
  await tools.waitFor({ state: "visible" });
  const off = tools.getByRole("menuitemradio", { name: /^Off/u });
  if ((await off.getAttribute("aria-checked")) !== "true") await off.click();
  const toolsClose = tools.getByRole("button", { name: "Close" });
  if (await toolsClose.isVisible()) await toolsClose.click();

  await page.getByRole("button", { name: "Capabilities" }).click();
  const capabilities = page.getByRole("menu", { name: "Capabilities" });
  await capabilities.waitFor({ state: "visible" });
  await capabilities.getByRole("menuitemcheckbox", { name: /Model parameters/u }).click();
  const setup = page.getByRole("dialog", { name: "Model parameters" });
  await setup.waitFor({ state: "visible" });
  await setup.getByLabel("Max output tokens").fill("512");
  const reasoning = setup.getByLabel("Reasoning effort");
  if (await reasoning.isVisible()) {
    const values = await reasoning.locator("option").evaluateAll((options) =>
      options.map((option) => option.value));
    if (values.includes("low")) await reasoning.selectOption("low");
  }
  const background = setup.getByRole("switch", { name: "Background" });
  if (await background.isVisible() && (await background.getAttribute("aria-checked")) === "true") {
    await background.click();
  }
  await setup.getByRole("button", { name: "Close parameters" }).click();
  return { modelId: model.modelId, providerId: provider.id };
}

async function activeChatId(page) {
  return poll(
    async () => chatIdFromPathname(await page.evaluate(() => window.location.pathname)),
    (value) => typeof value === "string" && value.length > 0,
    { code: "active_chat_missing", timeoutMs: 30_000 }
  );
}

async function chatDetail(page, chatId) {
  const response = await page.request.get(`/api/chats/${encodeURIComponent(chatId)}`);
  return responseJson(response, "chat_detail_failed");
}

async function sendMessage(page, text, options = {}) {
  const before = await page.locator('article[data-role="assistant"]').count();
  const textbox = page.getByRole("textbox", { name: "Message" });
  await textbox.fill(text);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" &&
      /^\/api\/chats\/[^/]+\/messages$/u.test(url.pathname);
  }, { timeout: 120_000 });
  await page.getByRole("button", { name: "Send message" }).click();
  const response = await responsePromise;
  ensure(response.ok(), `message_submit_failed_${response.status()}`);
  const chatId = await activeChatId(page);
  if (!trackedChatIds.includes(chatId)) trackedChatIds.push(chatId);
  if (options.excludeMemory === true) {
    const exclusion = await page.request.patch(
      `/api/me/chats/${encodeURIComponent(chatId)}/memory-mode`,
      { data: { mode: "EXCLUDED" } }
    );
    ensure(exclusion.ok(), "recall_chat_exclusion_failed");
  }
  const result = await poll(async () => {
    const detail = await chatDetail(page, chatId);
    const messages = Array.isArray(detail?.chat?.messages) ? detail.chat.messages : [];
    const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
    return {
      assistant,
      count: await page.locator('article[data-role="assistant"]').count()
    };
  }, (value) => {
    if (value?.assistant?.status === "error" || value?.assistant?.status === "cancelled") {
      fail(`assistant_run_${value.assistant.status}`);
    }
    return value?.assistant?.status === "complete" && value.count > before;
  }, {
    code: "assistant_run_timeout",
    intervalMs: 2_000,
    timeoutMs: 600_000
  });
  await poll(
    () => page.getByRole("button", { name: "Stop answer" }).count(),
    (count) => count === 0,
    { code: "answer_ui_stuck", timeoutMs: 30_000 }
  );
  return {
    article: page.locator('article[data-role="assistant"]').last(),
    chatId,
    runId: result.assistant.modelRunId,
    userMessageId: result.assistant.parentMessageId
  };
}

async function directFactStats(db, userId, chatIds) {
  if (chatIds.length === 0) {
    return { directCount: 0, maxCluster: 0, preferenceSlots: 0, readyCount: 0 };
  }
  const rows = await db.query(`
    SELECT DISTINCT version."id", fact."subjectKey", fact."predicateKey",
      version."category", version."modality"::text AS "modality",
      version."safetyClassificationState"::text AS "safetyState",
      EXISTS (
        SELECT 1
        FROM "UserMemorySettings" AS settings
        INNER JOIN "MemorySearchEntry" AS entry
          ON entry."userId" = settings."userId"
         AND entry."indexGenerationId" = settings."activeIndexGenerationId"
         AND entry."factVersionId" = version."id"
         AND entry."embeddingState" = 'READY'::"MemoryEmbeddingState"
        WHERE settings."userId" = version."userId"
      ) AS "embeddingReady"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
     AND fact."id" = version."factId"
     AND fact."currentVersionId" = version."id"
     AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryEvidence" AS evidence
      ON evidence."userId" = version."userId"
     AND evidence."factVersionId" = version."id"
    WHERE version."userId" = $1
      AND evidence."chatId" = ANY($2::text[])
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."observedAt" >= $3::timestamptz
  `, [userId, chatIds, runStartedAt.toISOString()]);
  const clusters = new Map();
  let preferenceSlots = 0;
  let readyCount = 0;
  for (const row of rows.rows) {
    if (row.predicateKey === "preference") preferenceSlots += 1;
    if (row.safetyState === "CLASSIFIED" && row.embeddingReady === true) readyCount += 1;
    const key = `${row.subjectKey ?? row.id}|${row.category}|${row.modality}|${row.predicateKey ?? "none"}`;
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  return {
    directCount: rows.rowCount,
    maxCluster: Math.max(0, ...clusters.values()),
    preferenceSlots,
    readyCount
  };
}

async function extractionStats(db, userId, chatIds) {
  const result = await db.query(`
    SELECT job."state"::text AS "state", COUNT(*)::integer AS "count"
    FROM "MemoryJob" AS job
    WHERE job."userId" = $1
      AND job."chatId" = ANY($2::text[])
      AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
      AND job."createdAt" >= $3::timestamptz
    GROUP BY job."state"
  `, [userId, chatIds, runStartedAt.toISOString()]);
  const counts = Object.fromEntries(result.rows.map((row) => [row.state, row.count]));
  const pending = ["QUEUED", "WAITING_FOR_CONFIGURATION", "WAITING_FOR_EGRESS_CONSENT", "CLAIMED", "RETRYABLE_FAILED"]
    .reduce((sum, state) => sum + (counts[state] ?? 0), 0);
  return {
    pending,
    succeeded: counts.SUCCEEDED ?? 0,
    terminal: counts.TERMINAL_FAILED ?? 0
  };
}

const preferenceFixtures = Object.freeze([
  [
    "response length",
    "concise answers"
  ],
  [
    "technical explanations",
    "a concrete example before theory"
  ],
  [
    "status updates",
    "blockers before implementation details"
  ],
  [
    "meeting agendas",
    "a written outline in advance"
  ],
  [
    "code samples",
    "TypeScript examples"
  ],
  [
    "code review feedback",
    "specific actionable comments"
  ],
  [
    "dashboard layout",
    "low visual noise"
  ],
  [
    "notifications",
    "a bundled digest"
  ],
  [
    "decision records",
    "a short written rationale"
  ],
  [
    "task planning",
    "one primary goal at a time"
  ],
  [
    "debugging",
    "reproducing the issue before changing code"
  ],
  [
    "documentation",
    "runnable examples"
  ],
  [
    "progress reports",
    "outcomes before activity lists"
  ],
  [
    "calendar planning",
    "uninterrupted focus blocks"
  ],
  [
    "brainstorming",
    "three options with tradeoffs"
  ],
  [
    "estimates",
    "ranges with explicit assumptions"
  ],
  [
    "project handoffs",
    "a completion checklist"
  ],
  [
    "release notes",
    "user impact before internal mechanics"
  ],
  [
    "command examples",
    "copy-ready commands"
  ],
  [
    "data tables",
    "rows sorted by relevance"
  ],
  [
    "design reviews",
    "annotated evidence"
  ],
  [
    "incident summaries",
    "the root cause before the timeline"
  ],
  [
    "API documentation",
    "request and response examples together"
  ],
  [
    "research summaries",
    "claims separated from inference"
  ],
  [
    "planning documents",
    "clear owners for every action"
  ],
  [
    "risk reviews",
    "highest-impact risks first"
  ],
  [
    "test reports",
    "failed checks before passed checks"
  ],
  [
    "migration plans",
    "a reversible checkpoint"
  ],
  [
    "architecture notes",
    "boundaries shown explicitly"
  ],
  [
    "weekly reviews",
    "unfinished work called out clearly"
  ],
  [
    "pull request descriptions",
    "behavior changes before file lists"
  ],
  [
    "error messages",
    "a recovery action when available"
  ],
  [
    "terminal output",
    "sanitized aggregate results"
  ],
  [
    "configuration examples",
    "safe defaults shown first"
  ],
  [
    "performance reports",
    "latency percentiles instead of averages alone"
  ],
  [
    "accessibility reviews",
    "keyboard behavior checked explicitly"
  ],
  [
    "product proposals",
    "the user problem before the solution"
  ],
  [
    "dependency reviews",
    "security impact noted explicitly"
  ],
  [
    "runbooks",
    "verification after every recovery step"
  ],
  [
    "retrospectives",
    "one concrete improvement owner"
  ]
]);
const MAX_PREFERENCE_BATCHES = Math.ceil(preferenceFixtures.length / 4);

function preferenceBatch(batch) {
  const fixtures = preferenceFixtures.slice(batch * 4, batch * 4 + 4);
  ensure(fixtures.length > 0, "browser_e2e_preference_fixture_exhausted");
  const lines = fixtures.map(([dimension, value]) =>
    `- In my ${marker} workspace, my stable format preference for ${dimension} is ${value}.`);
  return [
    "These are stable, durable preferences of mine:",
    ...lines,
    "Please acknowledge them briefly."
  ].join("\n");
}

async function waitForSourceExtraction(db, userId, sourceMessageId, ordinal) {
  ensure(typeof sourceMessageId === "string", "source_message_identity_missing");
  let lastNoticeAt = 0;
  let lastState = null;
  const result = await poll(async () => {
    const query = await db.query(`
      SELECT job."state"::text AS "state", job."attemptCount", job."errorCode"
      FROM "MemoryJob" AS job
      WHERE job."userId" = $1
        AND job."sourceMessageId" = $2
        AND job."kind" = 'EXTRACT_FACTS'::"MemoryJobKind"
        AND job."createdAt" >= $3::timestamptz
      ORDER BY job."createdAt" DESC
      LIMIT 1
    `, [userId, sourceMessageId, runStartedAt.toISOString()]);
    const job = query.rows[0] ?? null;
    if (job?.state !== lastState || Date.now() - lastNoticeAt > 60_000) {
      emit("source-extraction", {
        attemptCount: job?.attemptCount ?? 0,
        errorCode: job?.errorCode ?? "none",
        jobObserved: job !== null,
        ordinal,
        state: job?.state ?? "WAITING_FOR_JOB"
      });
      lastNoticeAt = Date.now();
      lastState = job?.state ?? null;
    }
    return job;
  }, (job) => job !== null && [
    "SUCCEEDED", "TERMINAL_FAILED", "STALE", "CANCELLED"
  ].includes(job.state), {
    code: "source_extraction_timeout",
    intervalMs: 3_000,
    timeoutMs: 600_000
  });
  if (result.state !== "SUCCEEDED") {
    const suffix = typeof result.errorCode === "string" ? result.errorCode : result.state.toLowerCase();
    fail(`source_extraction_${suffix}`);
  }
}

async function waitForDirectFacts(db, page, userId, sourceChatId, nextBatch) {
  const requiredFacts = 3;
  while (nextBatch.value <= MAX_PREFERENCE_BATCHES) {
    const [facts, jobs] = await Promise.all([
      directFactStats(db, userId, [sourceChatId]),
      extractionStats(db, userId, [sourceChatId])
    ]);
    emit("automatic-learning-progress", {
      directFacts: facts.directCount,
      maxCluster: facts.maxCluster,
      pendingExtractions: jobs.pending,
      readyFacts: facts.readyCount
    });
    if (facts.directCount >= requiredFacts && facts.maxCluster >= 3) {
      let lastNoticeAt = 0;
      const readyFacts = await poll(async () => {
        const current = await directFactStats(db, userId, [sourceChatId]);
        if (Date.now() - lastNoticeAt > 60_000) {
          emit("automatic-learning-readiness", {
            directFacts: current.directCount,
            readyFacts: current.readyCount
          });
          lastNoticeAt = Date.now();
        }
        return current;
      }, (current) => current.readyCount >= requiredFacts, {
        code: "automatic_learning_search_readiness_timeout",
        intervalMs: 3_000,
        timeoutMs: 600_000
      });
      return { facts: readyFacts, jobs };
    }
    if (nextBatch.value >= MAX_PREFERENCE_BATCHES) break;
    currentStage = "automatic-learning-extra-batch";
    const extra = await sendMessage(page, preferenceBatch(nextBatch.value));
    await waitForSourceExtraction(db, userId, extra.userMessageId, nextBatch.value + 1);
    nextBatch.value += 1;
  }
  return fail("automatic_learning_insufficient_facts_or_cluster");
}

async function cleanup(page) {
  let permanent = 0;
  let archived = 0;
  let explicitForgotten = 0;
  let explicitForgetFailed = 0;
  for (const memoryRef of [...trackedMemoryRefs].reverse()) {
    try {
      const response = await page.request.post("/api/me/memory/source-actions", {
        data: { action: "FORGET", memoryRef, requestNonce: randomUUID() }
      });
      const body = response.ok() ? await response.json().catch(() => null) : null;
      if (response.ok() && body?.status === "COMMITTED") {
        explicitForgotten += 1;
      } else {
        explicitForgetFailed += 1;
      }
    } catch {
      explicitForgetFailed += 1;
    }
  }
  for (const chatId of [...trackedChatIds].reverse()) {
    await page.request.patch(`/api/me/chats/${encodeURIComponent(chatId)}/memory-mode`, {
      data: { mode: "EXCLUDED" }
    }).catch(() => undefined);
  }
  for (const chatId of [...trackedChatIds].reverse()) {
    try {
      const admitted = await page.request.post(
        `/api/chats/${encodeURIComponent(chatId)}/delete-permanently`,
        {
          data: {
            alsoForgetOriginMemories: true,
            confirmationCopyVersion: "memory-confirmation-v1",
            requestId: randomUUID()
          },
          timeout: 30_000
        }
      );
      if (admitted.ok()) {
        const status = await poll(async () => {
          const response = await page.request.get(
            `/api/chats/${encodeURIComponent(chatId)}/delete-permanently/status`
          );
          if (!response.ok()) return "MISSING";
          const body = await response.json();
          return body?.status ?? "UNKNOWN";
        }, (value) => value === "COMPLETE" || value === "MISSING" || value === "NEEDS_ATTENTION", {
          code: "cleanup_poll_timeout",
          intervalMs: 3_000,
          timeoutMs: 180_000
        });
        if (status === "COMPLETE" || status === "MISSING") {
          permanent += 1;
          continue;
        }
      }
    } catch {
      // Exact exclusion above already fences this test-owned source.
    }
    const archivedResponse = await page.request.delete(`/api/chats/${encodeURIComponent(chatId)}`)
      .catch(() => null);
    if (archivedResponse?.ok()) archived += 1;
  }
  return { archived, explicitForgetFailed, explicitForgotten, permanent };
}

async function waitForRecallSources(page, recall, expectedSourceType) {
  const sourceCards = recall.article.getByTestId("memory-source-card");
  const sourceSnapshot = async () => {
    const detail = await chatDetail(page, recall.chatId);
    const messages = Array.isArray(detail?.chat?.messages) ? detail.chat.messages : [];
    const assistant = [...messages].reverse().find((message) =>
      message?.role === "assistant" && message?.modelRunId === recall.runId);
    const apiSources = assistant?.artifactSummary?.memorySources;
    const sources = Array.isArray(apiSources) ? apiSources : [];
    return {
      apiCount: sources.length,
      expectedCount: sources.filter((source) => source?.sourceType === expectedSourceType).length,
      learnedCount: sources.filter((source) => source?.sourceType === "LEARNED_MEMORY").length,
      savedCount: sources.filter((source) => source?.sourceType === "SAVED_MEMORY").length,
      uiCount: await sourceCards.count()
    };
  };
  let proof;
  try {
    proof = await poll(sourceSnapshot, (value) =>
      value.apiCount >= 1 && value.uiCount >= 1 && value.expectedCount >= 1, {
      code: "direct_recall_sources_missing",
      intervalMs: 1_000,
      timeoutMs: 30_000
    });
  } catch (error) {
    emit("direct-recall-diagnostic", await sourceSnapshot());
    throw error;
  }
  return {
    ...proof,
    sourceText: (await sourceCards.allTextContents()).join("\n")
  };
}

async function learnedRecallDiagnostic(db, userId, sourceChatId, modelRunId) {
  const [attempt, binding, executions, facts] = await Promise.all([
    db.query(`
      SELECT attempt."state"::text AS "state",
        attempt."outcome"::text AS "outcome",
        attempt."degradationCode",
        attempt."errorCode",
        attempt."budgetSnapshot"->>'reason' AS "reason",
        CARDINALITY(attempt."externalRolesUsed")::integer AS "externalRoleCount",
        COUNT(item."id")::integer AS "itemCount"
      FROM "MemoryRetrievalAttempt" AS attempt
      LEFT JOIN "MemoryRetrievalAttemptItem" AS item
        ON item."userId" = attempt."userId"
       AND item."attemptId" = attempt."id"
      WHERE attempt."userId" = $1
        AND attempt."modelRunId" = $2
      GROUP BY attempt."id"
      ORDER BY attempt."attemptOrdinal" DESC
      LIMIT 1
    `, [userId, modelRunId]),
    db.query(`
      SELECT binding."outcome"::text AS "outcome", binding."degradationCode",
        COUNT(item."id")::integer AS "itemCount"
      FROM "ModelRunMemoryBinding" AS binding
      LEFT JOIN "ModelRunMemoryItem" AS item
        ON item."userId" = binding."userId"
       AND item."bindingId" = binding."id"
      WHERE binding."userId" = $1
        AND binding."modelRunId" = $2
      GROUP BY binding."id"
    `, [userId, modelRunId]),
    db.query(`
      SELECT execution."logicalRole",
        execution."state"::text AS "state",
        COALESCE(execution."errorCode", 'none') AS "errorCode",
        COUNT(*)::integer AS "count"
      FROM "MemoryExecutionBinding" AS execution
      INNER JOIN "MemoryRetrievalAttempt" AS attempt
        ON attempt."userId" = execution."userId"
       AND attempt."id" = execution."retrievalAttemptId"
      WHERE execution."userId" = $1
        AND attempt."modelRunId" = $2
      GROUP BY execution."logicalRole", execution."state", execution."errorCode"
      ORDER BY execution."logicalRole", execution."state"
    `, [userId, modelRunId]),
    db.query(`
      SELECT COUNT(DISTINCT version."id")::integer AS "activeFacts",
        COUNT(DISTINCT version."id") FILTER (
          WHERE version."safetyClassificationState" =
            'CLASSIFIED'::"MemorySafetyClassificationState"
        )::integer AS "classifiedFacts",
        COUNT(DISTINCT version."id") FILTER (
          WHERE entry."embeddingState" = 'READY'::"MemoryEmbeddingState"
        )::integer AS "readyFacts",
        COUNT(DISTINCT version."id") FILTER (
          WHERE scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
        )::integer AS "globalFacts",
        COUNT(DISTINCT version."id") FILTER (
          WHERE scope."scopeType" = 'FOLDER'::"MemoryScopeType"
        )::integer AS "folderFacts",
        COUNT(DISTINCT version."id") FILTER (
          WHERE scope."scopeType" = 'CHAT'::"MemoryScopeType"
        )::integer AS "chatFacts",
        COUNT(DISTINCT version."id") FILTER (
          WHERE POSITION(LOWER($3) IN LOWER(entry."normalizedSearchText")) > 0
        )::integer AS "markerMatches",
        COUNT(DISTINCT version."id") FILTER (
          WHERE POSITION(LOWER($4) IN LOWER(entry."normalizedSearchText")) > 0
        )::integer AS "expectedValueMatches"
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId"
       AND fact."id" = version."factId"
       AND fact."currentVersionId" = version."id"
       AND fact."state" = 'ACTIVE'::"MemoryFactState"
      INNER JOIN "MemoryScope" AS scope
        ON scope."userId" = fact."userId"
       AND scope."id" = fact."scopeId"
       AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      INNER JOIN "MemoryEvidence" AS evidence
       ON evidence."userId" = version."userId"
       AND evidence."factVersionId" = version."id"
       AND evidence."chatId" = $2
      LEFT JOIN "UserMemorySettings" AS settings
        ON settings."userId" = version."userId"
      LEFT JOIN "MemorySearchEntry" AS entry
        ON entry."userId" = settings."userId"
       AND entry."indexGenerationId" = settings."activeIndexGenerationId"
       AND entry."factVersionId" = version."id"
      WHERE version."userId" = $1
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
    `, [userId, sourceChatId, marker, preferenceFixtures[0][1]])
  ]);
  const attemptRow = attempt.rows[0] ?? null;
  const bindingRow = binding.rows[0] ?? null;
  return {
    attempt: attemptRow ? {
      degradationCode: attemptRow.degradationCode ?? "none",
      errorCode: attemptRow.errorCode ?? "none",
      externalRoleCount: attemptRow.externalRoleCount,
      itemCount: attemptRow.itemCount,
      outcome: attemptRow.outcome ?? "none",
      reason: attemptRow.reason ?? "none",
      state: attemptRow.state
    } : null,
    binding: bindingRow ? {
      degradationCode: bindingRow.degradationCode ?? "none",
      itemCount: bindingRow.itemCount,
      outcome: bindingRow.outcome
    } : null,
    executions: executions.rows,
    facts: facts.rows[0] ?? null
  };
}

async function controlRunDiagnostic(db, userId, modelRunId) {
  const [attempt, executions] = await Promise.all([
    db.query(`
      SELECT attempt."state"::text AS "state",
        attempt."outcome"::text AS "outcome",
        COALESCE(attempt."degradationCode", 'none') AS "degradationCode",
        COALESCE(attempt."errorCode", 'none') AS "errorCode",
        COALESCE(attempt."budgetSnapshot"->>'reason', 'none') AS "reason",
        COALESCE(attempt."budgetSnapshot"->>'controlReason', 'none') AS "controlReason",
        COALESCE(attempt."budgetSnapshot"#>>'{memoryActionResult,operation}', 'none')
          AS "actionOperation",
        COALESCE(attempt."budgetSnapshot"#>>'{memoryActionResult,status}', 'none')
          AS "actionStatus",
        COALESCE(attempt."budgetSnapshot"#>>'{memoryActionAnswerResult,status}', 'none')
          AS "answerStatus",
        attempt."utilityEgressMode"::text AS "utilityEgressMode",
        ROUND(EXTRACT(EPOCH FROM (attempt."updatedAt" - attempt."createdAt")) * 1000)::integer
          AS "durationMs"
      FROM "MemoryRetrievalAttempt" AS attempt
      WHERE attempt."userId" = $1
        AND attempt."modelRunId" = $2
      ORDER BY attempt."attemptOrdinal" DESC
      LIMIT 1
    `, [userId, modelRunId]),
    db.query(`
      SELECT execution."logicalRole", execution."state"::text AS "state",
        COALESCE(execution."errorCode", 'none') AS "errorCode",
        COUNT(*)::integer AS "count"
      FROM "MemoryExecutionBinding" AS execution
      INNER JOIN "MemoryRetrievalAttempt" AS attempt
        ON attempt."userId" = execution."userId"
       AND attempt."id" = execution."retrievalAttemptId"
      WHERE execution."userId" = $1
        AND attempt."modelRunId" = $2
      GROUP BY execution."logicalRole", execution."state", execution."errorCode"
      ORDER BY execution."logicalRole", execution."state"
    `, [userId, modelRunId])
  ]);
  return {
    attempt: attempt.rows[0] ?? null,
    executions: executions.rows
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: baseUrl,
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 }
  });
  const page = await context.newPage();
  const db = new Client({ connectionString: databaseUrl });
  let cleanupReport = {
    archived: 0,
    explicitForgetFailed: 0,
    explicitForgotten: 0,
    permanent: 0
  };
  try {
    await db.connect();
    const userId = await authenticate(page);
    const target = await db.query(`
      SELECT active_admin."id"
      FROM "User" AS active_admin
      INNER JOIN "UserMemorySettings" AS settings
        ON settings."userId" = active_admin."id"
      WHERE active_admin."role" = 'admin'::"UserRole"
        AND active_admin."status" = 'active'::"UserStatus"
    `);
    ensure(
      target.rowCount === 1 && target.rows[0]?.id === userId,
      "memory_browser_paid_smoke_admin_target_ambiguous"
    );
    const existingMemory = await db.query(`
      SELECT COUNT(*)::integer AS "count"
      FROM "MemoryFactVersion"
      WHERE "userId" = $1
        AND "state" = 'ACTIVE'::"MemoryFactVersionState"
    `, [userId]);
    ensure(
      existingMemory.rows[0]?.count === 0,
      "memory_browser_paid_smoke_clean_owner_required"
    );
    await page.goto("/");
    await page.getByTestId("app-shell").waitFor({ state: "visible" });

    const adminStatus = await responseJson(
      await page.request.get("/api/admin/memory"),
      "memory_admin_status_read_failed"
    );
    ensure(adminStatus?.memory?.worker?.state === "RUNNING", "memory_worker_not_running");
    ensure(
      adminStatus?.memory?.searchTimeout?.seconds === 120,
      "memory_search_timeout_not_120"
    );

    currentStage = "settings-proof";
    const settings = await responseJson(
      await page.request.patch("/api/me/memory/settings", {
        data: {
          decayEnabled: true,
          learnAutomatically: true,
          referenceChatHistory: true,
          useMemoryFacts: true
        }
      }),
      "memory_settings_read_failed"
    );
    ensure(settings?.status === "ON", "memory_status_not_on");
    ensure(settings?.settings?.decayEnabled === true, "decay_not_enabled");
    emit("settings-proof", { decay: true, status: "ON" });

    currentStage = "explicit-save";
    await newChat(page);
    await configureLuna(page);
    const explicitPrompts = [
      `Please remember this stable preference for future chats: in the ${marker} workspace, I prefer ${corePreference} dashboard accents.`,
      `Save this as Personal Memory: my stable dashboard accent preference in the ${marker} workspace is ${corePreference}.`
    ];
    let savedVisible = false;
    let explicitAttempts = 0;
    for (const explicitPrompt of explicitPrompts) {
      explicitAttempts += 1;
      const explicit = await sendMessage(page, explicitPrompt);
      const savedReceipt = explicit.article.getByText("Memory saved.", { exact: true });
      savedVisible = await savedReceipt.isVisible().catch(() => false);
      if (savedVisible) {
        const detail = await chatDetail(page, explicit.chatId);
        const messages = Array.isArray(detail?.chat?.messages) ? detail.chat.messages : [];
        const assistant = [...messages].reverse().find((message) =>
          message?.role === "assistant" && message?.modelRunId === explicit.runId);
        const action = assistant?.artifactSummary?.memoryAction;
        ensure(
          action?.operation === "SAVE" && action?.status === "COMMITTED" &&
            typeof action?.memoryRef === "string",
          "explicit_save_reference_missing"
        );
        trackedMemoryRefs.push(action.memoryRef);
        break;
      }
      const detail = await chatDetail(page, explicit.chatId);
      const messages = Array.isArray(detail?.chat?.messages) ? detail.chat.messages : [];
      const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
      const action = assistant?.artifactSummary?.memoryAction;
      emit("explicit-save-diagnostic", {
        actionOperation: typeof action?.operation === "string" ? action.operation : "NONE",
        actionStatus: typeof action?.status === "string" ? action.status : "NONE",
        attempt: explicitAttempts,
        memory: await controlRunDiagnostic(db, userId, explicit.runId),
        receiptVisible: false
      });
    }
    ensure(savedVisible, "explicit_save_receipt_missing");
    emit("explicit-save", { attempts: explicitAttempts, committed: true });

    currentStage = "automatic-learning";
    await newChat(page);
    await configureLuna(page);
    const automatic = await sendMessage(page, preferenceBatch(0));
    await waitForSourceExtraction(db, userId, automatic.userMessageId, 1);
    const learned = await waitForDirectFacts(
      db,
      page,
      userId,
      automatic.chatId,
      { value: 1 }
    );
    emit("automatic-learning", {
      directFacts: learned.facts.directCount,
      maxCluster: learned.facts.maxCluster,
      preferenceSlots: learned.facts.preferenceSlots,
      terminalExtractions: learned.jobs.terminal
    });

    currentStage = "direct-recall-saved";
    await newChat(page);
    await configureLuna(page);
    const savedRecall = await sendMessage(
      page,
      "What dashboard accent did I explicitly ask you to remember? Use Personal Memory if relevant."
    );
    const savedText = (await savedRecall.article.textContent()) ?? "";
    ensure(savedText.trim().length > 0, "direct_recall_saved_answer_missing");
    let savedProof;
    try {
      savedProof = await waitForRecallSources(page, savedRecall, "SAVED_MEMORY");
    } catch (error) {
      emit("saved-recall-structure", await learnedRecallDiagnostic(
        db,
        userId,
        savedRecall.chatId,
        savedRecall.runId
      ));
      throw error;
    }
    ensure(savedProof.sourceText.includes(corePreference), "direct_recall_explicit_source_missing");
    emit("direct-recall-saved", {
      apiSources: savedProof.apiCount,
      answerVisible: true,
      savedSources: savedProof.savedCount,
      sourceCards: savedProof.uiCount
    });

    currentStage = "direct-recall-learned";
    await newChat(page);
    await configureLuna(page);
    const learnedRecall = await sendMessage(
      page,
      `In the ${marker} workspace, what is my stable format preference for response length? Use Personal Memory if relevant.`
    );
    const learnedText = (await learnedRecall.article.textContent()) ?? "";
    ensure(learnedText.trim().length > 0, "direct_recall_learned_answer_missing");
    let learnedProof;
    try {
      learnedProof = await waitForRecallSources(page, learnedRecall, "LEARNED_MEMORY");
    } catch (error) {
      emit("learned-recall-structure", await learnedRecallDiagnostic(
        db,
        userId,
        automatic.chatId,
        learnedRecall.runId
      ));
      throw error;
    }
    ensure(
      learnedProof.sourceText.includes(preferenceFixtures[0][1]),
      "direct_recall_automatic_source_missing"
    );
    emit("direct-recall-learned", {
      answerVisible: true,
      apiSources: learnedProof.apiCount,
      learnedSources: learnedProof.learnedCount,
      sourceCards: learnedProof.uiCount
    });

    currentStage = "cleanup";
    cleanupReport = await cleanup(page);
    ensure(cleanupReport.explicitForgetFailed === 0, "cleanup_explicit_memory_failed");
    ensure(
      cleanupReport.explicitForgotten === trackedMemoryRefs.length,
      "cleanup_explicit_memory_incomplete"
    );
    emit("cleanup", cleanupReport);
    emit("passed", { diagnostic: "direct-recall", paidProviders: true });
  } finally {
    if (currentStage !== "cleanup" &&
      (trackedChatIds.length > 0 || trackedMemoryRefs.length > 0)) {
      cleanupReport = await cleanup(page).catch(() => cleanupReport);
      emit("cleanup-after-failure", cleanupReport);
    }
    await db.end().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const code = typeof error?.code === "string" && /^[a-z0-9_:-]{1,96}$/u.test(error.code)
    ? error.code
    : typeof error?.message === "string" && /^[a-z0-9_:-]{1,96}$/u.test(error.message)
      ? error.message
      : "browser_memory_smoke_failed";
  process.stderr.write(`${JSON.stringify({ code, stage: currentStage, status: "failed" })}\n`);
  process.exitCode = 1;
});
