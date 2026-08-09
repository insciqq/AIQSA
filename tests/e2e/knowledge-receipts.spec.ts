import { expect, test, type Page, type Route } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";

const timestamp = "2026-08-09T00:00:00.000Z";

function artifactSummary() {
  return {
    citationCount: 0,
    citations: [],
    knowledgeCitations: [],
    knowledgeInvocationCount: 1,
    knowledgeOutcomes: [{ invocationOrdinal: 1, outcome: "complete" }],
    reasoningCount: 0,
    reasoningText: [],
    searchCount: 0,
    searchStrategy: null,
    toolCallCount: 0,
    toolCalls: []
  };
}

function message(input: {
  id: string;
  parentMessageId: string | null;
  role: "assistant" | "user";
  runId?: string;
  text: string;
}) {
  return {
    artifactSummary: input.role === "assistant" ? artifactSummary() : null,
    content: { blocks: [{ text: input.text, type: "text" }] },
    createdAt: timestamp,
    errorMessage: null,
    id: input.id,
    modelId: "gpt-5.5",
    modelRunId: input.runId ?? null,
    parentMessageId: input.parentMessageId,
    provider: "openai",
    role: input.role,
    status: "complete"
  };
}

function persistedRun(runId: string, query: string) {
  const includedText = `Exact passage for ${query}.`;
  return {
    run: {
      errorPayload: null,
      events: [{ eventType: "done", payload: { status: "complete" }, sequence: 1 }],
      id: runId,
      inputTokens: 2,
      knowledgeBindings: [],
      knowledgePlan: { baseIds: [] },
      knowledgeRuns: [{
        baseEvidence: [{
          baseContentRevision: 1,
          baseName: "Runbooks",
          candidateCount: 1,
          indexedContentRevision: 1,
          knowledgeBaseId: "base-runbooks",
          ordinal: 0,
          state: "ready"
        }],
        candidateCount: 1,
        candidateLimit: 40,
        createdAt: timestamp,
        durationMs: 4,
        embeddingUsage: [{ inputTokens: 1, totalTokens: 1 }],
        failureCode: null,
        fusion: "rrf_k60",
        id: `receipt-${runId}`,
        invocationOrdinal: 1,
        modelRunToolCallId: `tool-${runId}`,
        outcome: "complete",
        postRerankOrder: null,
        preRerankOrder: null,
        providerText: "Retrieved evidence.",
        query,
        rerankerBinding: null,
        resultLimit: 8,
        results: [{
          baseName: "Runbooks",
          bindingOrdinal: 0,
          documentVersionNumber: 1,
          fileName: `${runId}.md`,
          fusedScore: 0.02,
          handle: "K1.1",
          includedText,
          includedTextBytes: includedText.length,
          knowledgeBaseId: "base-runbooks",
          page: 1,
          sourceTextBytes: includedText.length,
          textTruncated: false
        }],
        threshold: 0.01
      }],
      modelId: "gpt-5.5",
      outputTokens: 3,
      provider: "openai",
      reasoningTokens: 0,
      searchRuns: [],
      status: "complete",
      toolCalls: [],
      totalTokens: 5
    }
  };
}

async function installReceiptFixture(page: Page) {
  const chat = {
    activeLeafMessageId: "assistant-second",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-knowledge-receipts",
    messageCount: 4,
    messages: [
      message({ id: "user-first", parentMessageId: null, role: "user", text: "First question" }),
      message({
        id: "assistant-first",
        parentMessageId: "user-first",
        role: "assistant",
        runId: "run-first",
        text: "First answer"
      }),
      message({
        id: "user-second",
        parentMessageId: "assistant-first",
        role: "user",
        text: "Second question"
      }),
      message({
        id: "assistant-second",
        parentMessageId: "user-second",
        role: "assistant",
        runId: "run-second",
        text: "Second answer"
      })
    ],
    pinned: false,
    title: "Knowledge receipt ownership",
    updatedAt: timestamp,
    usageStats: null
  };
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-knowledge-receipts")
  );
  const fulfillWorkspace = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { chats: [chat], contentMatches: [], folders: [] } });
  };
  await page.route("**/api/chats?*", fulfillWorkspace);
  await page.route("**/api/chats", fulfillWorkspace);
  await page.route("**/api/chats/chat-knowledge-receipts", async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { chat } });
  });
  await page.route("**/api/model-runs/run-*", async (route: Route) => {
    const runId = new URL(route.request().url()).pathname.split("/").at(-1);
    if (runId === "run-first") {
      await route.fulfill({ json: persistedRun(runId, "first exact query") });
      return;
    }
    if (runId === "run-second") {
      await route.fulfill({ json: persistedRun(runId, "second exact query") });
      return;
    }
    await route.fulfill({ json: { error: "model_run_not_found" }, status: 404 });
  });
}

test("keeps each persisted Knowledge receipt on its originating answer", async ({ page }) => {
  await installReceiptFixture(page);
  await signInWithLocalToken(page);

  const first = page.locator('[data-message-id="assistant-first"]');
  const second = page.locator('[data-message-id="assistant-second"]');
  await first.getByRole("button", { name: /Knowledge 1 invocation/ }).click();
  await first.getByText("Invocation 1").click();
  await expect(first.getByText("first exact query", { exact: true })).toBeVisible();
  await expect(first.getByText("Exact passage for first exact query.")).toBeVisible();

  await second.getByRole("button", { name: /Knowledge 1 invocation/ }).click();
  await second.getByText("Invocation 1").click();
  await expect(second.getByText("second exact query", { exact: true })).toBeVisible();
  await expect(second.getByText("Exact passage for second exact query.")).toBeVisible();
  await expect(first.getByText("first exact query", { exact: true })).toBeVisible();
  await expect(first.getByText("second exact query", { exact: true })).toHaveCount(0);

  await first.getByRole("button", { name: /Knowledge 1 invocation/ }).click();
  await first.getByRole("button", { name: /Knowledge 1 invocation/ }).click();
  await first.getByText("Invocation 1").click();
  await expect(first.getByText("first exact query", { exact: true })).toBeVisible();
  await expect(second.getByText("second exact query", { exact: true })).toBeVisible();
});

test("mounts inline Knowledge only after a streaming answer settles", async ({ page }) => {
  let terminal = false;
  let runReads = 0;
  const chat = () => ({
    activeLeafMessageId: "assistant-streaming",
    createdAt: timestamp,
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-knowledge-streaming",
    messageCount: 2,
    messages: [
      message({ id: "user-streaming", parentMessageId: null, role: "user", text: "Streaming question" }),
      {
        ...message({
          id: "assistant-streaming",
          parentMessageId: "user-streaming",
          role: "assistant",
          runId: "run-streaming",
          text: terminal ? "Settled answer" : "Streaming answer"
        }),
        status: terminal ? "complete" : "streaming"
      }
    ],
    pinned: false,
    title: "Knowledge streaming stability",
    updatedAt: timestamp,
    usageStats: null
  });
  await page.addInitScript(() =>
    window.localStorage.setItem("aiqsa.activeChatId", "chat-knowledge-streaming")
  );
  const fulfillWorkspace = async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { chats: [chat()], contentMatches: [], folders: [] } });
  };
  await page.route("**/api/chats?*", fulfillWorkspace);
  await page.route("**/api/chats", fulfillWorkspace);
  await page.route("**/api/chats/chat-knowledge-streaming", async (route: Route) => {
    await route.fulfill({ json: { chat: chat() } });
  });
  await page.route("**/api/model-runs/run-streaming", async (route: Route) => {
    runReads += 1;
    const projection = persistedRun("run-streaming", "terminal exact query");
    if (!terminal) {
      projection.run.events = [{ eventType: "start", payload: { status: "streaming" }, sequence: 1 }];
      projection.run.knowledgeRuns = [];
      projection.run.status = "streaming";
    }
    await route.fulfill({ json: projection });
  });

  await signInWithLocalToken(page);
  const answer = page.locator('[data-message-id="assistant-streaming"]');
  await expect(answer).toContainText("Streaming answer");
  await expect.poll(() => runReads).toBeGreaterThan(0);
  await expect(answer.getByTestId("thread-knowledge-evidence")).toHaveCount(0);

  terminal = true;
  await expect(answer.getByRole("button", { name: /Knowledge 1 invocation/ })).toBeVisible({
    timeout: 10_000
  });
  await answer.getByRole("button", { name: /Knowledge 1 invocation/ }).click();
  await answer.getByText("Invocation 1").click();
  await expect(answer.getByText("Exact passage for terminal exact query.")).toBeVisible();
});
