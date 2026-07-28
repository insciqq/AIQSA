import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection,
  AdminProviderDraftCheck,
  AdminProviderModelConfiguration
} from "../../lib/contracts/adminProviders";
import type { AdminRunProfileCatalog } from "../../lib/contracts/runProfiles";
import { adminProviderQuickSetupPolicy } from "../../lib/server/admin/providers/quickSetupPolicy";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { parseSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
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
  priorDeepProfile: {
    enabled: boolean;
    providerModelId: string | null;
    reasoningEffort: string;
    reasoningMode: string;
    updatedByUserId: string | null;
    version: number;
  };
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
    modelId: string;
    provider: string;
    status: string;
  };
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
  const connectionConfig = { allowPrivateNetwork: true, apiRoot };
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
    const [settings, deepProfile] = await Promise.all([
      tx.userSettings.findUniqueOrThrow({
        select: { defaultControlValues: true, defaultProviderModelId: true },
        where: { userId: fixture.userId }
      }),
      tx.runProfile.findUniqueOrThrow({
        select: {
          enabled: true,
          providerModelId: true,
          reasoningEffort: true,
          reasoningMode: true,
          updatedByUserId: true,
          version: true
        },
        where: { id: "deep" }
      })
    ]);
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
        contextWindow: candidate.model.contextWindow,
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
            searchStrategyId: "search-disabled",
            streamMode: true
          }
        }),
        defaultProviderModelId: fixture.modelId
      },
      where: { userId: fixture.userId }
    });
    await tx.runProfile.update({
      data: {
        enabled: true,
        providerModelId: fixture.modelId,
        reasoningEffort: "max",
        reasoningMode: "pro",
        updatedByUserId: fixture.userId,
        version: { increment: 1 }
      },
      where: { id: "deep" }
    });

    return { deepProfile, settings };
  });

  return {
    ...fixture,
    priorDeepProfile: priorState.deepProfile,
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
    await tx.runProfile.update({
      data: fixture.priorDeepProfile,
      where: { id: "deep" }
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

const discoveredModels: AdminOpenRouterDiscoveredModel[] = [
  ...Array.from({ length: 332 }, (_, offset) => {
    const index = 332 - offset;
    const suffix = String(index).padStart(3, "0");
    return {
      contextLength: 32_000,
      id: `catalog/model-${suffix}`,
      inputModalities: ["text"],
      name: `Catalog Model ${suffix}`,
      outputModalities: ["text"],
      pricing: { prompt: "0.000001" },
      supportedParameters: ["tools"]
    };
  }),
  {
    contextLength: 128_000,
    id: "vendor/e2e-model",
    inputModalities: ["text", "image"],
    name: "E2E Model",
    outputModalities: ["text"],
    pricing: { prompt: "0.000001" },
    supportedParameters: ["tools", "reasoning"]
  }
];

const discoveredEndpoints: AdminOpenRouterDiscoveredEndpoint[] = [
  {
    name: "Zenith endpoint",
    providerName: "Zenith AI",
    supportedParameters: ["tools"],
    tag: "zenith"
  },
  {
    name: "Primary endpoint",
    providerName: "Acme Inference",
    quantization: "fp8",
    supportedParameters: ["tools", "reasoning"],
    tag: "acme-primary"
  },
  {
    name: "Backup endpoint",
    providerName: "Acme Inference",
    quantization: "int8",
    supportedParameters: ["tools"],
    tag: "acme-backup"
  }
];

function connectionDraft(configuration: {
  allowPrivateNetwork: boolean;
  apiRoot: string;
}, displayName: string): AdminProviderConnection {
  return {
    activatedAt: null,
    activeChecks: [],
    activeConfig: null,
    activeVersion: 0,
    assignments: [],
    createdAt: now,
    credentials: [],
    defaultCredentialId: null,
    displayName,
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: false,
    family: "openrouter",
    id: "provider-e2e",
    models: [],
    unassignedPolicy: "use_default",
    updatedAt: now
  };
}

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

test("administrator completes the Quick direct-user picker, retry, Ready, and safe replacement journey", async ({ page }) => {
  const upstream = await startLocalResponsesServer();
  const fixtureState: { current: QuickChatFixture | null } = { current: null };
  const trackedChatIds: string[] = [];
  const trackedRunIds: string[] = [];
  let configured = false;
  const quickRequests: Array<{ body: Record<string, unknown>; method: string }> = [];
  const undisclosedResourceRequests: string[] = [];
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
    if (path === "/api/admin/providers" || path === "/api/admin/run-profiles") {
      undisclosedResourceRequests.push(`${request.method()} ${path}`);
    }
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
          defaultChanged: true,
          model: { displayName: "GPT-5.6 Sol" },
          models: [
            { displayName: "GPT-5.6 Terra" },
            { displayName: "GPT-5.6 Luna" },
            { displayName: "GPT-5.6 Sol" }
          ],
          outcome: "ready",
          profilesFilled: ["deep"],
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
  await page.goto("/admin");
  const section = page.getByTestId("admin-section-providers");
  await expect(section.getByRole("heading", { exact: true, name: "Providers" }).last()).toBeVisible();
  await expect(section.getByLabel("API key")).toHaveCount(0);
  await expect(section.getByRole("tab", { name: "Quick setup" })).toHaveAttribute("aria-selected", "true");
  await expect(section.getByTestId("provider-connections-workspace")).toHaveCount(0);

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
  await expect(section.getByLabel("API key")).toHaveValue("e2e-quick-write-only-key");
  await section.getByLabel("GPT-5.6 Sol").click();
  await section.getByRole("button", { name: "Use selected model & save" }).click();
  await expect(section.getByRole("button", { name: "Testing & saving…" })).toBeVisible();
  await expect(section.getByLabel("API key")).toBeDisabled();
  await expect(section.getByLabel("GPT-5.6 Luna")).toBeDisabled();
  await expect(section.getByLabel("GPT-5.6 Sol")).toBeDisabled();
  await expectNoPageOverflow(page);
  releasePickerRetry();
  await expect(section.getByText(
    "The provider rejected the key or its account catalog could not be reached."
  )).toBeVisible();
  await expect(section.getByLabel("API key")).toHaveValue("e2e-quick-write-only-key");
  await section.getByRole("button", { name: "Use selected model & save" }).click();
  await expect(section.getByText("Ready to chat")).toBeVisible();
  await expect(section.getByRole("heading", { name: "GPT-5.6 Sol" })).toBeVisible();
  const readyReceipt = section.getByTestId("provider-quick-ready-receipt");
  await expect(readyReceipt).toContainText("API key: saved and verified.");
  await expect(readyReceipt).toContainText("Default model: GPT-5.6 Sol.");
  await expect(readyReceipt).toContainText(
    "Available models: GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.6 Sol."
  );
  await expect(readyReceipt).toContainText("Access: available to this administrator.");
  await expect(readyReceipt).toContainText("Default selection: updated.");
  await expect(readyReceipt).toContainText("Run profiles filled: Deep.");
  await expect(section.getByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
  await expect(section.getByText("e2e-quick-write-only-key")).toHaveCount(0);

  await expect(section.getByRole("button", { name: /OpenAI Ready/ })).toBeVisible();
  await section.getByRole("button", { name: "Replace API key" }).click();
  await expect(section.getByLabel("API key")).toHaveValue("");
  await section.getByLabel("API key").fill("e2e-failing-replacement-key");
  await section.getByRole("button", { name: "Test & Save" }).click();
  await expect(section.getByRole("button", { name: "Testing & saving…" })).toBeVisible();
  await expect(section.getByText("Ready to chat")).toBeVisible();
  await expect(section.getByLabel("API key")).toBeDisabled();
  await expectNoPageOverflow(page);
  releaseReplacement();
  await expect(section.getByText(
    "The provider rejected the key or its account catalog could not be reached."
  )).toBeVisible();
  await expect(section.getByText("Ready to chat")).toBeVisible();
  await expect(section.getByLabel("API key")).toHaveValue("e2e-failing-replacement-key");
  await section.getByRole("button", { name: "Cancel replacement" }).click();
  await section.getByRole("button", { name: "Replace API key" }).click();
  await expect(section.getByLabel("API key")).toHaveValue("");
  await section.getByRole("button", { name: "Cancel replacement" }).click();

  expect(undisclosedResourceRequests).toEqual([]);
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
    await expect(section.getByRole("tab", { name: "Quick setup" })).toBeVisible();
    await expect(section.getByRole("tab", { name: "Connections" })).toBeVisible();
    await expect(section.getByRole("tab", { name: "Run profiles" })).toBeVisible();
    await expect
      .poll(() => section.getByTestId("provider-workspace-tabs").evaluate((element) =>
        getComputedStyle(element).scrollbarWidth
      ))
      .toBe("none");
    await expectNoPageOverflow(page);
    const columns = await section.getByTestId("provider-quick-choice-strip").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length
    );
    expect(columns).toBe(viewport.width < 640 ? 2 : viewport.width < 1024 ? 3 : 5);
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
  const catalogBody = await realCatalogResponse.json() as QuickCatalogBody;
  expect(catalogBody.catalog.defaults).toMatchObject({
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
  await expect(page.getByTestId("run-model-summary")).toHaveText("GPT-5.6 Sol");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeEnabled();
  const question = `First question after Quick setup ${randomUUID()}`;
  await composer.fill(question);
  const messageResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname)
  );
  await page.getByRole("button", { name: "Send message" }).click();
  expect((await messageResponse).ok()).toBe(true);
  const chatId = await waitForActiveChatId(page);
  trackedChatIds.push(chatId);
  await expect.poll(() => messageRequests.length).toBe(1);
  expect(messageRequests[0]).toMatchObject({
    modelId: installedFixture.modelId,
    provider: installedFixture.connectionId,
    searchStrategy: "search-disabled"
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
  await expect(page.getByTestId("thread")).toContainText(question);
  await expect(page.getByTestId("thread")).toContainText(quickAnswer, { timeout: 20_000 });
  await expect(page.getByTestId("streaming-cursor")).toHaveCount(0, { timeout: 20_000 });

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
  await expect(prisma.modelRun.findUnique({
    select: {
      assistantMessage: {
        select: { content: true, groundedAt: true }
      },
      finalProviderResponsePreview: true
    },
    where: { id: runId }
  })).resolves.toMatchObject({
    assistantMessage: {
      content: { blocks: [{ text: quickAnswer, type: "text" }] },
      groundedAt: null
    },
    finalProviderResponsePreview: { text: quickAnswer }
  });
  expect(JSON.stringify(assistantMessage?.content)).toContain(quickAnswer);

  const runResponse = await page.request.get(`/api/model-runs/${runId}`);
  expect(runResponse.ok()).toBe(true);
  const runBody = await runResponse.json() as QuickRunBody;
  expect(runBody.run).toMatchObject({
    id: runId,
    modelId: "gpt-5.6-sol",
    provider: "openai",
    status: "complete"
  });
  await expect(prisma.providerRunBinding.findUnique({
    select: {
      connectionId: true,
      credentialSource: true,
      credentialId: true,
      credentialVersionId: true,
      providerModelId: true
    },
    where: { modelRunId_role: { modelRunId: runId, role: "answer" } }
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
      await upstream.close();
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
        providers: [
          { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openai" },
          { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
          { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
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
        providerModelId: readyModels[0]?.providerModelId ?? `custom-model-${receipt}`
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
        models: [{ id: modelId }, { id: "fixture/alternate" }],
        source: "models_catalog",
        status: "valid"
      }
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin");
  const section = page.getByTestId("admin-section-providers");

  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 844, width: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(section.getByRole("tab", { name: "Quick setup" })).toBeVisible();
    await expect(section.getByRole("tab", { name: "Connections" })).toBeVisible();
    await expect(section.getByRole("tab", { name: "Run profiles" })).toBeVisible();
    await expect(section.getByTestId("provider-quick-choice-strip").getByRole("button"))
      .toHaveCount(5);
    await section.getByRole("button", { name: "Custom OpenAI-compatible" }).click();
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
    await section.getByLabel("Hosted web search").check();
    await section.getByLabel("Image generation (future workflows)").check();
    await expect(section.getByText(/Image support is recorded now but is not yet runnable/))
      .toBeVisible();
    await expect(section.getByText("https://llm.fixture.invalid/v1/responses"))
      .toBeVisible();
    await expectNoPageOverflow(page);

    await section.getByRole("button", { name: "Test & Save" }).click();
    await expect(section.getByText("Ready to chat", { exact: true })).toBeVisible();
    const ready = section.getByTestId("provider-custom-ready-receipt");
    await expect(ready).toContainText("API key saved and verified.");
    await expect(ready).toContainText("assigned directly to this administrator");
    await expect(section.getByText(key)).toHaveCount(0);
    await expectNoPageOverflow(page);

    await section.getByRole("button", { name: "Add another provider" }).click();
    await expect(section.getByRole("button", { name: "Custom OpenAI-compatible" })).toBeVisible();
  }

  expect(discovered).toHaveLength(2);
  for (const [index, body] of discovered.entries()) {
    expect(body).toEqual({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.fixture.invalid/v1",
      authenticationMode: "bearer",
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
        nativeImageGeneration: true,
        nativeSearch: true
      }),
      confirmPaidRequest: true,
      modelIds: [
        `fixture/model-${index === 0 ? 1440 : 390}`,
        "fixture/alternate"
      ],
      protocol: "responses",
      secret: `e2e-custom-write-only-key-${index === 0 ? 1440 : 390}`
    });
  }
});

test("administrator activates a Custom replacement and deletes its complete configuration", async ({ page }) => {
  const connectionConfiguration = {
    allowPrivateNetwork: false,
    apiRoot: "https://lifecycle.fixture.invalid/v1",
    authenticationMode: "bearer" as const
  };
  const modelConfiguration: AdminProviderModelConfiguration = {
    adapterKind: "openai_responses_compatible",
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
      draftSecretConfigured: true,
      draftVersion: 2,
      enabled: true,
      id: "custom-lifecycle-credential",
      label: "Primary",
      testedAt: now,
      updatedAt: now
    }],
    defaultCredentialId: null,
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
    unassignedPolicy: "require_assignment",
    updatedAt: now,
    userAssignments: [{
      connectionId: "custom-lifecycle",
      credentialId: "custom-lifecycle-credential",
      updatedAt: now,
      user: {
        displayName: "Administrator",
        email: "admin@example.test",
        id: DEFAULT_BOOTSTRAP_USER_ID,
        status: "active"
      }
    }]
  };
  const activationBodies: Record<string, unknown>[] = [];
  const compatibleDiscoveryBodies: Record<string, unknown>[] = [];
  const deletionBodies: Record<string, unknown>[] = [];

  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON() as Record<string, unknown>;

    if (method === "GET" && path === "/api/admin/providers/quick-setup") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          providers: [
            { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openai" },
            { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
            { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
            { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openrouter" }
          ],
          suggestedProvider: null
        }
      });
      return;
    }
    if (method === "GET" && path === "/api/admin/providers") {
      await route.fulfill({
        contentType: "application/json",
        json: { connections: connection ? [connection] : [] }
      });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers/custom-lifecycle/actions") {
      if (body.action === "discover_compatible_models") {
        compatibleDiscoveryBodies.push(body);
        await route.fulfill({
          contentType: "application/json",
          json: {
            models: [
              { id: "fixture/lifecycle-model" },
              { id: "fixture/second-model" }
            ]
          }
        });
        return;
      }
      activationBodies.push(body);
      if (!connection) throw new Error("Custom lifecycle fixture was already deleted");
      connection = {
        ...connection,
        activeChecks: connection.activeChecks.map((check) => ({
          ...check,
          credentialVersionId: "custom-lifecycle-version-2"
        })),
        credentials: connection.credentials.map((credential) => ({
          ...credential,
          activeVersion: {
            activatedAt: now,
            id: "custom-lifecycle-version-2",
            revokedAt: null,
            testedAt: now,
            version: 2
          },
          draftSecretConfigured: false
        }))
      };
      await route.fulfill({
        contentType: "application/json",
        json: { connections: [connection] }
      });
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
  await page.goto("/admin");
  const section = page.getByTestId("admin-section-providers");
  await section.getByRole("tab", { name: "Connections" }).click();
  await section.getByTestId("provider-connection-index")
    .getByRole("button", { name: /Lifecycle Custom/ }).click();
  await section.getByRole("tab", { name: "Models" }).click();
  await section.getByTestId("provider-task-models")
    .getByRole("button", { name: "Add model" }).click();
  await expect.poll(() => compatibleDiscoveryBodies.length).toBe(1);
  await section.getByRole("button", { name: "Endpoint model" }).click();
  await section.getByRole("option", { name: /fixture\/second-model/ }).click();
  await expect(section.getByRole("textbox", { name: "Upstream model ID" }))
    .toHaveValue("fixture/second-model");
  expect(compatibleDiscoveryBodies).toEqual([{
    action: "discover_compatible_models",
    credentialId: "custom-lifecycle-credential"
  }]);
  await section.getByRole("tab", { name: "Credentials" }).click();
  await expect(section.getByText("Replacement pending", { exact: true })).toBeVisible();
  await section.getByRole("button", {
    name: "Activate replacement for Primary credential"
  }).click();
  await expect(section.getByText("Replacement key activated for new runs.")).toBeVisible();
  await expect(section.getByRole("button", {
    name: "Activate replacement for Primary credential"
  })).toHaveCount(0);
  expect(activationBodies).toEqual([{
    action: "activate",
    confirmUnavailable: false,
    enableConnection: true
  }]);

  await section.getByLabel("More actions for Lifecycle Custom connection").click();
  await section.getByRole("button", { name: "Delete Lifecycle Custom connection" }).click();
  const confirmation = page.getByTestId("admin-confirm-delete-provider-connection");
  await expect(confirmation).toContainText("encrypted credentials, assignments, model grants, and model defaults");
  await confirmation.getByRole("button", { name: "Delete connection and configuration" }).click();
  await expect(section.getByText("No provider connections")).toBeVisible();
  expect(deletionBodies).toEqual([{ confirmed: true }]);
});

test("administrator completes the OpenRouter key, model, route, check, and activation flow", async ({ page }) => {
  let connections: AdminProviderConnection[] = [];
  const discoveryActions: Array<Record<string, unknown>> = [];
  let activationBody: Record<string, unknown> | null = null;
  let submittedModelBody: Record<string, unknown> | null = null;
  let submittedKey: string | null = null;
  let testedKey: string | null = null;

  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON() as Record<string, unknown>;

    if (method === "GET" && path === "/api/admin/providers/quick-setup") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          providers: [
            { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openai" },
            { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
            { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
            { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openrouter" }
          ],
          suggestedProvider: null
        }
      });
      return;
    }
    if (method === "GET" && path === "/api/admin/providers") {
      await route.fulfill({ contentType: "application/json", json: { connections } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers") {
      const configuration = body.configuration as { allowPrivateNetwork: boolean; apiRoot: string };
      connections = [connectionDraft(configuration, String(body.displayName))];
      await route.fulfill({ contentType: "application/json", json: { connections }, status: 201 });
      return;
    }
    if (method === "POST" && path.endsWith("/credential-tests")) {
      testedKey = String(body.secret);
      await route.fulfill({
        contentType: "application/json",
        json: {
          test: {
            checkedAt: now,
            connectionDraftVersion: Number(body.expectedConnectionDraftVersion),
            modelCount: discoveredModels.length,
            status: "valid"
          }
        }
      });
      return;
    }
    if (method === "POST" && path.endsWith("/credentials")) {
      submittedKey = String(body.secret);
      const current = connections[0]!;
      connections = [{
        ...current,
        credentials: [{
          activatedAt: null,
          activeVersion: null,
          createdAt: now,
          draftSecretConfigured: true,
          draftVersion: 1,
          enabled: true,
          id: "credential-e2e",
          label: String(body.label),
          testedAt: null,
          updatedAt: now
        }]
      }];
      await route.fulfill({ contentType: "application/json", json: { connections }, status: 201 });
      return;
    }
    if (method === "POST" && path.endsWith("/actions")) {
      const action = String(body.action);
      if (action === "discover_models") {
        discoveryActions.push(body);
        await route.fulfill({
          contentType: "application/json",
          json: { models: discoveredModels }
        });
        return;
      }
      if (action === "discover_endpoints") {
        discoveryActions.push(body);
        await route.fulfill({
          contentType: "application/json",
          json: { endpoints: discoveredEndpoints }
        });
        return;
      }
      if (action === "set_default_credential") {
        connections = [{ ...connections[0]!, defaultCredentialId: String(body.credentialId) }];
        await route.fulfill({ contentType: "application/json", json: { connections } });
        return;
      }
      if (action === "activate") {
        activationBody = body;
        const current = connections[0]!;
        const credential = current.credentials[0]!;
        const model = current.models[0]!;
        connections = [{
          ...current,
          activatedAt: now,
          activeChecks: current.draftChecks.map((check) => ({
            checkedAt: check.checkedAt,
            connectionVersion: current.draftVersion,
            credentialId: credential.id,
            credentialVersionId: "credential-version-e2e",
            evidence: check.evidence,
            latestRefreshError: null,
            modelVersion: model.draftVersion,
            providerModelId: model.id,
            refreshFailedAt: null,
            status: check.status
          })),
          activeConfig: current.draftConfig,
          activeVersion: current.draftVersion,
          credentials: [{
            ...credential,
            activatedAt: now,
            activeVersion: {
              activatedAt: now,
              id: "credential-version-e2e",
              revokedAt: null,
              testedAt: now,
              version: 1
            },
            draftSecretConfigured: false
          }],
          enabled: true,
          models: [{
            ...model,
            activatedAt: now,
            activeConfig: model.draftConfig,
            activeVersion: model.draftVersion
          }]
        }];
        await route.fulfill({ contentType: "application/json", json: { connections } });
        return;
      }
    }
    if (method === "POST" && path.endsWith("/models")) {
      submittedModelBody = body;
      const current = connections[0]!;
      connections = [{
        ...current,
        models: [{
          activatedAt: null,
          activeConfig: null,
          activeVersion: 0,
          connectionId: current.id,
          createdAt: now,
          displayName: String(body.displayName),
          draftConfig: body.configuration as AdminProviderModelConfiguration,
          draftVersion: 1,
          enabled: true,
          id: "model-e2e",
          updatedAt: now
        }]
      }];
      await route.fulfill({ contentType: "application/json", json: { connections }, status: 201 });
      return;
    }
    if (method === "PATCH" && path.endsWith("/models/model-e2e")) {
      const enabled = body.action === "enable";
      const current = connections[0]!;
      connections = [{
        ...current,
        models: current.models.map((candidate) => candidate.id === "model-e2e"
          ? { ...candidate, enabled }
          : candidate)
      }];
      await route.fulfill({ contentType: "application/json", json: { connections } });
      return;
    }
    if (method === "POST" && path.endsWith("/tests")) {
      const current = connections[0]!;
      const check: AdminProviderDraftCheck = {
        checkedAt: now,
        connectionDraftVersion: current.draftVersion,
        credentialDraftVersion: current.credentials[0]!.draftVersion,
        credentialId: "credential-e2e",
        credentialVersionId: null,
        evidence: {
          detail: "ok",
          method: "openrouter_account_catalog",
          selectedProviders: ["acme-primary", "acme-backup"],
          upstreamModelId: "vendor/e2e-model"
        },
        fingerprint: "provider-e2e-check",
        modelDraftVersion: 1,
        providerModelId: "model-e2e",
        status: "available"
      };
      connections = [{ ...current, draftChecks: [check] }];
      await route.fulfill({ contentType: "application/json", json: { check } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_provider_e2e_request", method, path },
      status: 400
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin");
  const section = page.getByTestId("admin-section-providers");
  await expect(section.getByRole("heading", { exact: true, name: "Providers" })).toBeVisible();
  await section.getByRole("button", { name: /OpenRouter Not configured/ }).click();
  await section.getByRole("button", { name: "Manage OpenRouter connection" }).click();
  const connectionsWorkspace = section.getByTestId("provider-connections-workspace");
  await expect(connectionsWorkspace).toBeVisible();

  const connectionIndex = section.getByTestId("provider-connection-index");
  await expect(connectionIndex).toBeVisible();
  await connectionIndex.getByRole("button", { name: "New" }).click();
  await expect(section.getByRole("heading", { name: "New provider connection" })).toBeVisible();
  await expect(section.getByLabel("Provider family")).toHaveValue("openrouter");
  await section.getByLabel("Display name").fill("E2E OpenRouter");
  await section.getByRole("button", { name: "Save connection" }).click();
  await expect(connectionIndex).toBeVisible();
  await connectionIndex.getByRole("button", { name: /E2E OpenRouter/ }).click();
  await expect(section.getByRole("heading", { name: "E2E OpenRouter" })).toBeVisible();
  const activationReadiness = section.getByTestId("provider-activation-readiness");
  await expect(activationReadiness).toHaveAttribute("data-readiness-tone", "setup");
  await expect(activationReadiness.getByRole("heading", {
    name: "Complete setup before activation."
  })).toBeVisible();

  await connectionsWorkspace.getByLabel("API key").fill("e2e-write-only-provider-key");
  await expect(section.getByRole("button", { name: "Save key" })).toBeDisabled();
  const credentialTestResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/credential-tests")
  );
  await section.getByRole("button", { name: "Test new key" }).click();
  const safeTestBody = await (await credentialTestResponse).text();
  expect(JSON.parse(safeTestBody)).toEqual({
    test: {
      checkedAt: now,
      connectionDraftVersion: 1,
      modelCount: discoveredModels.length,
      status: "valid"
    }
  });
  expect(safeTestBody).not.toContain("e2e-write-only-provider-key");
  expect(testedKey).toBe("e2e-write-only-provider-key");
  expect(submittedKey).toBeNull();
  await expect(section.getByText(`Key accepted. The account catalog exposes ${discoveredModels.length} models.`)).toBeVisible();
  await expect(section.getByRole("button", { name: "Save key" })).toBeEnabled();
  await section.getByRole("button", { name: "Save key" }).click();
  await expect(connectionsWorkspace.getByLabel("API key")).toHaveCount(0);
  await section.getByRole("button", { name: "Add key" }).click();
  await expect(connectionsWorkspace.getByLabel("API key")).toHaveValue("");
  await section.getByRole("button", { name: "Close key form" }).click();
  expect(submittedKey).toBe("e2e-write-only-provider-key");
  await expect(section.getByText("e2e-write-only-provider-key")).toHaveCount(0);

  await section.getByRole("tab", { name: "Models" }).click();
  const modelWorkflow = section.getByTestId("provider-task-models");
  const modelCatalogResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/actions") &&
      (request.postDataJSON() as Record<string, unknown>).action === "discover_models";
  });
  await modelWorkflow.getByRole("button", { exact: true, name: "Add model" }).click();
  await modelCatalogResponse;
  expect(discoveryActions).toEqual([{
    action: "discover_models",
    credentialId: "credential-e2e"
  }]);

  const modelPicker = section.getByRole("button", { name: "OpenRouter model" });
  await expect(modelPicker).toContainText("Choose a model");
  await modelPicker.click();
  const modelListbox = section.getByRole("listbox", { name: "OpenRouter model" });
  await expect(section.getByText(`${discoveredModels.length} models`, { exact: true })).toBeVisible();
  await expect(modelListbox.getByRole("option").first()).toContainText("Catalog Model 001");

  await section.getByRole("combobox", { name: "Search models" }).fill("vendor reasoning");
  await expect(section.getByText(`1 of ${discoveredModels.length} models`, { exact: true })).toBeVisible();
  await modelListbox.getByRole("option", { name: /E2E Model/ }).click();
  await expect(modelPicker).toContainText("E2E Model");
  await expect(section.getByText("128,000 context tokens · tools, reasoning")).toBeVisible();

  const endpointCatalogResponse = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/actions") &&
      (request.postDataJSON() as Record<string, unknown>).action === "discover_endpoints";
  });
  await section.getByLabel("Only selected providers").check();
  await endpointCatalogResponse;
  expect(discoveryActions).toEqual([
    { action: "discover_models", credentialId: "credential-e2e" },
    {
      action: "discover_endpoints",
      credentialId: "credential-e2e",
      modelId: "vendor/e2e-model"
    }
  ]);

  await section.getByRole("button", { name: "Add route Acme Inference (acme-backup)" }).click();
  await section.getByRole("button", { name: "Add route Acme Inference (acme-primary)" }).click();
  const routePriority = section.getByRole("list", { name: "Selected provider route priority" });
  await routePriority.getByRole("button", { name: "Move acme-primary up" }).click();
  await expect(routePriority.getByRole("listitem").nth(0)).toContainText("acme-primary");
  await expect(routePriority.getByRole("listitem").nth(1)).toContainText("acme-backup");

  await section.getByRole("button", { exact: true, name: "Save model" }).click();
  await expect(section.getByRole("list", { name: "Configured models" }).getByText("E2E Model", { exact: true })).toBeVisible();
  expect(submittedModelBody).toMatchObject({
    configuration: {
      adapterKind: "openrouter_chat_completions",
      openRouterRouting: {
        mode: "only_selected",
        providers: ["acme-primary", "acme-backup"]
      },
      upstreamModelId: "vendor/e2e-model"
    },
    displayName: "E2E Model"
  });

  const configuredModels = section.getByRole("list", { name: "Configured models" });
  const modelRow = configuredModels.getByRole("listitem").filter({ hasText: "E2E Model" });
  await expect(modelRow.getByText("Enabled", { exact: true })).toBeVisible();
  await modelRow.getByRole("button", { name: "Disable E2E Model model" }).click();
  await expect(modelRow.getByText("Disabled", { exact: true })).toBeVisible();
  const enableModel = modelRow.getByRole("button", { name: "Enable E2E Model model" });
  await expect(enableModel).toHaveClass(/text-proof/u);
  await expectFullyHitTestable(enableModel);
  await enableModel.click();
  await expect(modelRow.getByText("Enabled", { exact: true })).toBeVisible();

  const modelMore = section.getByLabel("More actions for E2E Model model");
  await modelMore.click();
  const modelActions = section.getByRole("button", { name: "Delete E2E Model model" }).locator("xpath=..");
  await expectFullyHitTestable(modelActions);
  await expect(section.getByText("vendor/e2e-model", { exact: true })).toHaveCount(0);
  await modelMore.click();

  await section.getByRole("tab", { name: "Authentication" }).click();
  await section.locator("#provider-default-credential").selectOption("credential-e2e");
  await expect(section.getByText("Ready to activate.")).toBeVisible();

  await section.getByRole("tab", { name: "Diagnostics" }).click();
  const diagnostics = section.getByTestId("provider-task-diagnostics");
  await diagnostics.getByRole("button", { name: "Check model route" }).click();
  await expect(section.getByText("The exact model and credential draft is available.")).toBeVisible();
  await expect(diagnostics.getByText("available", { exact: true })).toBeVisible();

  await section.getByRole("button", { name: "Activate and enable" }).click();
  await expect(section.getByText("Provider draft activated and enabled for new runs.")).toBeVisible();
  expect(activationBody).toEqual({
    action: "activate",
    confirmUnavailable: false,
    enableConnection: true
  });
  await expect(section.getByText("Provider is active and ready for new runs.")).toBeVisible();
  const providerHeader = section.getByRole("heading", {
    level: 2,
    name: "E2E OpenRouter"
  }).locator("..");
  await expect(providerHeader.getByText("Enabled", { exact: true })).toBeVisible();
  await expect(providerHeader.getByText("Active v1", { exact: true })).toBeVisible();

  const connectionDetail = section.getByTestId("provider-connection-task-detail");
  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 1024, width: 768 },
    { height: 844, width: 390 },
    { height: 390, width: 844 }
  ]) {
    await page.setViewportSize(viewport);
    const back = section.getByRole("button", { name: "Back to connections" });
    await expect(connectionIndex).toBeHidden();
    await expect(connectionDetail).toBeVisible();
    await expect(back).toBeVisible();
    await expectNoPageOverflow(page);

    await back.click();
    await expect(connectionIndex).toBeVisible();
    await expect(connectionDetail).toBeHidden();
    await expectNoPageOverflow(page);

    await connectionIndex.getByRole("button", { name: /E2E OpenRouter/ }).click();
    await expect(connectionIndex).toBeHidden();
    await expect(connectionDetail).toBeVisible();
    await expect(connectionDetail.getByRole("heading", { name: "E2E OpenRouter" })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test("administrator remaps the three composer run profiles in one save", async ({ page }) => {
  let providerCatalogRequests = 0;
  let submittedProfiles: Array<Record<string, unknown>> | null = null;
  const runProfileCatalog: AdminRunProfileCatalog = {
    models: [
      {
        connectionEnabled: true,
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        displayName: "GPT-5.6 Luna",
        id: "deployment-luna",
        modelEnabled: true,
        providerDisplayName: "Primary OpenAI",
        reasoningEfforts: ["none", "medium", "high", "max"],
        reasoningModes: ["standard", "pro"],
        selectable: true
      },
      {
        connectionEnabled: true,
        defaultReasoningEffort: "max",
        defaultReasoningMode: "pro",
        displayName: "GPT-5.6 Sol",
        id: "deployment-sol",
        modelEnabled: true,
        providerDisplayName: "Primary OpenAI",
        reasoningEfforts: ["none", "medium", "high", "max"],
        reasoningModes: ["standard", "pro"],
        selectable: true
      }
    ],
    profiles: [
      { description: "Simple questions", enabled: true, id: "fast", label: "Fast", providerModelId: "deployment-luna", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: now, version: 2 },
      { description: "Everyday questions", enabled: true, id: "balanced", label: "Balanced", providerModelId: "deployment-luna", reasoningEffort: "medium", reasoningMode: "standard", updatedAt: now, version: 3 },
      { description: "Difficult questions", enabled: true, id: "deep", label: "Deep", providerModelId: "deployment-sol", reasoningEffort: "max", reasoningMode: "pro", updatedAt: now, version: 4 }
    ]
  };

  await page.route("**/api/admin/providers", async (route) => {
    providerCatalogRequests += 1;
    await route.fulfill({ contentType: "application/json", json: { connections: [] } });
  });
  await page.route("**/api/admin/providers/quick-setup", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        providers: [
          { provider: "openai", providerDisplayName: "OpenAI", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openai" },
          { provider: "anthropic", providerDisplayName: "Anthropic", quickSetupAssigned: false, state: "not_configured", stateToken: "state-anthropic" },
          { provider: "gemini", providerDisplayName: "Gemini", quickSetupAssigned: false, state: "not_configured", stateToken: "state-gemini" },
          { provider: "openrouter", providerDisplayName: "OpenRouter", quickSetupAssigned: false, state: "not_configured", stateToken: "state-openrouter" }
        ],
        suggestedProvider: null
      }
    });
  });
  await page.route("**/api/admin/run-profiles", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: runProfileCatalog });
      return;
    }
    const body = route.request().postDataJSON() as { profiles: Array<Record<string, unknown>> };
    submittedProfiles = body.profiles;
    await route.fulfill({
      contentType: "application/json",
      json: {
        models: runProfileCatalog.models,
        profiles: body.profiles.map((profile) => ({
          description: profile.description,
          enabled: profile.enabled,
          id: profile.id,
          label: profile.id === "fast" ? "Fast" : profile.id === "balanced" ? "Balanced" : "Deep",
          providerModelId: profile.providerModelId,
          reasoningEffort: profile.reasoningEffort,
          reasoningMode: profile.reasoningMode,
          updatedAt: now,
          version: Number(profile.expectedVersion) + 1
        }))
      }
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin");
  const section = page.getByTestId("admin-section-providers");
  await section.getByRole("tab", { name: "Run profiles" }).click();
  await expect(section.getByRole("heading", { name: "Run profiles" })).toBeVisible();
  expect(providerCatalogRequests).toBe(0);
  await expect(section.getByLabel("Fast description")).toHaveValue("Simple questions");
  await expect(section.getByLabel("Balanced description")).toHaveValue("Everyday questions");
  await expect(section.getByLabel("Deep description")).toHaveValue("Difficult questions");

  await section.getByLabel("Fast description").fill("Quick factual questions");
  await section.getByLabel("Fast model deployment").selectOption("deployment-sol");
  await expect(section.getByLabel("Fast reasoning mode")).toHaveValue("pro");
  await expect(section.getByLabel("Fast reasoning effort")).toHaveValue("max");
  await section.getByRole("tab", { name: "Connections" }).click();
  const discardConfirmation = page.getByRole("dialog", {
    name: "Discard Run profile changes"
  });
  await expect(discardConfirmation).toBeVisible();
  await discardConfirmation.getByRole("button", { name: "Cancel" }).click();
  expect(providerCatalogRequests).toBe(0);
  await expect(section.getByLabel("Fast description")).toHaveValue("Quick factual questions");
  await section.getByRole("button", { name: "Save profiles" }).click();

  await expect(section.getByText("Run profiles saved for future messages.")).toBeVisible();
  expect(submittedProfiles).toHaveLength(3);
  expect(submittedProfiles?.[0]).toMatchObject({
    description: "Quick factual questions",
    expectedVersion: 2,
    id: "fast",
    providerModelId: "deployment-sol",
    reasoningEffort: "max",
    reasoningMode: "pro"
  });
  await section.getByRole("tab", { name: "Connections" }).click();
  await expect.poll(() => providerCatalogRequests).toBe(1);
  await section.getByRole("tab", { name: "Run profiles" }).click();
  await expect(section.getByLabel("Fast description")).toHaveValue("Quick factual questions");
});

test("ordinary user receives real provider-admin denial without provider metadata", async ({ page }) => {
  await signInOrdinaryUser(page);

  const [catalog, customPost, mutation, runProfiles, quickGet, quickPost] = await Promise.all([
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
    page.request.get("/api/admin/run-profiles"),
    page.request.get("/api/admin/providers/quick-setup"),
    page.request.post("/api/admin/providers/quick-setup", {
      data: {
        expectedState: "opaque-state",
        provider: "openai",
        secret: "write-only-test-key"
      }
    })
  ]);
  for (const response of [catalog, customPost, mutation, runProfiles, quickGet, quickPost]) {
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
  await expect(page.getByRole("tab", { name: "Providers" })).toHaveCount(0);
});
