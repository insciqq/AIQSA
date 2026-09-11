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
import { imageModelConfiguration, initialImageModels } from "../../lib/domain/imageModels";
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
        label: "Primary",
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
      await tx.memoryRetrievalAttempt.deleteMany({
        where: { chatId: { in: chatIds }, userId: fixture.userId }
      });
      await tx.memoryRecallChunk.deleteMany({
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

function quickSetupSnapshot(configured: boolean) {
  const provider = (id: string, label: string, models: string[]) => ({
    candidateModels: models.map((displayName) => ({ displayName })),
    provider: id,
    providerDisplayName: label,
    stateToken: `state-${id}`
  });
  return {
    providers: [
      {
        ...provider("openai", "OpenAI", ["GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.6 Sol"]),
        stateToken: configured ? "state-openai-ready" : "state-openai-fresh"
      },
      provider("anthropic", "Anthropic", ["Claude Opus 5", "Claude Sonnet 5"]),
      provider("gemini", "Gemini", ["Gemini 3.6 Flash"]),
      provider("deepseek", "DeepSeek", ["DeepSeek V4 Pro"]),
      provider("openrouter", "OpenRouter", ["Claude Opus 4.8"])
    ]
  };
}

/** A catalog row for a custom connection the mocked custom-setup just created. */
function customConnectionFixture(input: {
  apiRoot: string;
  displayName: string;
  id: string;
  modelIds: readonly string[];
}): AdminProviderConnection {
  const configuration = {
    allowPrivateNetwork: false,
    apiRoot: input.apiRoot,
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  const credentialId = `${input.id}-credential`;
  const versionId = `${input.id}-version-1`;
  const models = input.modelIds.map((upstreamModelId, index) => {
    const modelConfiguration: AdminProviderModelConfiguration = {
      adapterKind: "openai_responses_compatible",
      answerSelectable: true,
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: false, streaming: true, vision: false },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId
    };
    return {
      activatedAt: now,
      activeConfig: modelConfiguration,
      activeVersion: 1,
      connectionId: input.id,
      createdAt: now,
      displayName: upstreamModelId,
      draftConfig: modelConfiguration,
      draftVersion: 1,
      enabled: true,
      id: `${input.id}-model-${index + 1}`,
      updatedAt: now
    };
  });
  return {
    activatedAt: now,
    activeChecks: models.map((model) => ({
      checkedAt: now,
      connectionVersion: 1,
      credentialId,
      credentialVersionId: versionId,
      evidence: {
        detail: "ok",
        method: "tiny_generation",
        selectedProviders: [],
        upstreamModelId: model.activeConfig.upstreamModelId
      },
      latestRefreshError: null,
      modelVersion: 1,
      providerModelId: model.id,
      refreshFailedAt: null,
      status: "available"
    })),
    activeConfig: configuration,
    activeVersion: 1,
    assignments: [],
    createdAt: now,
    credentials: [{
      activatedAt: now,
      activeVersion: { activatedAt: now, id: versionId, revokedAt: null, testedAt: now, version: 1 },
      createdAt: now,
      draftSecretConfigured: false,
      draftVersion: 1,
      enabled: true,
      id: credentialId,
      label: "Primary",
      testedAt: now,
      updatedAt: now
    }],
    defaultCredentialId: credentialId,
    displayName: input.displayName,
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    family: "openai_compatible",
    id: input.id,
    models,
    unassignedPolicy: "use_default",
    updatedAt: now,
    userAssignments: []
  };
}

test("image checks retain editing and retry unconfirmed generation", async ({ page }, testInfo) => {
  const presets = initialImageModels("openrouter");
  const connection = customConnectionFixture({ apiRoot: "https://synthetic.example/v1", displayName: "Synthetic OpenRouter",
    id: "synthetic-images", modelIds: presets.map(({ id }) => id) });
  connection.family = "openrouter";
  connection.models.forEach((model, index) => {
    const configuration = imageModelConfiguration(presets[index]!.id, { profile: "openrouter" });
    configuration.capabilities.imageGeneration = index !== 0;
    model.displayName = presets[index]!.name;
    model.modelClass = "image";
    model.activeConfig = configuration;
    model.draftConfig = configuration;
    const check = connection.activeChecks[index]!;
    const proof = { adapterKind: "openrouter_images" as const, upstreamModelId: presets[index]!.id, verified: true as const, probeVersion: 1 as const };
    check.evidence = { ...check.evidence!, imageEditing: proof, ...(index ? { imageGeneration: proof } : {}),
      capabilitySetup: { policyVersion: 2, activation: "initial", checks: { modelAccess: "verified", imageGeneration: index ? "verified" : "incomplete", imageEditing: "verified" },
        ...(index ? {} : { attempts: { imageGeneration: { attempts: 1, status: "incomplete", reason: "invalid_input", httpStatus: 400,
          imageFailure: { category: "invalid_parameter", parameter: "resolution" } } } }) } };
  });
  const first = connection.models[0]!;
  connection.checkRun = { id: "synthetic-image-check", credentialId: connection.defaultCredentialId!, current: null, done: 6,
    failed: [first.id], finishedAt: now, inFlight: [], reason: "requested", startedAt: now, state: "completed", total: 6,
    results: connection.models.map((model, index) => ({ providerModelId: model.id, state: index ? "saved" : "partial",
      checks: connection.activeChecks[index]!.evidence!.capabilitySetup!.checks })) };
  let retries = 0;
  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      expect(request.postDataJSON()).toMatchObject({ action: "check_models", retryUnresolved: true, credentialId: connection.defaultCredentialId });
      retries++;
      first.activeConfig!.capabilities.imageGeneration = true;
      first.activeVersion++;
      const check = connection.activeChecks[0]!;
      check.modelVersion = first.activeVersion;
      check.evidence!.imageGeneration = check.evidence!.imageEditing;
      check.evidence!.capabilitySetup!.checks.imageGeneration = "verified";
      check.evidence!.capabilitySetup!.attempts = { imageGeneration: { attempts: 1, reason: "verified", status: "verified" } };
      connection.checkRun = { ...connection.checkRun!, failed: [], results: connection.checkRun!.results!.map((result) => ({ ...result, state: "saved" })) };
    }
    await route.fulfill({ json: { connections: [connection] } });
  });
  await signInWithLocalToken(page);
  await page.goto(`/admin?section=providers&resource=${connection.id}`);
  const models = page.getByTestId("provider-models");
  await expect(models).toContainText("Image models · 6");
  const row = page.getByTestId(`provider-model-${first.id}`);
  await expect(row.getByTestId("model-chip-imageEditing")).toHaveAttribute("data-chip-tone", "ok");
  const generation = row.getByTestId("model-chip-imageGeneration");
  await expect(generation).toHaveAttribute("data-chip-tone", "muted");
  await generation.click();
  await expect(row).toContainText("invalid parameter (resolution) · HTTP 400");
  await page.screenshot({ path: testInfo.outputPath("partial-image-check.png") });
  await page.getByRole("button", { name: "Retry checks", exact: true }).click();
  await expect(generation).toHaveAttribute("data-chip-tone", "ok");
  await expect(row.getByTestId("model-chip-imageEditing")).toHaveAttribute("data-chip-tone", "ok");
  await expect(page.getByRole("button", { name: "Retry checks", exact: true })).toHaveCount(0);
  expect(retries).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("recovered-image-check.png") });
});

test("long provider models keep navigation fixed and wheel scrolling on the document", async ({ page }, testInfo) => {
  const connection = customConnectionFixture({ apiRoot: "https://synthetic.example/v1", displayName: "Synthetic long provider",
    id: "synthetic-scroll", modelIds: Array.from({ length: 24 }, (_, index) => `synthetic/model-${String(index + 1).padStart(2, "0")}`) });
  connection.models.forEach((model) => { model.displayName = `Long synthetic model name with detailed capability results ${model.id}`; });
  connection.activeChecks.forEach((check) => { check.evidence = { ...check.evidence!, compatibility: {
    probeVersion: 2, directPdf: "not_supported", modelAccess: "verified", streaming: "verified", structuredOutput: "not_supported", usage: "verified"
  }, capabilitySetup: { policyVersion: 2, checks: { structuredOutput: "incomplete" }, attempts: {
    structuredOutput: { attempts: 3, status: "incomplete", reason: "semantic_inconclusive" }
  } } }; });
  const second = customConnectionFixture({ apiRoot: "https://synthetic.example/v1", displayName: "Synthetic second provider",
    id: "synthetic-scroll-second", modelIds: ["synthetic/second"] });
  await page.route("**/api/admin/providers**", async (route) => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/admin/providers") {
      await route.fulfill({ json: { connections: [connection, second] } });
    } else await route.fulfill({ status: 400, json: { error: "unexpected_synthetic_request" } });
  });
  await signInWithLocalToken(page);
  for (const viewport of [
    { width: 1600, height: 900, theme: "dark" },
    { width: 1280, height: 560, theme: "light" },
    { width: 1279, height: 560, theme: "dark" },
    { width: 1024, height: 560, theme: "light" },
    { width: 1023, height: 560, theme: "dark" },
    { width: 390, height: 844, theme: "light" }
  ] as const) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ colorScheme: viewport.theme });
    await page.goto(`/admin?section=providers&resource=${connection.id}`);
    const table = page.getByRole("table", { name: "Models" });
    await expect(table).toBeVisible();
    const scroller = table.locator("..");
    const expectDocumentScroll = async () => {
      await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
      await page.evaluate(() => window.scrollTo(0, 650));
      const box = await table.boundingBox();
      await page.mouse.move(box!.x + Math.min(80, box!.width / 2), Math.min(400, viewport.height - 50));
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, 350);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
    };
    const expectNavigation = async () => {
      for (const [id, visible] of [["admin-rail", viewport.width >= 768], ["admin-section-column", viewport.width >= 1024]] as const) {
        const navigation = page.getByTestId(id);
        if (!visible) { await expect(navigation).toBeHidden(); continue; }
        await expect.poll(() => navigation.evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(0);
        await expect.poll(() => navigation.evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBe(viewport.height);
      }
      if (viewport.width >= 768) await expect(page.getByTestId("admin-rail").getByRole("button").last()).toBeInViewport();
    };
    await expectDocumentScroll();
    await expectNavigation();
    if (viewport.width === 1280) {
      // Exercise a wide table without widening the document.
      await table.evaluate((element) => { element.style.minWidth = `${element.parentElement!.clientWidth + 200}px`; });
      await expect.poll(() => scroller.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
      // Chromium may finish the preceding vertical wheel gesture first.
      await expect.poll(async () => {
        await page.mouse.wheel(160, 0);
        return scroller.evaluate((element) => element.scrollLeft);
      }).toBeGreaterThan(0);
      await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
      await expectNoPageOverflow(page);
      await table.evaluate((element) => { element.style.removeProperty("min-width"); });
    }
    const last = page.getByTestId(`provider-model-${connection.models.at(-1)!.id}`);
    await last.scrollIntoViewIfNeeded();
    await expect(last.getByRole("switch")).toBeInViewport();
    const diagnostic = last.getByTestId("model-chip-json");
    await diagnostic.click();
    await expect(last).toContainText("Inconclusive");
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(diagnostic).toBeFocused();
    const menu = last.getByRole("button", { name: `More actions for ${connection.models.at(-1)!.displayName}` });
    await menu.hover();
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Edit", exact: true })).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    await expectNavigation();
    await expectNoPageOverflow(page);
    if (viewport.width === 1600 || viewport.width === 390) {
      await page.screenshot({ path: testInfo.outputPath(`models-${viewport.width}-${viewport.theme}.png`) });
    }
    await page.reload();
    await expect(table).toBeVisible();
    await expectDocumentScroll();
  }
  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers", exact: true }).click();
  await page.getByRole("link", { name: /^Open Synthetic second provider/ }).click();
  await expect(page.getByRole("table", { name: "Models" })).toContainText("synthetic/second");
  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers", exact: true }).click();
  await page.getByRole("link", { name: /^Open Synthetic long provider/ }).click();
  const restoredTable = page.getByRole("table", { name: "Models" });
  await expect(restoredTable).toContainText(connection.models.at(-1)!.displayName);
  await expect.poll(() => restoredTable.locator("..").evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
});

test("administrator adds OpenAI through the Add provider sheet, retries a rejected key without another model-selection step, and chats with it", async ({ page }) => {
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
  await page.route("**/api/admin/providers", async (route) => {
    if (configured) await route.continue();
    else await route.fulfill({ json: { connections: [] } });
  });
  const quickRequests: Array<{ body: Record<string, unknown>; method: string }> = [];
  const messageRequests: Record<string, unknown>[] = [];
  let releaseKeyRetry!: () => void;
  const keyRetryCanFinish = new Promise<void>((resolve) => {
    releaseKeyRetry = resolve;
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
      await route.fulfill({ contentType: "application/json", json: quickSetupSnapshot(configured) });
      return;
    }

    const body = request.postDataJSON() as Record<string, unknown>;
    quickRequests.push({ body, method: request.method() });
    const postNumber = quickRequests.filter(({ method }) => method === "POST").length;
    expect(postNumber).toBeLessThanOrEqual(2);
    expect(body).toEqual({
      connectionDisplayName: "OpenAI",
      expectedState: "state-openai-fresh",
      provider: "openai",
      secret: "e2e-quick-write-only-key"
    });
    if (postNumber === 1) {
      await keyRetryCanFinish;
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
        connectionId: fixtureState.current.connectionId,
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
        providerDisplayName: "OpenAI",
        search: null
      }
    });
  });

  await page.setViewportSize({ height: 844, width: 390 });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers");
  const section = page.getByTestId("admin-section-providers");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Providers");
  await expect(section.getByText("No providers yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add provider" }).click();
  const sheet = page.getByRole("dialog", { name: "Add provider" });
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Providers");
  await expect(sheet.getByTestId("provider-add-tiles").getByRole("button")).toHaveCount(6);
  await expect(sheet.getByRole("button", { name: "OpenAI", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(sheet.getByTestId("provider-add-summary")).toContainText("GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.6 Sol");
  await expect(sheet.getByLabel("Name")).toHaveValue("OpenAI");
  await expect(sheet.getByText(/Uses small paid requests\./u)).toBeVisible();
  const keyField = sheet.getByLabel("API key");
  await expect(keyField).toHaveAttribute("type", "text");
  await keyField.fill("e2e-quick-write-only-key");
  await expectNoPageOverflow(page);
  await sheet.getByRole("button", { name: "Test & Save" }).click();

  await expect(sheet.getByTestId("provider-add-selection")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Test & Save" })).toBeDisabled();
  await expect(keyField).toBeDisabled();
  await expectNoPageOverflow(page);
  releaseKeyRetry();
  await expect(sheet.getByTestId("provider-add-error")).toHaveText(
    "The provider rejected the key or its account catalog could not be reached."
  );
  await expect(keyField).toHaveAttribute("aria-invalid", "true");
  await expect(keyField).toHaveValue("e2e-quick-write-only-key");
  await expect(sheet.getByRole("button", { name: "Test & Save" })).toBeEnabled();

  await sheet.getByRole("button", { name: "Test & Save" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/section=providers&resource=/u);
  const installedFixture = fixtureState.current;
  if (!installedFixture) throw new Error("Quick setup fixture was not installed");
  await expect(page.getByTestId("admin-topbar-title")).toContainText("OpenAI");
  await expect(section.getByTestId("provider-page-status")).toContainText("All keys working · 1 model on");
  const primaryKey = section.getByTestId(`provider-key-${installedFixture.credentialId}`);
  await expect(primaryKey).toContainText("Primary");
  await expect(primaryKey).toContainText("Default key");
  await expect(section.getByText("e2e-quick-write-only-key")).toHaveCount(0);
  expect(quickRequests.filter(({ method }) => method === "POST")).toHaveLength(2);
  expect(quickRequests.filter(({ method }) => method === "GET").length).toBeGreaterThanOrEqual(1);

  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 844, width: 390 },
    { height: 1024, width: 768 },
    { height: 390, width: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(section.getByTestId("provider-page")).toBeVisible();
    await expect(page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers" })).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers" }).click();
  await expect(section.getByRole("list", { name: "Providers" })).toBeVisible();
  for (const width of [768, 1024, 1280, 1440]) {
    await page.setViewportSize({ height: 900, width });
    const providerName = section.getByTestId(`provider-row-${installedFixture.connectionId}`)
      .getByText("OpenAI", { exact: true });
    await expect(providerName).toBeVisible();
    expect((await providerName.boundingBox())!.width).toBeGreaterThanOrEqual(120);
    await expectNoPageOverflow(page);
  }
  for (const viewport of [{ height: 900, width: 1440 }, { height: 844, width: 390 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Add provider" }).click();
    const reopened = page.getByRole("dialog", { name: "Add provider" });
    await expect(reopened.getByTestId("provider-add-tiles").getByRole("button")).toHaveCount(6);
    const columns = await reopened.getByTestId("provider-add-tiles").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length
    );
    expect(columns).toBe(viewport.width < 640 ? 2 : 3);
    await expectNoPageOverflow(page);
    await page.keyboard.press("Escape");
    await expect(reopened).toHaveCount(0);
  }

  const catalogResponse = page.waitForResponse((response) =>
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/api/me/catalog"
  );
  await page.goto("/");
  const realCatalogResponse = await catalogResponse;
  expect(realCatalogResponse.ok()).toBe(true);
  await expect(page).toHaveURL(/\/$/);
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
    releaseKeyRetry();
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

test("administrator discovers and configures a Custom compatible provider through the sheet on wide and compact screens", async ({ page }) => {
  const discovered: Record<string, unknown>[] = [];
  const submitted: Record<string, unknown>[] = [];
  const createdConnections: AdminProviderConnection[] = [];

  await page.route("**/api/admin/providers", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ contentType: "application/json", json: { connections: createdConnections } });
  });
  await page.route("**/api/admin/providers/quick-setup", async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({ contentType: "application/json", json: quickSetupSnapshot(false) });
  });
  await page.route("**/api/admin/providers/custom-setup", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    const receipt = submitted.length;
    const selectedModelIds = Array.isArray(body.modelIds)
      ? body.modelIds.filter((value): value is string => typeof value === "string")
      : [];
    const connection = customConnectionFixture({
      apiRoot: String(body.apiRoot),
      displayName: String(body.connectionDisplayName),
      id: `custom-connection-${receipt}`,
      modelIds: selectedModelIds
    });
    createdConnections.push(connection);
    await route.fulfill({
      contentType: "application/json",
      json: {
        authenticationMode: "bearer",
        checkedAt: now,
        connectionDisplayName: connection.displayName,
        connectionId: connection.id,
        defaultChanged: receipt === 1,
        modelDisplayName: connection.models[0]!.displayName,
        models: connection.models.map((model) => ({
          modelDisplayName: model.displayName,
          providerModelId: model.id
        })),
        outcome: "ready",
        providerModelId: connection.models[0]!.id,
        search: null
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

  for (const [index, viewport] of [
    { height: 900, width: 1440 },
    { height: 844, width: 390 }
  ].entries()) {
    await page.setViewportSize(viewport);
    if (index === 0) {
      await expect(section.getByText("No providers yet", { exact: true })).toBeVisible();
    } else {
      await expect(section.getByRole("list", { name: "Providers" })).toBeVisible();
    }
    await page.getByRole("button", { name: "Add provider" }).click();
    const sheet = page.getByRole("dialog", { name: "Add provider" });
    await expect(sheet.getByTestId("provider-add-tiles").getByRole("button")).toHaveCount(6);
    await sheet.getByRole("button", { name: /^Custom/ }).click();
    await expect(sheet.getByLabel("Base URL")).toBeVisible();
    await expect(sheet.getByLabel("API style")).toHaveValue("chat_completions");
    await expect(sheet.getByLabel("API key")).toHaveAttribute("type", "text");
    await expect(sheet.getByRole("button", { name: "Test & Save" })).toBeDisabled();
    await expect(sheet.getByText(/Uses small paid requests\./u)).toBeVisible();
    await expectNoPageOverflow(page);

    const key = `e2e-custom-write-only-key-${viewport.width}`;
    await sheet.getByLabel("Base URL").fill("https://llm.fixture.invalid/v1");
    await expect(sheet.getByLabel("Name")).toHaveValue("Custom · llm.fixture.invalid");
    await sheet.getByLabel("Name").fill(`Fixture Compatible ${viewport.width}`);
    await sheet.getByLabel("API key").fill(key);
    await sheet.getByLabel("API style").selectOption("responses");
    await sheet.getByRole("button", { name: "Find models" }).click();
    await expect(sheet.getByText("Models found on this endpoint · 2")).toBeVisible();
    const models = sheet.getByTestId("provider-add-models");
    await models.getByLabel(new RegExp(`fixture/model-${viewport.width}`)).check();
    await expect(sheet.getByRole("button", { name: "Test & Save 1 model" })).toBeEnabled();
    await models.getByLabel(/fixture\/alternate/).check();
    await expect(sheet.getByRole("button", { name: "Look again" })).toBeVisible();

    await sheet.getByText("Advanced · timeout, private network, reasoning mapping").click();
    await expect(sheet.getByRole("combobox", { name: "Reasoning", exact: true })).toHaveValue("automatic");
    await expect(sheet.getByText("Keep each model's reported reasoning settings. Models without hints use conservative defaults.")).toBeVisible();
    await sheet.getByRole("combobox", { name: "Reasoning", exact: true }).selectOption("openai_gpt_5_6_sol");
    await expect(sheet.getByText(/Effort: none, low, medium, high, xhigh, max; default medium/)).toBeVisible();
    await expect(sheet.getByLabel("Reasoning effort field")).toHaveValue("reasoning.effort");
    await expect(sheet.getByLabel("Reasoning mode field (optional)")).toHaveValue("reasoning.mode");
    await expectNoPageOverflow(page);

    await sheet.getByRole("button", { name: "Test & Save 2 models" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`section=providers&resource=custom-connection-${index + 1}`, "u"));
    await expect(page.getByTestId("admin-topbar-title")).toContainText(`Fixture Compatible ${viewport.width}`);
    await expect(section.getByTestId("provider-page-status")).toContainText("All keys working · 2 models on");
    await expect(section.getByText(key)).toHaveCount(0);
    await expectNoPageOverflow(page);
    await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Providers" }).click();
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
    const width = index === 0 ? 1440 : 390;
    expect(body).toMatchObject({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.fixture.invalid/v1",
      authenticationMode: "bearer",
      capabilities: expect.objectContaining({
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        reasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"]
      }),
      confirmPaidRequest: true,
      connectionDisplayName: `Fixture Compatible ${width}`,
      modelIds: [`fixture/model-${width}`, "fixture/alternate"],
      protocol: "responses",
      reasoningRequestMapping: {
        effortPath: "reasoning.effort",
        modePath: "reasoning.mode"
      },
      responseTimeoutSeconds: 300,
      secret: `e2e-custom-write-only-key-${width}`
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
  await expect(confirmation).toContainText("removed with its keys, models, overrides and defaults");
  await confirmation.getByRole("button", { name: "Delete provider" }).click();
  await expect(section.getByText("No providers yet")).toBeVisible();
  await expect(page).not.toHaveURL(/resource=/u);
  expect(actionBodies).toEqual([]);
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
        activeConfig: body.configuration as typeof configuration,
        activeVersion: connection.activeVersion + 1,
        displayName: String(body.displayName),
        draftConfig: body.configuration as typeof configuration,
        draftVersion: connection.draftVersion + 1
      };
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
  await expect(form).toContainText("with small paid requests");
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
  expect(settingsBodies.map(({ method }) => method)).toEqual(["PATCH"]);
  expect(settingsBodies[0]?.body).toMatchObject({
    activate: true,
    credentialSecrets: [],
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

test("administrator adds a model with one Test & Save, follows the background check, and manages rows without leaving the page", async ({ page }) => {
  const configuration = {
    allowPrivateNetwork: false,
    apiRoot: "https://api.openai.com/v1",
    authenticationMode: "bearer" as const,
    responseTimeoutSeconds: 300
  };
  const modelConfiguration = (upstreamModelId: string): AdminProviderModelConfiguration => ({
    adapterKind: "openai_responses_native",
    answerSelectable: true,
    capabilities: {
      nativePdfInput: true,
      nativeSearch: false,
      pdf: true,
      reasoning: false,
      streaming: true,
      toolCalling: true,
      vision: false
    },
    defaultParams: {},
    modelClass: "answer",
    upstreamModelId
  });
  const model = (id: string, displayName: string, upstreamModelId: string) => ({
    activatedAt: now,
    activeConfig: modelConfiguration(upstreamModelId),
    activeVersion: 1,
    connectionId: "provider-models-e2e",
    createdAt: now,
    displayName,
    draftConfig: modelConfiguration(upstreamModelId),
    draftVersion: 1,
    enabled: true,
    id,
    modelClass: "answer" as const,
    updatedAt: now
  });
  const check = (providerModelId: string, upstreamModelId: string, directPdf: "not_supported" | "verified") => ({
    checkedAt: now,
    connectionVersion: 1,
    credentialId: "credential-e2e",
    credentialVersionId: "credential-version-e2e",
    evidence: {
      compatibility: {
        directPdf,
        forcedToolCall: "verified" as const,
        toolCalling: "verified" as const,
        modelAccess: "verified" as const,
        probeVersion: 2 as const,
        streaming: "verified" as const,
        structuredOutput: "verified" as const,
        usage: "verified" as const
      },
      detail: "ok" as const,
      method: "tiny_generation" as const,
      selectedProviders: [],
      upstreamModelId
    },
    latestRefreshError: null,
    modelVersion: 1,
    providerModelId,
    refreshFailedAt: null,
    status: "available" as const
  });
  let connection: AdminProviderConnection = {
    activatedAt: now,
    activeChecks: [check("model-terra", "gpt-5.6-terra", "verified"), check("model-sol", "gpt-5.6-sol", "not_supported")],
    activeConfig: configuration,
    activeVersion: 1,
    assignments: [],
    checkRun: null,
    createdAt: now,
    credentials: [{
      activatedAt: now,
      activeVersion: { activatedAt: now, id: "credential-version-e2e", revokedAt: null, testedAt: now, version: 1 },
      createdAt: now,
      draftSecretConfigured: false,
      draftVersion: 1,
      enabled: true,
      id: "credential-e2e",
      label: "Primary",
      testedAt: now,
      updatedAt: now
    }],
    defaultCredentialId: "credential-e2e",
    displayName: "OpenAI",
    draftChecks: [],
    draftConfig: configuration,
    draftVersion: 1,
    enabled: true,
    family: "openai",
    id: "provider-models-e2e",
    models: [model("model-terra", "GPT-5.6 Terra", "gpt-5.6-terra"), model("model-sol", "GPT-5.6 Sol", "gpt-5.6-sol")],
    unassignedPolicy: "use_default",
    updatedAt: now,
    userAssignments: []
  };
  const requests: Array<{ body: Record<string, unknown>; method: string; path: string }> = [];
  let polls = 0;

  await page.route("**/api/admin/providers**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" ? {} : request.postDataJSON() as Record<string, unknown>;
    if (method !== "GET") requests.push({ body, method, path });

    if (method === "GET" && path === "/api/admin/providers") {
      // Progress arrives through the catalog: the second poll finishes the running check.
      if (connection.checkRun?.state === "running" && connection.checkRun.reason === "requested") {
        polls += 1;
        if (polls >= 2) {
          connection = {
            ...connection,
            checkRun: { ...connection.checkRun, current: null, done: 3, finishedAt: now, inFlight: [], state: "completed" }
          };
        }
      }
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers/provider-models-e2e/models") {
      const upstreamModelId = String((body.configuration as { upstreamModelId: string }).upstreamModelId);
      connection = {
        ...connection,
        activeChecks: [...connection.activeChecks, check("model-new", upstreamModelId, "verified")],
        checkRun: {
          credentialId: "credential-e2e",
          current: null,
          done: 1,
          failed: [],
          finishedAt: now,
          id: "run-model",
          inFlight: [],
          reason: "model",
          startedAt: now,
          state: "completed",
          total: 1
        },
        models: [...connection.models, model("model-new", String(body.displayName), upstreamModelId)]
      };
      await route.fulfill({ contentType: "application/json", json: { receipt: {
        connectionId: connection.id, modelId: "model-new", displayName: String(body.displayName),
        draftVersion: 1, saved: "configuration", publication: "active", checks: "checked"
      } }, status: 201 });
      return;
    }
    if (method === "PATCH" && path === "/api/admin/providers/provider-models-e2e/models/model-sol") {
      connection = {
        ...connection,
        models: connection.models.map((entry) => entry.id === "model-sol" ? { ...entry, enabled: body.action === "enable" } : entry)
      };
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    if (method === "POST" && path === "/api/admin/providers/provider-models-e2e/actions") {
      if (body.action === "check_models") {
        connection = {
          ...connection,
          checkRun: {
            credentialId: String(body.credentialId),
            current: "model-terra",
            done: 1,
            failed: [],
            finishedAt: null,
            id: "run-all",
            inFlight: ["model-terra", "model-sol"],
            reason: "requested",
            startedAt: now,
            state: "running",
            total: 3
          }
        };
      }
      if (body.action === "cancel_check" && connection.checkRun) {
        connection = { ...connection, checkRun: { ...connection.checkRun, inFlight: [], state: "cancelled" } };
      }
      await route.fulfill({ contentType: "application/json", json: { connections: [connection] } });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_provider_models_e2e_request", method, path },
      status: 400
    });
  });

  await signInWithLocalToken(page);
  await page.goto("/admin?section=providers&resource=provider-models-e2e");
  const section = page.getByTestId("admin-section-providers");
  const models = section.getByTestId("provider-models");
  await expect(models.getByRole("table", { name: "Models" })).toBeVisible();
  await expect(models).toContainText("Chat models · 2");
  const sol = models.getByTestId("provider-model-model-sol");
  const pdf = sol.getByTestId("model-chip-pdf");
  await expect(pdf).toHaveText("PDF");
  await expect(pdf).toHaveAttribute("data-chip-tone", "muted");
  await pdf.click();
  await expect(sol.getByText("Not verified with this key. This does not establish that the capability is unsupported.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pdf).toBeFocused();
  await expect(sol.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(models.getByTestId("provider-model-model-terra").getByTestId("model-chip-pdf")).toHaveText("PDF");
  await expect(models).not.toContainText(/\bdraft\b|\brevision\b|\bpending\b|\bevidence\b|\bprobe\b|\badapter\b|\bfingerprint\b|\bdimensions\b/iu);

  // Add model: one Test & Save saves, turns on and checks the model with the default key.
  await models.getByTestId("provider-add-model").click();
  await page.getByRole("menuitem", { name: "Chat model" }).click();
  const sheet = page.getByRole("dialog", { name: "Add model" });
  await expect(sheet).toContainText("Checks supported capabilities with key Primary and enables verified features, including PDF");
  await sheet.getByRole("combobox", { name: "Model", exact: true }).fill("gpt-5.6-luna");
  await expect(sheet.getByLabel("Display name")).toHaveValue("GPT-5.6 Luna");
  await sheet.getByRole("button", { name: "Test & Save" }).click();
  await expect(sheet).toHaveCount(0);
  expect(requests.filter(({ path }) => path.endsWith("/models")).map(({ body }) => body)).toEqual([
    expect.objectContaining({ activate: true, displayName: "GPT-5.6 Luna" })
  ]);
  const added = models.getByTestId("provider-model-model-new");
  await expect(added).toContainText("GPT-5.6 Luna");
  await expect(added.getByTestId("model-chip-tools")).toHaveText("Tools");
  await expect(models).toContainText("Chat models · 3");

  // Check models: the banner tracks the background run and Stop checking ends it.
  await models.getByRole("button", { name: "Check models" }).click();
  const banner = section.getByTestId("provider-check-banner");
  await expect(banner).toContainText("Checking what each model can do with key Primary — 1 of 3 done.");
  await expect(section.getByRole("progressbar", { name: "Models checked" })).toHaveAttribute("aria-valuenow", "1");
  await expect(models.getByTestId("provider-model-model-terra-works-with")).toHaveAttribute("data-works-with", "checking");
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
  expect(polls).toBeGreaterThanOrEqual(2);
  await expect(models.getByTestId("provider-model-model-terra-works-with")).toHaveAttribute("data-works-with", "checked");

  polls = -10;
  await models.getByRole("button", { name: "Check models" }).click();
  await expect(section.getByTestId("provider-check-banner")).toBeVisible();
  await section.getByRole("button", { name: "Stop checking" }).click();
  await expect(section.getByTestId("provider-check-banner")).toHaveCount(0);
  expect(requests.filter(({ body }) => body.action === "cancel_check")).toHaveLength(1);

  // Edit owns the last check; the model list has no duplicate details row.
  await sol.getByText("GPT-5.6 Sol", { exact: true }).click();
  await expect(models.getByTestId("provider-model-model-sol-details")).toHaveCount(0);
  await sol.getByRole("button", { name: "More actions for GPT-5.6 Sol" }).click();
  await expect(page.getByRole("menuitem", { name: "Details" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editSheet = page.getByRole("dialog", { name: "Edit model" });
  await expect(editSheet).toContainText("with key Primary · works without PDF input");
  await expect(editSheet.getByRole("button", { name: "Edit JSON" })).toBeVisible();
  await editSheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await sol.getByRole("switch", { name: "GPT-5.6 Sol on" }).click();
  await expect(sol.getByRole("switch", { name: "GPT-5.6 Sol on" })).not.toBeChecked();
  expect(requests.filter(({ path }) => path.endsWith("/models/model-sol")).map(({ body }) => body)).toEqual([{ action: "disable" }]);
  await expect(page.getByTestId("admin-confirm-turn-off-provider-model")).toHaveCount(0);

  for (const viewport of [
    { height: 900, width: 1440 },
    { height: 1024, width: 768 },
    { height: 844, width: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(models.getByRole("table", { name: "Models" })).toBeVisible();
    await expectNoPageOverflow(page);
  }
});

test("administrator saves a versioned Search recommendation that grants no access", async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
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
      description: "Search the public web",
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
  const vocabulary = /native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical|\bdraft\b|probe|evidence/iu;
  const policy = section.getByRole("region", { name: "Recommended Search plan" });
  await expect(policy).toContainText("This recommendation never grants access.");
  const sourceList = section.getByRole("list", { name: "Search sources" });
  const row = sourceList.getByTestId("search-source-row-search-source-1");
  await expect(row.getByTestId("search-source-status")).toHaveText("Working");
  await expect(section.getByRole("tab")).toHaveCount(0);
  await expect(section).not.toContainText(vocabulary);
  await policy.getByRole("button", { name: "Company Search" }).click();
  await policy.getByRole("button", { name: "Save default" }).click();

  await expect(page.getByTestId("admin-feedback")).toContainText("Organization Search default saved.");
  expect(submitted).toEqual({
    defaultPlan: {
      mode: "all_selected",
      optionIds: ["company-search-12345678"]
    },
    expectedVersion: 4
  });
  await expect(policy.getByRole("button", { name: "Save default" })).toBeDisabled();

  await row.click();
  await expect(page).toHaveURL(/resource=search-source-1/u);
  const sourcePage = section.getByTestId("search-source-page");
  await expect(sourcePage.getByTestId("search-source-page-status"))
    .toContainText("Working · Search model on Compatible gateway · checked today");
  await expect(sourcePage.getByTestId("search-source-check")).toContainText("working, 2 sources found");
  await expect(page.getByRole("switch", { name: "Company Search enabled" })).toBeChecked();
  await expect(page.getByTestId("admin-topbar-title")).toContainText("Company Search");

  for (const viewport of [
    { height: 768, width: 1024 },
    { height: 500, width: 1280 },
    { height: 900, width: 1440 }
  ]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    await expectReadableDetail(page, sourcePage);
  }
  for (const viewport of [
    { height: 1024, width: 768 },
    { height: 844, width: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(sourcePage).toBeVisible();
    await expectNoPageOverflow(page);
  }
  await page.setViewportSize({ height: 900, width: 1440 });

  await sourcePage.getByRole("button", { name: "Configure" }).click();
  const sheet = page.getByRole("dialog", { name: "Configure source" });
  await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(sheet.getByLabel(/^Search model/)).not.toBeVisible();
  await sheet.getByText("Advanced Search execution").click();
  await expect(sheet.getByLabel(/^Search model/)).toHaveValue("search-model-1");
  await expect(sheet.getByRole("spinbutton", {
    name: /^Maximum Search output, tokens/
  })).toHaveValue(String(adminSearchExecutionDefaults.maxOutputTokens));
  await expect(sheet.getByRole("spinbutton", {
    name: /^Maximum requests to this source per answer/
  })).toHaveValue(String(adminSearchExecutionDefaults.maxSearchCallsPerAnswer));
  await expect(sheet.getByRole("combobox", { name: /^Search reasoning/ }))
    .toHaveValue(adminSearchExecutionDefaults.reasoningPolicy);
  await expect(sheet).toContainText("If it fails, nothing changes.");
  await expect(sheet).not.toContainText(vocabulary);
  await expect(section).not.toContainText(vocabulary);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(sourcePage.getByRole("button", { name: "Configure" })).toBeFocused();

  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Search" }).click();
  await expect(sourceList).toBeVisible();
  await expect(page).not.toHaveURL(/resource=/u);
  await expectNoPageOverflow(page);
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
