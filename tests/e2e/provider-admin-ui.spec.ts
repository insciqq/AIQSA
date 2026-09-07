import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  AdminProviderConnection,
  AdminProviderModelConfiguration
} from "../../lib/contracts/adminProviders";
import {
  adminSearchExecutionDefaults,
  type AdminSearchCatalog
} from "../../lib/contracts/adminSearch";
import { adminProviderQuickSetupPolicy } from "../../lib/server/admin/providers/quickSetupPolicy";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { parseSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { chooseSearchStrategy, selectModel } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

const prisma = new PrismaClient();

const now = "2026-07-23T00:00:00.000Z";
const quickAnswer = "Real Quick setup answer received.";
const playwrightEncryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

type LocalResponsesRequest = {
  authorization: string;
  body: Record<string, unknown>;
  method: string;
  path: string;
};

type QuickChatFixture = {
  accessGrantId: string;
  checkId: string;
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  modelId: string;
  priorDefaultControlValues: unknown;
  priorDefaultModelId: string | null;
  userId: string;
};

type QuickCatalogBody = {
  catalog: {
    defaults: {
      modelId: string;
      provider: string;
    };
    models: Array<{
      displayName: string;
      modelId: string;
      provider: string;
      providerFamily: string;
      upstreamModelId: string;
    }>;
    providers: Array<{
      family: string;
      id: string;
      models: string[];
      name: string;
    }>;
  };
};

type QuickChatDetailBody = {
  chat: {
    id: string;
    messages: Array<{
      content: unknown;
      id: string;
      modelRunId: string | null;
      role: string;
      status: string;
    }>;
  };
};

type QuickRunBody = {
  run: {
    id: string;
    status: string;
  };
  version: 1;
};

function json(value: unknown): Prisma.InputJsonValue {
  return structuredClone(value) as Prisma.InputJsonValue;
}

function completedOpenAIResponse(responseId: string) {
  return {
    id: responseId,
    model: "gpt-5.6-sol",
    output: [
      {
        content: [{ annotations: [], text: quickAnswer, type: "output_text" }],
        role: "assistant",
        type: "message"
      }
    ],
    status: "completed",
    usage: {
      input_tokens: 11,
      output_tokens: 6,
      total_tokens: 17
    }
  };
}

async function startLocalResponsesServer() {
  const requests: LocalResponsesRequest[] = [];
  let sseResponses = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({
        authorization: request.headers.authorization ?? "",
        body,
        method: request.method ?? "",
        path
      });

      if (request.method !== "POST" || path !== "/responses") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unexpected_e2e_upstream_request" }));
        return;
      }

      const responseId = `resp-e2e-${randomUUID()}`;
      const completed = completedOpenAIResponse(responseId);
      if (body.stream === true) {
        sseResponses += 1;
        const sseBody = [
          `event: response.created\ndata: ${JSON.stringify({
            response: { id: responseId, model: "gpt-5.6-sol", status: "in_progress" },
            type: "response.created"
          })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            delta: quickAnswer,
            response_id: responseId,
            type: "response.output_text.delta"
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            response: completed,
            type: "response.completed"
          })}\n\n`
        ].join("");
        response.writeHead(200, {
          "cache-control": "no-cache",
          "connection": "close",
          "content-length": Buffer.byteLength(sseBody),
          "content-type": "text/event-stream"
        });
        response.end(sseBody);
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completed));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "local_responses_server_failed"
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    apiRoot: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    requests,
    get sseResponses() {
      return sseResponses;
    }
  };
}

async function installQuickChatFixture(apiRoot: string): Promise<QuickChatFixture> {
  const policy = adminProviderQuickSetupPolicy("openai");
  const candidate = policy.candidates.find(({ candidateId }) => candidateId === "p2-o3");
  if (!candidate) throw new Error("OpenAI Sol Quick candidate is missing");

  const fixture = {
    accessGrantId: randomUUID(),
    checkId: randomUUID(),
    connectionId: randomUUID(),
    credentialId: randomUUID(),
    credentialVersionId: randomUUID(),
    modelId: randomUUID(),
    userId: DEFAULT_BOOTSTRAP_USER_ID
  };
  const checkedAt = new Date();
  const connectionConfig = {
    allowPrivateNetwork: true,
    apiRoot,
    authenticationMode: "bearer" as const,
    responseTimeoutMs: 300_000
  };
  const streamingDefaultParams = {
    ...candidate.configuration.defaultParams,
    background: false,
    stream: true
  };
  const streamingModelConfiguration = {
    ...candidate.configuration,
    defaultParams: streamingDefaultParams
  };
  const encryptionKey = parseSecretEncryptionKey(
    process.env.AIQSA_ENCRYPTION_KEY?.trim() || playwrightEncryptionKey
  );
  const secretEnvelope = encryptProviderCredentialSecret({
    credentialId: fixture.credentialId,
    key: encryptionKey,
    secret: "e2e-local-openai-key",
    valueId: fixture.credentialVersionId
  });

  const priorState = await prisma.$transaction(async (tx) => {
    const settings = await tx.userSettings.findUniqueOrThrow({
      select: { defaultControlValues: true, defaultProviderModelId: true },
      where: { userId: fixture.userId }
    });
    await tx.providerConnection.create({
      data: {
        activatedAt: checkedAt,
        activeConfig: json(connectionConfig),
        activeVersion: 1,
        displayName: "OpenAI",
        draftConfig: json(connectionConfig),
        draftVersion: 1,
        enabled: true,
        family: "openai",
        id: fixture.connectionId,
        templateKey: null,
        unassignedPolicy: "use_default"
      }
    });
    await tx.providerModel.create({
      data: {
        activatedAt: checkedAt,
        activeConfig: json(streamingModelConfiguration),
        activeVersion: 1,
        capabilities: json(candidate.model.capabilities),
        connectionId: fixture.connectionId,
        defaultParams: json(streamingDefaultParams),
        displayName: candidate.displayName,
        draftConfig: json(streamingModelConfiguration),
        draftVersion: 1,
        enabled: true,
        id: fixture.modelId,
        inputTokenPriceMicros: candidate.model.inputTokenPriceMicros,
        modelId: candidate.model.modelId,
        outputTokenPriceMicros: candidate.model.outputTokenPriceMicros,
        provider: candidate.model.provider,
        supportsNativeSearch: candidate.model.capabilities.nativeSearch,
        supportsPdf: candidate.model.capabilities.pdf,
        supportsReasoning: candidate.model.capabilities.reasoning,
        supportsVision: candidate.model.capabilities.vision,
        templateKey: null
      }
    });
    await tx.providerCredential.create({
      data: {
        activatedAt: checkedAt,
        connectionId: fixture.connectionId,
        draftSecretEnvelope: null,
        draftVersion: 1,
        enabled: true,
        id: fixture.credentialId,
        label: `Quick setup · ${fixture.credentialId}`,
        testedAt: checkedAt
      }
    });
    await tx.providerCredentialVersion.create({
      data: {
        activatedAt: checkedAt,
        credentialId: fixture.credentialId,
        id: fixture.credentialVersionId,
        secretEnvelope,
        testEvidence: json({ method: "e2e_local_responses", status: "valid" }),
        testedAt: checkedAt,
        version: 1
      }
    });
    await tx.providerCredential.update({
      data: { activeVersionId: fixture.credentialVersionId },
      where: { id: fixture.credentialId }
    });
    await tx.providerConnection.update({
      data: { defaultCredentialId: fixture.credentialId },
      where: { id: fixture.connectionId }
    });
    await tx.providerUserCredentialAssignment.create({
      data: {
        connectionId: fixture.connectionId,
        credentialId: fixture.credentialId,
        userId: fixture.userId
      }
    });
    await tx.providerModelCredentialCheck.create({
      data: {
        checkedAt,
        connectionId: fixture.connectionId,
        connectionVersion: 1,
        credentialId: fixture.credentialId,
        credentialVersionId: fixture.credentialVersionId,
        evidence: json({ method: "e2e_local_responses", upstreamModelId: "gpt-5.6-sol" }),
        id: fixture.checkId,
        modelVersion: 1,
        providerModelId: fixture.modelId,
        status: "available"
      }
    });
    await tx.accessGrant.create({
      data: {
        enabled: true,
        groupId: null,
        id: fixture.accessGrantId,
        providerConnectionId: null,
        providerModelId: fixture.modelId,
        searchStrategy: null,
        userId: fixture.userId
      }
    });
    await tx.userSettings.update({
      data: {
        defaultControlValues: json({
          ...(typeof settings.defaultControlValues === "object" &&
            settings.defaultControlValues !== null &&
            !Array.isArray(settings.defaultControlValues)
            ? settings.defaultControlValues
            : {}),
          [`${fixture.connectionId}:${fixture.modelId}`]: {
            backgroundMode: false,
            streamMode: true
          }
        }),
        defaultProviderModelId: settings.defaultProviderModelId
      },
      where: { userId: fixture.userId }
    });

    return { settings };
  });

  return {
    ...fixture,
    priorDefaultControlValues: priorState.settings.defaultControlValues,
    priorDefaultModelId: priorState.settings.defaultProviderModelId
  };
}

async function cleanupQuickChatFixture(
  fixture: QuickChatFixture,
  trackedChatIds: readonly string[],
  trackedRunIds: readonly string[]
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.userSettings.updateMany({
      data: {
        defaultControlValues: json(fixture.priorDefaultControlValues),
        defaultProviderModelId: fixture.priorDefaultModelId
      },
      where: { userId: fixture.userId }
    });
    const fixtureChats = await tx.chat.findMany({
      select: { id: true },
      where: {
        defaultProviderModelId: fixture.modelId,
        userId: fixture.userId
      }
    });
    const fixtureRuns = await tx.modelRun.findMany({
      select: { chatId: true, id: true },
      where: {
        OR: [
          { id: { in: [...trackedRunIds] } },
          { modelId: fixture.modelId },
          { providerRunBindings: { some: { providerModelId: fixture.modelId } } }
        ],
        userId: fixture.userId
      }
    });
    const runIds = [...new Set([...trackedRunIds, ...fixtureRuns.map(({ id }) => id)])];
    const chatIds = [...new Set([
      ...trackedChatIds,
      ...fixtureChats.map(({ id }) => id),
      ...fixtureRuns.map(({ chatId }) => chatId)
    ])];

    await tx.providerRunBinding.deleteMany({
      where: {
        OR: [
          { connectionId: fixture.connectionId },
          { credentialId: fixture.credentialId },
          { providerModelId: fixture.modelId }
        ]
      }
    });
    if (runIds.length > 0) {
      await tx.modelRun.deleteMany({ where: { id: { in: runIds } } });
    }
    if (chatIds.length > 0) {
      await tx.memoryJob.deleteMany({
        where: { chatId: { in: chatIds }, userId: fixture.userId }
      });
      await tx.chat.deleteMany({ where: { id: { in: chatIds }, userId: fixture.userId } });
    }
    await tx.accessGrant.deleteMany({
      where: {
        OR: [
          { id: fixture.accessGrantId },
          { providerConnectionId: fixture.connectionId },
          { providerModelId: fixture.modelId }
        ]
      }
    });
    await tx.providerDraftCheck.deleteMany({ where: { connectionId: fixture.connectionId } });
    await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId: fixture.connectionId } });
    await tx.providerUserCredentialAssignment.deleteMany({
      where: { connectionId: fixture.connectionId, userId: fixture.userId }
    });
    await tx.providerConnection.updateMany({
      data: { defaultCredentialId: null },
      where: { id: fixture.connectionId }
    });
    await tx.providerCredential.updateMany({
      data: { activeVersionId: null },
      where: { id: fixture.credentialId }
    });
    await tx.providerCredentialVersion.deleteMany({ where: { credentialId: fixture.credentialId } });
    await tx.providerCredential.deleteMany({ where: { id: fixture.credentialId } });
    await tx.providerModel.deleteMany({ where: { id: fixture.modelId } });
    await tx.providerConnection.deleteMany({ where: { id: fixture.connectionId } });
  });
}

async function waitForActiveChatId(page: Page): Promise<string> {
  let chatId: string | null = null;
  await expect.poll(async () => {
    chatId = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
    return chatId;
  }).not.toBeNull();
  return chatId!;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signInOrdinaryUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

async function expectFullyHitTestable(surface: Locator): Promise<void> {
  await expect(surface).toBeVisible();
  await expect.poll(() => surface.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const inset = 2;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const points = [
      [centerX, rect.top + inset],
      [centerX, rect.bottom - inset],
      [rect.left + inset, centerY],
      [rect.right - inset, centerY]
    ];

    return points.every(([x, y]) => {
      const target = document.elementFromPoint(x!, y!);
      return target === element || (target !== null && element.contains(target));
    });
  })).toBe(true);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return document.body.scrollWidth <= viewport + 1 &&
      document.documentElement.scrollWidth <= viewport + 1;
  })).toBe(true);
}

async function expectReadableDetail(page: Page, detail: Locator): Promise<void> {
  const box = await detail.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.width).toBeGreaterThanOrEqual(640);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

test("administrator completes the Quick direct-user picker, retry, Ready, and safe replacement journey", async ({ page }) => {
  const upstream = await startLocalResponsesServer();
  const enabledMcpPreferences = await prisma.mcpUserServer.findMany({
    select: { id: true },
    where: { enabled: true, userId: DEFAULT_BOOTSTRAP_USER_ID }
  });
  if (enabledMcpPreferences.length) {
    await prisma.mcpUserServer.updateMany({
      data: { enabled: false },
      where: { id: { in: enabledMcpPreferences.map(({ id }) => id) } }
    });
  }
  const fixtureState: { current: QuickChatFixture | null } = { current: null };
  const trackedChatIds: string[] = [];
  const trackedRunIds: string[] = [];
  let configured = false;
  const quickRequests: Array<{ body: Record<string, unknown>; method: string }> = [];
  const messageRequests: Record<string, unknown>[] = [];
  let releasePickerRetry!: () => void;
  let releaseReplacement!: () => void;
  const pickerRetryCanFinish = new Promise<void>((resolve) => {
    releasePickerRetry = resolve;
  });
  const replacementCanFinish = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });

  try {
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/chats\/[^/]+\/messages$/u.test(path)) {
      messageRequests.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.route("**/api/admin/providers/quick-setup", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      quickRequests.push({ body: {}, method: "GET" });
      await route.fulfill({
        contentType: "application/json",
        json: {
          configuredConnections: configured ? [{
            activeModelCount: 3,
            displayName: "Quick OpenAI",
            enabled: true,
            family: "openai",
            id: "quick-openai-connection"
          }] : [],
          providers: [
            {
              ...(configured ? { model: { displayName: "GPT-5.6 Sol" } } : {}),
              provider: "openai",
              providerDisplayName: "OpenAI",
              quickSetupAssigned: configured,
              state: configured ? "ready" : "not_configured",
              stateToken: configured ? "state-openai-ready" : "state-openai-fresh"
            },
            { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
            { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
            { provider: "deepseek", providerDisplayName: "DeepSeek", quickSetupAssigned: false, state: "not_configured", stateToken: "state-deepseek" },
            { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openrouter" }
          ],
          suggestedProvider: configured ? "openai" : null
        }
      });
      return;
    }

    const body = request.postDataJSON() as Record<string, unknown>;
    quickRequests.push({ body, method: request.method() });
    const postNumber = quickRequests.filter(({ method }) => method === "POST").length;
    if (postNumber === 1) {
      expect(body).toEqual({
        expectedState: "state-openai-fresh",
        provider: "openai",
        secret: "e2e-quick-write-only-key"
      });
      await route.fulfill({
        contentType: "application/json",
        json: {
          candidates: [
            { candidateId: "p2-o2", displayName: "GPT-5.6 Luna" },
            { candidateId: "p2-o3", displayName: "GPT-5.6 Sol" }
          ],
          checkedAt: now,
          expectedState: "state-openai-picker",
          outcome: "selection_required",
          policyVersion: 3,
          provider: "openai",
          providerDisplayName: "OpenAI"
        }
      });
      return;
    }
    if (postNumber === 2 || postNumber === 3) {
      expect(body).toEqual({
        expectedState: "state-openai-picker",
        provider: "openai",
        secret: "e2e-quick-write-only-key",
        selectedModel: { candidateId: "p2-o3", policyVersion: 3 }
      });
      if (postNumber === 2) {
        await pickerRetryCanFinish;
        await route.fulfill({
          contentType: "application/json",
          json: { error: "provider_credential_test_failed" },
          status: 422
        });
        return;
      }
      configured = true;
      fixtureState.current = await installQuickChatFixture(upstream.apiRoot);
      await route.fulfill({
        contentType: "application/json",
        json: {
          checkedAt: now,
          defaultCredentialChanged: true,
          defaultChanged: false,
          model: { displayName: "GPT-5.6 Sol" },
          models: [
            { displayName: "GPT-5.6 Terra" },
            { displayName: "GPT-5.6 Luna" },
            { displayName: "GPT-5.6 Sol" }
          ],
          outcome: "ready",
          provider: "openai",
          providerDisplayName: "OpenAI"
        }
      });
      return;
    }
    expect(postNumber).toBe(4);
    expect(body).toEqual({
      expectedState: "state-openai-ready",
      provider: "openai",
      secret: "e2e-failing-replacement-key"
    });
    await replacementCanFinish;
    await route.fulfill({
      contentType: "application/json",
      json: { error: "provider_credential_test_failed" },
      status: 422
    });
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Providers");
  await expect(section.getByRole("list", { name: "Providers" })).toBeVisible();
  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByTestId("admin-topbar-title")).toContainText("Add provider");
  const quickFeedback = section.getByTestId("provider-quick-feedback");
  await expect(quickFeedback).toHaveAttribute("role", "status");
  await expect(quickFeedback).toHaveText("Provider Quick setup loaded.");
  await expect(section.getByLabel("API key")).toHaveCount(0);

  await section.getByRole("button", { name: /OpenAI Not configured/ }).click();
  await section.getByLabel("API key").fill("e2e-quick-write-only-key");
  const keyBox = await section.getByLabel("API key").boundingBox();
  const saveBox = await section.getByRole("button", { name: "Test & Save" }).boundingBox();
  expect(keyBox).toBeTruthy();
  expect(saveBox).toBeTruthy();
  expect(saveBox!.y).toBeGreaterThanOrEqual(keyBox!.y + keyBox!.height);
  await expectNoPageOverflow(page);
  await section.getByRole("button", { name: "Test & Save" }).click();
  await expect(section.getByText("Choose a model available to this key")).toBeVisible();
  await expect(quickFeedback).toHaveText(
    "OpenAI needs a model choice. Choose one to finish setup."
  );
  await expect(section.getByLabel("API key")).toHaveValue("e2e-quick-write-only-key");
  await section.getByLabel("GPT-5.6 Sol").click();
  await expect(quickFeedback).toHaveText(
    "GPT-5.6 Sol selected. Submit again to finish setup."
  );
  await section.getByRole("button", { name: "Use selected model & save" }).click();
  await expect(section.getByRole("button", { name: "Testing & saving…" })).toBeVisible();
  await expect(quickFeedback).toHaveText("Testing and saving OpenAI.");
  await expect(section.getByLabel("API key")).toBeDisabled();
  await expect(section.getByLabel("GPT-5.6 Luna")).toBeDisabled();
  await expect(section.getByLabel("GPT-5.6 Sol")).toBeDisabled();
  await expectNoPageOverflow(page);
  releasePickerRetry();
  await expect(section.getByText(
    "The provider rejected the key or its account catalog could not be reached.",
    { exact: true }
  )).toBeVisible();
  await expect(quickFeedback).toHaveAttribute("role", "status");
  await expect(quickFeedback).toHaveAttribute("data-feedback-tone", "error");
  await expect(quickFeedback).toContainText("OpenAI setup failed.");
  await expect(section.getByLabel("API key")).toHaveAttribute("aria-invalid", "true");
  await expect(section.getByLabel("API key")).toHaveAttribute(
    "aria-errormessage",
    "provider-quick-setup-error"
  );
  await expect(section.getByLabel("API key")).toHaveValue("e2e-quick-write-only-key");
  await section.getByRole("button", { name: "Use selected model & save" }).click();
  await expect(quickFeedback).toHaveAttribute("role", "status");
  await expect(section.getByLabel("API key")).toHaveCount(0);
  await expect(section.getByText("Ready to chat", { exact: true })).toBeVisible();
  await expect(section.getByRole("heading", { name: "GPT-5.6 Sol" })).toBeVisible();
  const readySummary = section.getByTestId("provider-quick-ready-summary");
  await expect(readySummary).toContainText("API key: saved and verified.");
  await expect(readySummary).toContainText("Prepared model: GPT-5.6 Sol.");
  await expect(readySummary).toContainText(
    "Available models: GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.6 Sol."
  );
  await expect(readySummary).toContainText("Access: available to this administrator.");
  await expect(readySummary).toContainText(
    "Connection default credential: set to this verified key."
  );
  await expect(readySummary).toContainText(
    "Default models: unchanged. Choose one explicitly from the model picker or the Default model task."
  );
  await expect(readySummary).not.toContainText("Default selection: updated.");
  await expect(readySummary).not.toContainText("Run profiles filled");
  await expect(section.getByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
  await expect(quickFeedback).toHaveText("OpenAI is ready to chat with GPT-5.6 Sol.");
  await expect(section.getByText("e2e-quick-write-only-key")).toHaveCount(0);
  await expect(section.getByRole("heading", { name: "Configured connections" })).toBeVisible();
  await expect(section.getByTestId("provider-configured-connection-quick-openai-connection"))
    .toContainText("Quick OpenAI");
  await expect(section.getByTestId("provider-configured-connection-quick-openai-connection"))
    .toContainText("OpenAI · 3 active models");

  await expect(section.getByRole("button", { name: /OpenAI Ready/ })).toBeVisible();
  await section.getByRole("button", { name: "Replace API key" }).click();
  await expect(section.getByLabel("API key")).toHaveValue("");
  await section.getByLabel("API key").fill("e2e-failing-replacement-key");
  await section.getByRole("button", { name: "Test & Save" }).click();
  await expect(section.getByRole("button", { name: "Testing & saving…" })).toBeVisible();
  await expect(section.getByText("Ready to chat", { exact: true })).toBeVisible();
  await expect(section.getByLabel("API key")).toBeDisabled();
  await expectNoPageOverflow(page);
  releaseReplacement();
  await expect(section.getByText(
    "The provider rejected the key or its account catalog could not be reached.",
    { exact: true }
  )).toBeVisible();
  await expect(quickFeedback).toHaveAttribute("role", "status");
  await expect(quickFeedback).toHaveAttribute("data-feedback-tone", "error");
  await expect(section.getByLabel("API key")).toHaveAttribute("aria-invalid", "true");
  await expect(section.getByText("Ready to chat", { exact: true })).toBeVisible();
  await expect(section.getByLabel("API key")).toHaveValue("e2e-failing-replacement-key");
  await section.getByRole("button", { name: "Cancel replacement" }).click();
  await section.getByRole("button", { name: "Replace API key" }).click();
  await expect(section.getByLabel("API key")).toHaveValue("");
  await section.getByRole("button", { name: "Cancel replacement" }).click();

  expect(quickRequests.filter(({ method }) => method === "POST")).toHaveLength(4);
  expect(quickRequests.filter(({ method }) => method === "GET").length).toBeGreaterThanOrEqual(2);

  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 844, width: 390 },
    { height: 1024, width: 768 },
    { height: 390, width: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await section.getByRole("link", { name: "Start chatting" }).scrollIntoViewIfNeeded();
    await expect(section.getByRole("link", { name: "Start chatting" })).toBeVisible();
    await expect(page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers" })).toBeVisible();
    await expectNoPageOverflow(page);
    const columns = await section.getByTestId("provider-quick-choice-strip").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length
    );
    expect(columns).toBe(viewport.width < 640 ? 2 : viewport.width < 1024 ? 3 : 6);
  }

  const catalogResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/api/me/catalog"
  );
  await section.getByRole("link", { name: "Start chatting" }).click();
  const realCatalogResponse = await catalogResponse;
  expect(realCatalogResponse.ok()).toBe(true);
  await expect(page).toHaveURL(/\/$/);
  const installedFixture = fixtureState.current;
  if (!installedFixture) throw new Error("Quick setup fixture was not installed");
  await expect(prisma.userSettings.findUniqueOrThrow({
    select: { defaultProviderModelId: true },
    where: { userId: installedFixture.userId }
  })).resolves.toEqual({ defaultProviderModelId: installedFixture.priorDefaultModelId });
  await expect(prisma.providerConnection.findUniqueOrThrow({
    select: { defaultCredentialId: true },
    where: { id: installedFixture.connectionId }
  })).resolves.toEqual({ defaultCredentialId: installedFixture.credentialId });
  const catalogBody = await realCatalogResponse.json() as QuickCatalogBody;
  expect(catalogBody.catalog.defaults).not.toMatchObject({
    modelId: installedFixture.modelId,
    provider: installedFixture.connectionId
  });
  expect(catalogBody.catalog.models.filter(({ modelId }) => modelId === installedFixture.modelId))
    .toEqual([
      expect.objectContaining({
        displayName: "GPT-5.6 Sol",
        modelId: installedFixture.modelId,
        provider: installedFixture.connectionId,
        providerFamily: "openai",
        upstreamModelId: "gpt-5.6-sol"
      })
    ]);
  expect(catalogBody.catalog.providers.filter(({ id }) => id === installedFixture.connectionId))
    .toEqual([{
      family: "openai",
      id: installedFixture.connectionId,
      models: [installedFixture.modelId],
      name: "OpenAI"
    }]);
  await selectModel(page, installedFixture.connectionId, "GPT-5.6 Sol", "OpenAI");
  await chooseSearchStrategy(page, "^Off");
  await expect(page.getByTestId("header-model-trigger")).toContainText("GPT-5.6 Sol");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeEnabled();
  const question = `First question after Quick setup ${randomUUID()}`;
  await composer.fill(question);
  const messageResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname)
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const completedMessageResponse = await messageResponse;
  expect(completedMessageResponse.ok(), await completedMessageResponse.text()).toBe(true);
  const chatId = await waitForActiveChatId(page);
  trackedChatIds.push(chatId);
  await expect.poll(() => messageRequests.length).toBe(1);
  expect(messageRequests[0]).toMatchObject({
    modelId: installedFixture.modelId,
    provider: installedFixture.connectionId,
    searchPlan: { mode: "all_selected", optionIds: [] }
  });
  expect(messageRequests[0]?.content).toEqual({
    blocks: [{ text: question, type: "text" }]
  });
  await expect.poll(() => upstream.requests.length, { timeout: 20_000 }).toBe(1);
  expect(upstream.requests[0]).toMatchObject({
    authorization: "Bearer e2e-local-openai-key",
    method: "POST",
    path: "/responses"
  });
  expect(upstream.requests[0]?.body).toMatchObject({
    background: false,
    model: "gpt-5.6-sol",
    stream: true
  });
  expect(upstream.sseResponses).toBe(1);
  expect(JSON.stringify(upstream.requests[0]?.body.input)).toContain(question);
  const conversation = page.getByTestId("conversation-thread");
  await expect(conversation).toContainText(question);
  await expect(conversation).toContainText(quickAnswer, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Stop answer" }))
    .toHaveCount(0, { timeout: 20_000 });

  await expect.poll(async () => {
    const chatResponse = await page.request.get(`/api/chats/${chatId}`);
    if (!chatResponse.ok()) return { answerRetained: false, status: "request_failed" };
    const chatBody = await chatResponse.json() as QuickChatDetailBody;
    const assistant = chatBody.chat.messages.find(({ role }) => role === "assistant");
    return {
      answerRetained: JSON.stringify(assistant?.content).includes(quickAnswer),
      status: assistant?.status ?? "missing"
    };
  }, { timeout: 20_000 }).toEqual({ answerRetained: true, status: "complete" });
  const durableChatResponse = await page.request.get(`/api/chats/${chatId}`);
  expect(durableChatResponse.ok()).toBe(true);
  const chatBody = await durableChatResponse.json() as QuickChatDetailBody;
  const userMessage = chatBody.chat.messages.find(({ role }) => role === "user");
  const assistantMessage = chatBody.chat.messages.find(({ role }) => role === "assistant");
  expect(JSON.stringify(userMessage?.content)).toContain(question);
  expect(assistantMessage?.status).toBe("complete");
  expect(assistantMessage?.modelRunId).toBeTruthy();
  const runId = assistantMessage!.modelRunId!;
  trackedRunIds.push(runId);
  expect(JSON.stringify(assistantMessage?.content)).toContain(quickAnswer);

  const runResponse = await page.request.get(`/api/model-runs/${runId}`);
  expect(runResponse.ok()).toBe(true);
  const runBody = await runResponse.json() as QuickRunBody;
  expect(runBody).toEqual({
    run: {
      id: runId,
      status: "complete"
    },
    version: 1
  });
  await expect(prisma.providerRunBinding.findUnique({
    select: {
      connectionId: true,
      credentialSource: true,
      credentialId: true,
      credentialVersionId: true,
      providerModelId: true
    },
    where: { modelRunId_bindingKey: { bindingKey: "answer", modelRunId: runId } }
  })).resolves.toEqual({
    connectionId: installedFixture.connectionId,
    credentialSource: "user",
    credentialId: installedFixture.credentialId,
    credentialVersionId: installedFixture.credentialVersionId,
    providerModelId: installedFixture.modelId
  });
  } finally {
    releasePickerRetry();
    releaseReplacement();
    try {
      if (fixtureState.current) {
        await cleanupQuickChatFixture(fixtureState.current, trackedChatIds, trackedRunIds);
      }
    } finally {
      try {
        if (enabledMcpPreferences.length) {
          await prisma.mcpUserServer.updateMany({
            data: { enabled: true },
            where: { id: { in: enabledMcpPreferences.map(({ id }) => id) } }
          });
        }
      } finally {
        await upstream.close();
      }
    }
  }
});

test("administrator discovers and configures a Custom compatible provider on wide and compact screens", async ({ page }) => {
  const discovered: Record<string, unknown>[] = [];
  const submitted: Record<string, unknown>[] = [];
  let receipt = 0;

  await page.route("**/api/admin/providers/quick-setup", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      contentType: "application/json",
      json: {
        configuredConnections: [{
          activeModelCount: 2,
          displayName: "Existing Compatible",
          enabled: true,
          family: "openai_compatible",
          id: "existing-compatible"
        }],
        providers: [
          { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openai" },
          { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
          { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
          { provider: "deepseek", providerDisplayName: "DeepSeek", quickSetupAssigned: false, state: "not_configured", stateToken: "state-deepseek" },
          { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openrouter" }
        ],
        suggestedProvider: null
      }
    });
  });
  await page.route("**/api/admin/providers/custom-setup", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    receipt += 1;
    const selectedModelIds = Array.isArray(body.modelIds)
      ? body.modelIds.filter((value): value is string => typeof value === "string")
      : [];
    const readyModels = selectedModelIds.map((modelDisplayName, index) => ({
      modelDisplayName,
      providerModelId: `custom-model-${receipt}-${index + 1}`
    }));
    await route.fulfill({
      contentType: "application/json",
      json: {
        authenticationMode: "bearer",
        checkedAt: now,
        connectionDisplayName: `Fixture Compatible ${receipt}`,
        connectionId: `custom-connection-${receipt}`,
        defaultChanged: receipt === 1,
        modelDisplayName: readyModels[0]?.modelDisplayName ?? `Fixture Model ${receipt}`,
        models: readyModels.length ? readyModels : [{
          modelDisplayName: `Fixture Model ${receipt}`,
          providerModelId: `custom-model-${receipt}`
        }],
        outcome: "ready",
        providerModelId: readyModels[0]?.providerModelId ?? `custom-model-${receipt}`,
        search: {
          displayName: `Fixture Compatible ${receipt} Search`,
          status: "ready"
        }
      }
    });
  });
  await page.route("**/api/admin/providers/custom-setup/discover", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as Record<string, unknown>;
    discovered.push(body);
    const viewport = page.viewportSize();
    const modelId = `fixture/model-${viewport?.width ?? 0}`;
    await route.fulfill({
      contentType: "application/json",
      json: {
        checkedAt: now,
        modelCount: 2,
        models: [
          { capabilities: {}, id: modelId },
          { capabilities: {}, id: "fixture/alternate" }
        ],
        source: "models_catalog",
        status: "valid"
      }
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(section.getByRole("button", { name: /Custom 1 configured/ })).toBeVisible();
  await expect(section.getByTestId("provider-configured-connection-existing-compatible"))
    .toContainText("OpenAI-compatible · 2 active models");

  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 844, width: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId("admin-topbar-title")).toContainText("Add provider");
    // Five native providers plus the Custom (OpenAI-compatible) entry.
    await expect(section.getByTestId("provider-quick-choice-strip").getByRole("button"))
      .toHaveCount(6);
    await section.getByRole("button", { name: /Custom 1 configured/ }).click();
    await expect(section.getByRole("heading", { name: "Connect a custom endpoint" })).toBeVisible();
    await expect(section.getByLabel("API root")).toBeVisible();
    await expect(section.getByLabel("Model ID")).toBeVisible();
    await expect(section.getByLabel("API key")).toHaveAttribute("type", "password");
    await expect(section.getByLabel("Context window")).toBeHidden();
    await expectNoPageOverflow(page);

    const key = `e2e-custom-write-only-key-${viewport.width}`;
    await section.getByLabel("API root").fill("https://llm.fixture.invalid/v1");
    await section.getByLabel("API key").fill(key);
    await section.getByRole("button", { name: "Discover models" }).click();
    await section.getByRole("button", { name: "Add models reported by this endpoint (2)" }).click();
    await section.getByRole("option", { name: new RegExp(`fixture/model-${viewport.width}`) })
      .click();
    await section.getByRole("button", { name: "Add models reported by this endpoint (2)" }).click();
    await section.getByRole("option", { name: /fixture\/alternate/ }).click();

    await section.getByText("Advanced settings", { exact: true }).click();
    await expect(section.getByLabel("Context window")).toBeVisible();
    await expect(section.getByLabel("Default max output")).toBeVisible();
    await expect(section.getByLabel("Reasoning controls"))
      .toHaveValue("automatic");
    await expect(section.getByText(/Effort: none, low, medium, high, xhigh, max; default medium/))
      .toBeVisible();
    await section.getByLabel("Hosted web search").check();
    await section.getByLabel("Image generation (future workflows)").check();
    await expect(section.getByLabel(/^Reasoning effort field/))
      .toHaveValue("reasoning.effort");
    await expect(section.getByLabel(/^Reasoning mode field \(optional\)/))
      .toHaveValue("reasoning.mode");
    await expect(section.getByText(/Image support is recorded now but is not yet runnable/))
      .toBeVisible();
    await expect(section.getByText("https://llm.fixture.invalid/v1/responses"))
      .toBeVisible();
    await expectNoPageOverflow(page);

    await section.getByRole("button", { name: "Test & Save" }).click();
    await expect(section.getByText("Ready to chat", { exact: true })).toBeVisible();
    const ready = section.getByTestId("provider-custom-ready-summary");
    await expect(ready).toContainText("API key saved and verified.");
    await expect(ready).toContainText("assigned directly to this administrator");
    await expect(section.getByText(key)).toHaveCount(0);
    await expectNoPageOverflow(page);

    await section.getByRole("button", { name: "Add another provider" }).click();
    await expect(section.getByRole("button", { name: /Custom 1 configured/ })).toBeVisible();
  }

  expect(discovered).toHaveLength(2);
  for (const [index, body] of discovered.entries()) {
    expect(body).toEqual({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.fixture.invalid/v1",
      authenticationMode: "bearer",
      responseTimeoutSeconds: 300,
      secret: `e2e-custom-write-only-key-${index === 0 ? 1440 : 390}`
    });
  }
  expect(submitted).toHaveLength(2);
  for (const [index, body] of submitted.entries()) {
    expect(body).toMatchObject({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.fixture.invalid/v1",
      authenticationMode: "bearer",
      capabilities: expect.objectContaining({
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        nativeImageGeneration: true,
        nativeSearch: true,
        reasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"]
      }),
      confirmPaidRequest: true,
      modelIds: [
        `fixture/model-${index === 0 ? 1440 : 390}`,
        "fixture/alternate"
      ],
      protocol: "responses",
      reasoningRequestMapping: {
        effortPath: "reasoning.effort",
        modePath: "reasoning.mode"
      },
      responseTimeoutSeconds: 300,
      secret: `e2e-custom-write-only-key-${index === 0 ? 1440 : 390}`
    });
  }
});

test("administrator rotates a Custom provider key in one step and deletes the provider", async ({ page }) => {
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://lifecycle.fixture.invalid/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  const modelConfiguration: AdminProviderModelConfiguration = {
    adapterKind: "openai_responses_compatible",
    answerSelectable: true,
    capabilities: {
      nativeImageGeneration: true,
      nativePdfInput: false,
      nativeSearch: true,
      pdf: false,
      reasoning: false,
      streaming: true,
      vision: false
    },
    defaultParams: { background: false, store: false, stream: true },
    modelClass: "answer",
    upstreamModelId: "fixture/lifecycle-model"
  };
  let connection: AdminProviderConnection | null = {
    activatedAt: now,
    activeChecks: [{
      checkedAt: now,
      connectionVersion: 1,
      credentialId: "custom-lifecycle-credential",
      credentialVersionId: "custom-lifecycle-version-1",
      evidence: {
        detail: "ok",
        method: "models_catalog",
        selectedProviders: [],
        upstreamModelId: "fixture/lifecycle-model"
      },
      latestRefreshError: null,
      modelVersion: 1,
      providerModelId: "custom-lifecycle-model",
      refreshFailedAt: null,
      status: "available"
    }],
    activeConfig: connectionConfiguration,
    activeVersion: 1,
    assignments: [],
    createdAt: now,
    credentials: [{
      activatedAt: now,
      activeVersion: {
        activatedAt: now,
        id: "custom-lifecycle-version-1",
        revokedAt: null,
        testedAt: now,
        version: 1
      },
      createdAt: now,
      draftSecretConfigured: false,
      draftVersion: 1,
      enabled: true,
      id: "custom-lifecycle-credential",
      label: "Primary",
      testedAt: now,
      updatedAt: now
    }],
    defaultCredentialId: "custom-lifecycle-credential",
    displayName: "Lifecycle Custom",
    draftChecks: [],
    draftConfig: connectionConfiguration,
    draftVersion: 1,
    enabled: true,
    family: "openai_compatible",
    id: "custom-lifecycle",
    models: [{
      activatedAt: now,
      activeConfig: modelConfiguration,
      activeVersion: 1,
      connectionId: "custom-lifecycle",
      createdAt: now,
      displayName: "Lifecycle Model",
      draftConfig: modelConfiguration,
      draftVersion: 1,
      enabled: true,
      id: "custom-lifecycle-model",
      updatedAt: now
    }],
    unassignedPolicy: "use_default",
    updatedAt: now,
    userAssignments: []
  };
  const rotationBodies: Record<string, unknown>[] = [];
  const actionBodies: Record<string, unknown>[] = [];
  const deletionBodies: Record<string, unknown>[] = [];

  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON() as Record<string, unknown>;

    if (method === "GET" && path === "/api/admin/providers") {
      await route.fulfill({
        contentType: "application/json",
        json: { connections: connection ? [connection] : [] }
      });
      return;
    }
    if (method === "PATCH" && path === "/api/admin/providers/custom-lifecycle/credentials/custom-lifecycle-credential") {
      rotationBodies.push(body);
      if (!connection) throw new Error("Custom lifecycle fixture was already deleted");
      connection = {
        ...connection,
        activeChecks: [],
        credentials: connection.credentials.map((credential) => ({
          ...credential,
          activeVersion: {
            activatedAt: now,
            id: "custom-lifecycle-version-2",
            revokedAt: null,
            testedAt: now,
            version: 2
          },
          draftVersion: 2
        }))
      };
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers/custom-lifecycle/actions") {
      actionBodies.push(body);
      if (!connection) throw new Error("Custom lifecycle fixture was already deleted");
      if (body.action === "disable") connection = { ...connection, enabled: false };
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    if (method === "DELETE" && path === "/api/admin/providers/custom-lifecycle") {
      deletionBodies.push(body);
      connection = null;
      await route.fulfill({ contentType: "application/json", json: { connections: [] } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_custom_lifecycle_request", method, path },
      status: 400
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  const row = section.getByTestId("provider-row-custom-lifecycle");
  await expect(row).toContainText("Custom · lifecycle.fixture.invalid · Lifecycle Model");
  await expect(row).not.toContainText("/v1");
  await expect(row.getByTestId("provider-status")).toHaveText("Working");
  await row.click();
  await expect(page).toHaveURL(/section=providers&resource=custom-lifecycle/u);
  await expect(page.getByTestId("admin-topbar-title")).toContainText("Lifecycle Custom");
  await expect(section.getByTestId("provider-page-status")).toContainText("All keys working · 1 model on");

  const key = section.getByTestId("provider-key-custom-lifecycle-credential");
  await expect(key).toContainText("Default key");
  await key.getByRole("button", { name: "Rotate Primary" }).click();
  const form = section.getByTestId("provider-key-form");
  await form.getByLabel("New API key for Primary").fill("e2e-rotated-write-only-key");
  await form.getByRole("button", { name: "Test & Save" }).click();
  await expect(form).toHaveCount(0);
  expect(rotationBodies).toEqual([{
    action: "rotate",
    activate: true,
    expectedDraftVersion: 1,
    secret: "e2e-rotated-write-only-key"
  }]);
  await expect(section.getByText("e2e-rotated-write-only-key")).toHaveCount(0);
  await expect(key.getByTestId("provider-key-detail")).toContainText("Working");

  await page.getByRole("button", { name: "More actions for Lifecycle Custom" }).click();
  await page.getByRole("menuitem", { name: "Delete provider" }).click();
  const confirmation = page.getByTestId("admin-confirm-delete-provider-connection");
  await expect(confirmation).toContainText("turned off and removed with its keys, models, overrides and defaults");
  await confirmation.getByRole("button", { name: "Delete provider" }).click();
  await expect(section.getByText("No providers yet")).toBeVisible();
  await expect(page).not.toHaveURL(/resource=/u);
  expect(actionBodies).toEqual([{ action: "disable" }]);
  expect(deletionBodies).toEqual([{ confirmed: true }]);
});

test("administrator saves a rejected and then a working OpenRouter key with one Test & Save, and edits connection settings", async ({ page }) => {
  const configuration = {
    allowPrivateNetwork: false,
    apiRoot: "https://openrouter.ai/api/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  const modelConfiguration: AdminProviderModelConfiguration = {
    adapterKind: "openrouter_chat_completions",
    answerSelectable: true,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "answer",
    openRouterRouting: { mode: "automatic", providers: [] },
    upstreamModelId: "vendor/e2e-model"
  };
  let connection: AdminProviderConnection = {
    activatedAt: now,
    activeChecks: [],
    activeConfig: configuration,
    activeVersion: 1,
    assignments: [],
    createdAt: now,
    credentials: [],
    defaultCredentialId: null,
    displayName: "OpenRouter",
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    family: "openrouter",
    id: "provider-e2e",
    models: [{
      activatedAt: now,
      activeConfig: modelConfiguration,
      activeVersion: 1,
      connectionId: "provider-e2e",
      createdAt: now,
      displayName: "E2E Model",
      draftConfig: modelConfiguration,
      draftVersion: 1,
      enabled: true,
      id: "model-e2e",
      updatedAt: now
    }],
    unassignedPolicy: "use_default",
    updatedAt: now,
    userAssignments: []
  };
  const credentialBodies: Record<string, unknown>[] = [];
  const settingsBodies: Array<{ body: Record<string, unknown>; method: string; path: string }> = [];

  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON() as Record<string, unknown>;

    if (method === "GET" && path === "/api/admin/providers") {
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers/provider-e2e/credentials") {
      credentialBodies.push(body);
      if (body.secret === "e2e-rejected-key") {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "provider_credential_test_failed" },
          status: 422
        });
        return;
      }
      connection = {
        ...connection,
        credentials: [{
          activatedAt: now,
          activeVersion: {
            activatedAt: now,
            id: "credential-version-e2e",
            revokedAt: null,
            testedAt: now,
            version: 1
          },
          createdAt: now,
          draftSecretConfigured: false,
          draftVersion: 1,
          enabled: true,
          id: "credential-e2e",
          label: String(body.label),
          testedAt: now,
          updatedAt: now
        }],
        defaultCredentialId: "credential-e2e"
      };
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] }, status: 201 });
      return;
    }
    if (method === "PATCH" && path === "/api/admin/providers/provider-e2e") {
      settingsBodies.push({ body, method, path });
      connection = {
        ...connection,
        displayName: String(body.displayName),
        draftConfig: body.configuration as typeof configuration,
        draftVersion: connection.draftVersion + 1
      };
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers/provider-e2e/actions") {
      settingsBodies.push({ body, method, path });
      if (body.action === "activate") {
        connection = {
          ...connection,
          activeConfig: connection.draftConfig,
          activeVersion: connection.draftVersion
        };
      }
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_provider_e2e_request", method, path },
      status: 400
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  const row = section.getByTestId("provider-row-provider-e2e");
  await expect(row.getByTestId("provider-status")).toHaveText("Not checked");
  await row.click();
  await expect(section.getByTestId("provider-page-status")).toHaveText("No keys yet · 1 model on");

  await section.getByRole("button", { name: "Add key" }).click();
  const form = section.getByTestId("provider-key-form");
  await form.getByLabel("Label").fill("Primary");
  await form.getByLabel("API key").fill("e2e-rejected-key");
  await expect(form).toContainText("Sends one small request to the provider");
  await form.getByRole("button", { name: "Test & Save" }).click();
  await expect(form.getByRole("alert")).toHaveText("The provider rejected this key. Check the key and try again.");
  await expect(form.getByLabel("API key")).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByLabel("API key")).toHaveValue("e2e-rejected-key");
  await expect(section.getByTestId("provider-key-credential-e2e")).toHaveCount(0);
  await expect(section.getByTestId("provider-page-status")).toHaveText("No keys yet · 1 model on");

  const saveResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/credentials") &&
    response.status() === 201
  );
  await form.getByLabel("API key").fill("e2e-write-only-provider-key");
  await form.getByRole("button", { name: "Test & Save" }).click();
  const saveBody = await (await saveResponse).text();
  expect(saveBody).not.toContain("e2e-write-only-provider-key");
  expect(saveBody).not.toContain("secretEnvelope");
  expect(credentialBodies).toEqual([
    { activate: true, label: "Primary", secret: "e2e-rejected-key" },
    { activate: true, label: "Primary", secret: "e2e-write-only-provider-key" }
  ]);
  await expect(form).toHaveCount(0);
  const key = section.getByTestId("provider-key-credential-e2e");
  await expect(key).toContainText("Primary");
  await expect(key).toContainText("Default key");
  await expect(key.getByTestId("provider-key-detail")).toContainText("Working");
  await expect(section.getByTestId("provider-page-status")).toContainText("All keys working · 1 model on");
  await expect(section.getByText("e2e-write-only-provider-key")).toHaveCount(0);
  await expect(section.getByTestId("provider-default-key")).toHaveValue("credential-e2e");
  await expect(section).not.toContainText(/\bdraft\b|\brevision\b|\bpending\b|\bevidence\b|\bprobe\b|\badapter\b|\bfingerprint\b/iu);

  await section.getByRole("button", { name: "Connection settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Connection settings" });
  await expect(sheet.getByLabel("Name")).toHaveValue("OpenRouter");
  await expect(sheet.getByLabel(/^API key/)).toHaveCount(0);
  await page.setViewportSize({ height: 844, width: 390 });
  const timeout = sheet.getByLabel("Response timeout (seconds)");
  await timeout.scrollIntoViewIfNeeded();
  await expect(timeout).toBeInViewport();
  await expectNoPageOverflow(page);
  await timeout.fill("500");
  await page.setViewportSize({ height: 900, width: 1440 });
  await sheet.getByRole("button", { name: "Test & Save" }).click();
  await expect(sheet).toHaveCount(0);
  expect(settingsBodies.map(({ body, method }) => ({ action: body.action, method }))).toEqual([
    { action: undefined, method: "PATCH" },
    { action: "activate", method: "POST" }
  ]);
  expect(settingsBodies[0]?.body).toMatchObject({
    configuration: { responseTimeoutSeconds: 500 },
    expectedDraftVersion: 1
  });

  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 1024, width: 768 },
    { height: 844, width: 390 },
    { height: 390, width: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(section.getByTestId("provider-page")).toBeVisible();
    await expect(page.getByRole("switch", { name: "OpenRouter enabled" })).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers" }).click();
  await expect(section.getByRole("list", { name: "Providers" })).toBeVisible();
  await expect(page).not.toHaveURL(/resource=/u);
  await expect(row.getByTestId("provider-status")).toHaveText("Working");
  await expectNoPageOverflow(page);
});

test("administrator saves a versioned Search recommendation that grants no access", async ({ page }) => {
  let search: AdminSearchCatalog = {
    integrations: [{
      archivedAt: null,
      broaderModelSetup: "ready",
      configurable: true,
      configuration: {
        adapterKind: "provider_model_client",
        credentialMode: "provider_model",
        maxOutputTokens: adminSearchExecutionDefaults.maxOutputTokens,
        maxResults: 8,
        maxSearchCallsPerAnswer: adminSearchExecutionDefaults.maxSearchCallsPerAnswer,
        protocol: "openai_responses_web_search",
        providerModelId: "search-model-1",
        queryMaxCharacters: 500,
        reasoningPolicy: adminSearchExecutionDefaults.reasoningPolicy,
        timeoutMs: 300_000
      },
      configurationActive: true,
      description: "Query-only web evidence",
      displayName: "Company Search",
      draftDirty: false,
      draftTestEvidence: {
        checkedAt: now,
        method: "provider_search",
        normalizedSourceCount: 2,
        protocol: "openai_responses_web_search",
        status: "available"
      },
      draftVersion: 1,
      enabled: true,
      executionModes: ["all_selected", "model_choice"],
      id: "search-source-1",
      kind: "web_search",
      providerModel: {
        connectionDisplayName: "Compatible gateway",
        connectionId: "search-connection-1",
        displayName: "Search model",
        id: "search-model-1"
      },
      ready: true,
      readiness: "ready",
      sourceConnectionId: "search-connection-1",
      strategyId: "company-search-12345678",
      system: false
    }],
    policy: {
      defaultPlan: { mode: "all_selected", optionIds: [] },
      updatedAt: now,
      version: 4
    },
    providerModels: [{
      connectionDisplayName: "Compatible gateway",
      connectionId: "search-connection-1",
      displayName: "Search model",
      enabled: true,
      id: "search-model-1",
      searchKind: "web_search",
      searchReasoningSupported: true
    }]
  };
  let submitted: Record<string, unknown> | null = null;

  await page.route("**/api/admin/search", async (route) => {
    if (route.request().method() === "PATCH") {
      submitted = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      search = {
        ...search,
        policy: {
          defaultPlan: submitted.defaultPlan as AdminSearchCatalog["policy"]["defaultPlan"],
          updatedAt: now,
          version: 5
        }
      };
    }
    await route.fulfill({ contentType: "application/json", json: { search } });
  });

  await page.setViewportSize({ height: 800, width: 1280 });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=search");
  const section = page.getByTestId("admin-search-section");
  const policy = section.getByRole("region", { name: "Recommended Search plan" });
  await expect(policy).toContainText("This recommendation never grants access.");
  await expect(section.getByText("Select or add a Search source.")).toBeVisible();
  await expect(section).not.toContainText(/native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical/iu);
  await policy.getByRole("button", { name: "Company Search" }).click();
  await policy.getByRole("button", { name: "Save default" }).click();

  await expect(section.getByText("Organization Search default saved.")).toBeVisible();
  expect(submitted).toEqual({
    defaultPlan: {
      mode: "all_selected",
      optionIds: ["company-search-12345678"]
    },
    expectedVersion: 4
  });
  await expect(policy.getByRole("button", { name: "Save default" })).toBeDisabled();

  await page.setViewportSize({ height: 768, width: 1024 });
  const sourceQuery = section.getByRole("searchbox", { name: "Search sources" });
  await sourceQuery.fill("Company");
  const sourceCatalog = section.getByRole("list", { name: "Search source catalog" });
  const sourceButton = sourceCatalog.getByRole("button", { name: /Company Search/i });
  await sourceButton.focus();
  await sourceButton.press("Enter");
  const backToSearch = section.getByRole("button", { name: "Back to Search" });
  await expect(backToSearch).toBeFocused();
  await backToSearch.press("Enter");
  await expect(sourceButton).toBeFocused();
  await expect(sourceQuery).toHaveValue("Company");
  await sourceButton.press("Enter");

  for (const viewport of [
    { height: 768, width: 1024 },
    { height: 500, width: 1280 },
    { height: 900, width: 1440 }
  ]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    await expectReadableDetail(page, section.getByTestId("admin-search-detail-pane"));
  }

  await section.getByRole("tab", { name: "Configuration" }).click();
  await expect(section.getByLabel(/^Search model/)).not.toBeVisible();
  await section.getByText("Advanced Search execution").click();
  await expect(section.getByLabel(/^Search model/)).toHaveValue("search-model-1");
  await expect(section.getByRole("spinbutton", {
    name: /^Maximum Search output, tokens/
  })).toHaveValue(String(adminSearchExecutionDefaults.maxOutputTokens));
  await expect(section.getByRole("spinbutton", {
    name: /^Maximum requests to this source per answer/
  })).toHaveValue(String(adminSearchExecutionDefaults.maxSearchCallsPerAnswer));
  await expect(section.getByRole("combobox", { name: /^Search reasoning/ }))
    .toHaveValue(adminSearchExecutionDefaults.reasoningPolicy);
  await expect(section).not.toContainText(
    /native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical/iu
  );
});

test("ordinary user receives real provider-admin denial without provider metadata", async ({ page }) => {
  await signInOrdinaryUser(page);

  const [catalog, customPost, mutation, quickGet, quickPost] = await Promise.all([
    page.request.get("/api/admin/providers"),
    page.request.post("/api/admin/providers/custom-setup", {
      data: {
        allowPrivateNetwork: false,
        apiRoot: "https://not-visible.invalid/v1",
        authenticationMode: "bearer",
        confirmPaidRequest: true,
        modelId: "not-visible",
        secret: "write-only-test-key"
      }
    }),
    page.request.post("/api/admin/providers/not-visible/actions", {
      data: {
        action: "discover_models",
        credentialId: "not-visible"
      }
    }),
    page.request.get("/api/admin/providers/quick-setup"),
    page.request.post("/api/admin/providers/quick-setup", {
      data: {
        expectedState: "opaque-state",
        provider: "openai",
        secret: "write-only-test-key"
      }
    })
  ]);
  for (const response of [catalog, customPost, mutation, quickGet, quickPost]) {
    expect(response.status()).toBe(403);
    const text = await response.text();
    expect(text).toBe('{"error":"forbidden"}');
    expect(text).not.toMatch(/apiRoot|credential|model|openrouter|providerModelId|secret/iu);
  }

  await page.goto("/admin");
  const denied = page.getByTestId("admin-denied");
  await expect(denied).toContainText("Admin access required");
  await expect(denied).toContainText("Control Center");
  const deniedBox = await denied.boundingBox();
  const viewport = page.viewportSize();
  expect(deniedBox).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(Math.abs(deniedBox!.y + deniedBox!.height / 2 - viewport!.height / 2)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("link", { name: "Providers" })).toHaveCount(0);
});
