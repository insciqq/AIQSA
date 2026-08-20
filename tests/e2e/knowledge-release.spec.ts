import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import {
  createKnowledgeVectorSpacePin,
  KNOWLEDGE_CHUNKING_PROFILE_VERSION
} from "../../lib/server/knowledge/indexProfile";
import {
  KNOWLEDGE_INDEX_PROFILE_ID,
  knowledgeProfileConfiguration,
  knowledgeProfileEgressPolicy
} from "../../lib/server/knowledge/knowledgeProfile";
import {
  decodeKnowledgeUploadBatchListResponse,
  type KnowledgeUploadBatch,
  type KnowledgeUploadItem
} from "../../lib/contracts/knowledgeUploads";
import {
  createKnowledgeReleaseCorpus,
  KNOWLEDGE_RELEASE_STRUCTURED_ORDINAL,
  KNOWLEDGE_RELEASE_STRUCTURED_QUERY
} from "../../scripts/knowledge-release-corpus";
import { createKnowledgeOcrFixtures } from "../../scripts/knowledge-ocr-fixtures";
import { chooseSearchStrategy, selectModel } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import {
  expectNoHorizontalOverflow,
  expectWithinViewport
} from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

test.describe("Knowledge Stage 8 release evidence", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    process.env.AIQSA_KNOWLEDGE_RELEASE_E2E !== "1",
    "Runs only in the disposable compose release lane with real storage and parser sidecars."
  );
  test.setTimeout(20 * 60_000);

  const prisma = new PrismaClient();
  const fixture = {
    answerCheckId: randomUUID(),
    answerGrantId: randomUUID(),
    answerModelId: randomUUID(),
    connectionId: randomUUID(),
    credentialId: randomUUID(),
    credentialVersionId: randomUUID(),
    embeddingCheckId: randomUUID(),
    embeddingModelId: randomUUID(),
    profileRevisionId: randomUUID()
  };
  const answerConfiguration = {
    adapterKind: "openai_chat_completions_compatible",
    answerSelectable: true,
    capabilities: {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: { stream: false },
    modelClass: "answer",
    upstreamModelId: "knowledge-release-answer-v1"
  } as const;
  const embeddingConfiguration = {
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 1_024,
      providerFamily: "openai_compatible",
      queryInstructionTemplate: null,
      supportsMrl: false,
      targetDimension: 1_024
    },
    modelClass: "embedding",
    upstreamModelId: "knowledge-release-embedding-v1"
  } as const;
  const vectorPinCandidate = createKnowledgeVectorSpacePin({
    configuration: embeddingConfiguration,
    deploymentId: fixture.embeddingModelId
  });
  if (!vectorPinCandidate?.indexSupported) {
    throw new Error("knowledge_release_vector_pin_unavailable");
  }
  const vectorPin = vectorPinCandidate;

  let providerServer: Server | null = null;
  let priorProfile: Readonly<{
    activeRevisionId: string | null;
    updatedByUserId: string | null;
  }> | null = null;

  function json(value: unknown): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  function contentText(value: unknown): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value.flatMap((part) =>
      typeof part === "object" && part !== null &&
      "text" in part && typeof part.text === "string"
        ? [part.text]
        : []).join("\n");
  }

  function evidenceText(value: string): string {
    const extracted = value.split("\n").flatMap((line) => {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) return [];
      try {
        const decoded = JSON.parse(candidate) as { evidence?: unknown };
        return typeof decoded.evidence === "string" ? [decoded.evidence] : [];
      } catch {
        return [];
      }
    });
    return extracted.join("\n\n");
  }

  function supportingHandle(evidence: string, needle?: string): string | null {
    const end = needle
      ? evidence.toLocaleLowerCase("und").indexOf(needle.toLocaleLowerCase("und"))
      : evidence.length;
    if (end < 0) return null;
    const matches = [...evidence.slice(0, end).matchAll(/\[(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\]/gu)];
    return matches.at(-1)?.[1] ?? null;
  }

  function localAnswer(body: unknown): string {
    const messages = typeof body === "object" && body !== null &&
      "messages" in body && Array.isArray(body.messages)
      ? body.messages
      : [];
    const values = messages.flatMap((message) => {
      if (typeof message !== "object" || message === null || !("content" in message)) return [];
      return [{
        role: "role" in message && typeof message.role === "string" ? message.role : "",
        text: contentText(message.content)
      }];
    });
    const privateMessage = values.find(({ text }) =>
      text.includes("<private_knowledge_evidence version=\"2\">")
    );
    const prompt = values.filter(({ role, text }) =>
      role === "user" && !text.includes("<private_knowledge_evidence")
    ).at(-1)?.text ?? "";
    const evidence = privateMessage ? evidenceText(privateMessage.text) : "";
    const noAnswer = "I couldn't find enough support in the selected sources to answer reliably.";

    if (/reconciliation identifier/iu.test(prompt)) {
      const handle = supportingHandle(evidence, "AX-2026-0842");
      return handle
        ? `The approved Atlas reconciliation identifier is AX-2026-0842 [${handle}].`
        : noAnswer;
    }
    if (/top\s+2.*Amount USD/iu.test(prompt)) {
      const handle = supportingHandle(evidence);
      return handle
        ? `The requested Atlas Release workbook rows are in the cited structured evidence [${handle}].`
        : noAnswer;
    }
    if (/Project Zephyr/iu.test(prompt)) return noAnswer;
    if (/Atlas exports retained|how many days/iu.test(prompt)) {
      const handle = supportingHandle(evidence, "retained for exactly 37 days");
      return handle
        ? `Completed Atlas exports are retained for exactly 37 days [${handle}].`
        : noAnswer;
    }
    return noAnswer;
  }

  function embeddingVector(value: unknown): number[] {
    const tokens = String(value ?? "").normalize("NFKC").toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
    const vector = Array.from({ length: 1_024 }, () => 0);
    const features = [
      ...tokens.map((token) => ({ token, weight: 1 })),
      ...tokens.slice(1).map((token, index) => ({
        token: `${tokens[index]}:${token}`,
        weight: 0.75
      }))
    ];
    for (const feature of features) {
      let hash = 2_166_136_261;
      for (const character of feature.token) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16_777_619) >>> 0;
      }
      vector[hash % vector.length]! += feature.weight;
    }
    const norm = Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0));
    if (norm === 0) return vector.map((_, index) => index === 0 ? 1 : 0);
    return vector.map((entry) => entry / norm);
  }

  async function startProviderServer(): Promise<string> {
    providerServer = createServer((request, response) => {
      if (request.method !== "POST" ||
        request.url !== "/v1/embeddings" && request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            input?: unknown;
          };
          response.writeHead(200, { "content-type": "application/json" });
          if (request.url === "/v1/embeddings") {
            const inputs = Array.isArray(body.input)
              ? body.input
              : typeof body.input === "string" ? [body.input] : [];
            response.end(JSON.stringify({
              data: inputs.map((input, index) => ({
                embedding: embeddingVector(input), index, object: "embedding"
              })),
              model: embeddingConfiguration.upstreamModelId,
              object: "list",
              usage: { prompt_tokens: inputs.length, total_tokens: inputs.length }
            }));
            return;
          }
          response.end(JSON.stringify({
            choices: [{
              finish_reason: "stop",
              index: 0,
              message: { content: localAnswer(body), role: "assistant" }
            }],
            id: "chatcmpl-knowledge-release",
            model: answerConfiguration.upstreamModelId,
            object: "chat.completion",
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 }
          }));
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid provider request" }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      providerServer!.once("error", onError);
      providerServer!.listen(0, "127.0.0.1", () => {
        providerServer!.off("error", onError);
        resolve();
      });
    });
    const address = providerServer.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async function installReleaseProvider(apiRoot: string): Promise<void> {
    const now = new Date();
    const connectionConfiguration = {
      allowPrivateNetwork: true,
      apiRoot,
      authenticationMode: "none",
      responseTimeoutMs: 300_000
    } as const;
    await prisma.$transaction(async (tx) => {
      const profile = await tx.knowledgeIndexProfile.findUniqueOrThrow({
        select: { activeRevisionId: true, updatedByUserId: true },
        where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
      });
      priorProfile = profile;
      const lastRevision = await tx.knowledgeIndexProfileRevision.findFirst({
        orderBy: { revisionNumber: "desc" },
        select: { revisionNumber: true },
        where: { profileId: KNOWLEDGE_INDEX_PROFILE_ID }
      });
      const policy = await tx.knowledgePolicy.findUniqueOrThrow({
        where: { id: "installation" }
      });
      await tx.providerConnection.create({
        data: {
          activeConfig: json(connectionConfiguration),
          activeVersion: 1,
          activatedAt: now,
          displayName: "Knowledge release local provider",
          draftConfig: json(connectionConfiguration),
          draftVersion: 1,
          enabled: true,
          family: "openai_compatible",
          id: fixture.connectionId,
          unassignedPolicy: "use_default"
        }
      });
      await tx.providerCredential.create({
        data: {
          activatedAt: now,
          connectionId: fixture.connectionId,
          draftSecretEnvelope: null,
          draftVersion: 1,
          enabled: true,
          id: fixture.credentialId,
          label: "No authentication",
          testedAt: now
        }
      });
      await tx.providerCredentialVersion.create({
        data: {
          activatedAt: now,
          credentialId: fixture.credentialId,
          id: fixture.credentialVersionId,
          secretEnvelope: null,
          testEvidence: { authenticationMode: "none", method: "knowledge_release" },
          testedAt: now,
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
      await tx.providerModel.create({
        data: {
          activeConfig: json(embeddingConfiguration),
          activeVersion: 1,
          activatedAt: now,
          capabilities: json(embeddingConfiguration.capabilities),
          connectionId: fixture.connectionId,
          defaultParams: {},
          displayName: "Knowledge release deterministic embedding",
          draftConfig: json(embeddingConfiguration),
          draftVersion: 1,
          enabled: true,
          id: fixture.embeddingModelId,
          modelClass: "embedding",
          modelId: embeddingConfiguration.upstreamModelId,
          provider: "openai_compatible"
        }
      });
      await tx.providerModelCredentialCheck.create({
        data: {
          checkedAt: now,
          connectionId: fixture.connectionId,
          connectionVersion: 1,
          credentialId: fixture.credentialId,
          credentialVersionId: fixture.credentialVersionId,
          evidence: { method: "knowledge_release" },
          id: fixture.embeddingCheckId,
          modelVersion: 1,
          providerModelId: fixture.embeddingModelId,
          status: "available"
        }
      });
      await tx.providerModel.create({
        data: {
          activeConfig: json(answerConfiguration),
          activeVersion: 1,
          activatedAt: now,
          capabilities: json(answerConfiguration.capabilities),
          connectionId: fixture.connectionId,
          defaultParams: json(answerConfiguration.defaultParams),
          displayName: "Knowledge release grounded answer",
          draftConfig: json(answerConfiguration),
          draftVersion: 1,
          enabled: true,
          id: fixture.answerModelId,
          modelClass: "answer",
          modelId: answerConfiguration.upstreamModelId,
          provider: "openai_compatible"
        }
      });
      await tx.providerModelCredentialCheck.create({
        data: {
          checkedAt: now,
          connectionId: fixture.connectionId,
          connectionVersion: 1,
          credentialId: fixture.credentialId,
          credentialVersionId: fixture.credentialVersionId,
          evidence: { method: "knowledge_release" },
          id: fixture.answerCheckId,
          modelVersion: 1,
          providerModelId: fixture.answerModelId,
          status: "available"
        }
      });
      await tx.accessGrant.create({
        data: {
          enabled: true,
          id: fixture.answerGrantId,
          providerModelId: fixture.answerModelId,
          userId: DEFAULT_BOOTSTRAP_USER_ID
        }
      });
      await tx.knowledgeIndexProfileRevision.create({
        data: {
          activatedAt: now,
          chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
          egressPolicy: knowledgeProfileEgressPolicy({
            embeddingProviderModelId: fixture.embeddingModelId
          }),
          embeddingConfiguration: json(vectorPin.configuration),
          embeddingProviderModelId: fixture.embeddingModelId,
          executionAuthority: "installation",
          id: fixture.profileRevisionId,
          preflightCheckedAt: now,
          preflightErrorCode: null,
          preflightStatus: "ready",
          profileConfiguration: knowledgeProfileConfiguration({
            ...policy,
            embeddingProviderModelId: fixture.embeddingModelId
          }),
          profileId: KNOWLEDGE_INDEX_PROFILE_ID,
          revisionNumber: (lastRevision?.revisionNumber ?? 0) + 1,
          targetDimension: vectorPin.targetDimension,
          vectorSpaceFingerprint: vectorPin.fingerprint
        }
      });
      await tx.knowledgeIndexProfile.update({
        data: {
          activeRevisionId: fixture.profileRevisionId,
          updatedByUserId: DEFAULT_BOOTSTRAP_USER_ID,
          version: { increment: 1 }
        },
        where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async function uploadBatch(page: Page, baseId: string): Promise<KnowledgeUploadBatch | null> {
    const response = await page.request.get(`/api/me/knowledge-bases/${baseId}/upload-batches`);
    if (!response.ok()) return null;
    const decoded = decodeKnowledgeUploadBatchListResponse(await response.json());
    return decoded?.batches[0] ?? null;
  }

  async function openNewKnowledgeBase(page: Page): Promise<Locator> {
    const library = page.getByTestId("library-v2");
    const knowledge = page.getByTestId("knowledge-library");
    const trigger = library.getByRole("button", { name: "New base" });
    // A cold Next dev server can finish the on-demand Knowledge compilation
    // immediately after the first click and reset that transient client state.
    // Retrying this idempotent navigation keeps the release lane deterministic.
    await expect(async () => {
      if (await knowledge.isVisible()) return;
      await trigger.click();
      await expect(knowledge).toBeVisible({ timeout: 5_000 });
    }).toPass({
      intervals: [0, 1_000, 2_000, 5_000],
      timeout: 60_000
    });
    return knowledge;
  }

  function terminal(item: KnowledgeUploadItem): boolean {
    return ["cancelled", "needs_attention", "ready", "ready_with_warnings", "reused"]
      .includes(item.state);
  }

  type CitationEvidence = Readonly<{
    assistantMessageId: string;
    evidenceId: string;
    fileName: string;
    handle: string;
    runId: string;
    sourceId: string;
  }>;

  async function waitForActiveChatId(page: Page, previous: string | null = null): Promise<string> {
    let chatId: string | null = null;
    await expect.poll(async () => {
      chatId = await page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId"));
      return chatId && chatId !== previous ? chatId : null;
    }).not.toBeNull();
    return chatId!;
  }

  async function sendPrompt(
    page: Page,
    prompt: string,
    expectedText: string
  ): Promise<Locator> {
    const answers = page.locator('article[data-role="assistant"]');
    const priorCount = await answers.count();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect(answers).toHaveCount(priorCount + 1, { timeout: 90_000 });
    const answer = answers.last();
    await expect(answer).toContainText(expectedText, { timeout: 90_000 });
    return answer;
  }

  async function citationEvidence(
    chatId: string,
    handle: string
  ): Promise<CitationEvidence> {
    let resolved: CitationEvidence | null = null;
    await expect.poll(async () => {
      const run = await prisma.modelRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: { assistantMessageId: true, id: true },
        where: { chatId }
      });
      const item = run ? await prisma.knowledgeEvidenceItem.findFirst({
        select: { fileName: true, id: true, sourceId: true },
        where: { handle, retrievalSession: { modelRunId: run.id } }
      }) : null;
      if (run?.assistantMessageId && item?.fileName && item.sourceId) {
        resolved = {
          assistantMessageId: run.assistantMessageId,
          evidenceId: item.id,
          fileName: item.fileName,
          handle,
          runId: run.id,
          sourceId: item.sourceId
        };
      }
      return resolved;
    }).not.toBeNull();
    return resolved!;
  }

  async function citationHandle(answer: Locator): Promise<string> {
    const trigger = answer.getByRole("button", { name: /^Open source K/u }).first();
    await expect(trigger).toBeVisible();
    const handle = await trigger.getAttribute("data-knowledge-citation");
    if (!handle) throw new Error("knowledge_release_citation_handle_missing");
    return handle;
  }

  async function inspectTextCitation(
    page: Page,
    answer: Locator,
    expectedFileName: string,
    options: Readonly<{ keyboardAndMobile?: boolean }> = {}
  ): Promise<string> {
    const trigger = answer.getByRole("button", { name: /^Open source K/u }).first();
    const handle = await citationHandle(answer);
    if (options.keyboardAndMobile) {
      await page.setViewportSize({ height: 844, width: 390 });
      await trigger.focus();
      await expect(page.getByRole("tooltip")).toContainText(expectedFileName);
      await trigger.press("Enter");
    } else {
      await trigger.click();
    }
    const viewer = page.getByRole("dialog", { name: "Knowledge source viewer" });
    await expect(viewer).toContainText(expectedFileName);
    await expect(viewer.getByText("Exact accepted excerpt")).toBeVisible();
    await expect(viewer.getByText("Page 1", { exact: true })).toBeVisible();
    if (options.keyboardAndMobile) {
      await expectWithinViewport(page, viewer);
      await expectNoHorizontalOverflow(page);
      await expect(viewer.getByRole("button", { name: "Close source viewer" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } else {
      await viewer.getByRole("button", { name: "Close source viewer" }).click();
      await expect(viewer).toHaveCount(0);
    }
    return handle;
  }

  test.beforeAll(async () => {
    await installReleaseProvider(await startProviderServer());
  });

  test.afterAll(async () => {
    try {
      if (priorProfile) {
        await prisma.knowledgeIndexProfile.update({
          data: {
            activeRevisionId: priorProfile.activeRevisionId,
            updatedByUserId: priorProfile.updatedByUserId,
            version: { increment: 1 }
          },
          where: { id: KNOWLEDGE_INDEX_PROFILE_ID }
        });
      }
    } finally {
      await prisma.$disconnect();
      await new Promise<void>((resolve, reject) => {
        if (!providerServer) {
          resolve();
          return;
        }
        providerServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  test("runs the real 50-document release journey across Knowledge contexts", async ({ page }, testInfo) => {
    const ocrDirectory = testInfo.outputPath("knowledge-release-ocr");
    await mkdir(ocrDirectory, { recursive: true });
    const ocrFixture = await createKnowledgeOcrFixtures({ directory: ocrDirectory, pageCount: 1 });
    const corpus = createKnowledgeReleaseCorpus({ scannedPdf: ocrFixture.imageOnlyPdf });
    const cancelDocument = corpus.find(({ scenario }) => scenario === "cancel")!;
    const exactDocument = corpus.find(({ scenario }) => scenario === "exact_identifier")!;
    const factDocument = corpus.find(({ scenario }) => scenario === "fact")!;
    const retryDocument = corpus.find(({ scenario }) => scenario === "retry")!;
    const structuredDocument = corpus.find(({ ordinal }) =>
      ordinal === KNOWLEDGE_RELEASE_STRUCTURED_ORDINAL)!;
    const baseName = `Stage 8 release corpus ${randomUUID().slice(0, 8)}`;
    const uploadActions = new Map<string, "cancel" | "retry">();
    let cancelHeld = false;
    let releaseCancel!: () => void;
    const cancelReleaseGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let retryInterrupted = false;
    let resolveBatchMap!: () => void;
    const batchMapped = new Promise<void>((resolve) => {
      resolveBatchMap = resolve;
    });

    page.on("response", async (response) => {
      if (response.request().method() !== "POST" ||
        !/\/api\/me\/knowledge-bases\/[^/]+\/upload-batches$/u.test(response.url())) return;
      const decoded = decodeKnowledgeUploadBatchListResponse({
        batches: [(await response.json() as { batch: unknown }).batch]
      });
      for (const item of decoded?.batches[0]?.items ?? []) {
        if (item.fileName === cancelDocument.fileName) uploadActions.set(item.id, "cancel");
        if (item.fileName === retryDocument.fileName) uploadActions.set(item.id, "retry");
      }
      resolveBatchMap();
    });
    await page.route("**/api/me/knowledge-bases/**/upload-batches/**/items/**/content?attempt=*", async (route: Route) => {
      await batchMapped;
      const itemId = new URL(route.request().url()).pathname.match(/\/items\/([^/]+)\/content$/u)?.[1];
      const action = itemId ? uploadActions.get(decodeURIComponent(itemId)) : undefined;
      if (action === "retry" && !retryInterrupted) {
        retryInterrupted = true;
        await route.abort("failed");
        return;
      }
      if (action === "cancel" && !cancelHeld) {
        cancelHeld = true;
        await cancelReleaseGate;
        await route.abort("aborted").catch(() => undefined);
        return;
      }
      await route.continue();
    });

    await signInWithLocalToken(page);
    await runAccountMenuAction(page, "Knowledge");
    const library = page.getByTestId("library-v2");
    const knowledge = await openNewKnowledgeBase(page);
    await knowledge.getByLabel("Name").fill(baseName);
    await knowledge.getByLabel("Description").fill(
      "Deterministic Stage 8 release evidence: mixed formats, recovery, and real ingestion."
    );
    await knowledge.getByLabel("Choose files").setInputFiles(corpus.map((document) => ({
      buffer: document.bytes,
      mimeType: document.mimeType,
      name: document.fileName
    })));
    await expect(knowledge.getByRole("list", { name: "Files selected for this Knowledge base" })
      .getByRole("listitem")).toHaveCount(50);

    const createdResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      /\/api\/me\/knowledge-bases$/u.test(new URL(response.url()).pathname)
    );
    await knowledge.getByRole("button", { name: "Create knowledge base" }).click();
    const created = await createdResponse;
    expect(created.ok()).toBe(true);
    const baseId = (await created.json() as { knowledgeBase: { id: string } }).knowledgeBase.id;

    await expect(knowledge.getByTestId(/^knowledge-upload-item-/u)).toHaveCount(50, {
      timeout: 60_000
    });
    const cancelRow = knowledge.getByTestId(/^knowledge-upload-item-/u)
      .filter({ hasText: cancelDocument.fileName });
    await expect(cancelRow.getByRole("progressbar", {
      name: `${cancelDocument.fileName} upload progress`
    })).toBeVisible();
    await expect.poll(() => cancelHeld, { timeout: 120_000 }).toBe(true);
    await cancelRow.getByRole("button", { name: "Cancel" }).click();
    releaseCancel();
    await expect(cancelRow).toContainText("Cancelled", { timeout: 30_000 });
    await expect.poll(() => retryInterrupted, { timeout: 120_000 }).toBe(true);
    const retryItemId = [...uploadActions.entries()].find(([, action]) =>
      action === "retry")?.[0];
    if (!retryItemId) throw new Error("knowledge_release_retry_item_missing");
    const expiredRetry = await prisma.knowledgeUploadItem.updateMany({
      data: { sessionExpiresAt: new Date(0) },
      where: { id: retryItemId, state: "QUEUED" }
    });
    expect(expiredRetry.count).toBe(1);

    await expect.poll(async () => {
      const batch = await uploadBatch(page, baseId);
      return batch?.items.filter((item) =>
        item.fileName !== retryDocument.fileName && !terminal(item)
      ).length ?? -1;
    }, { timeout: 8 * 60_000 }).toBe(0);

    await page.reload();
    await runAccountMenuAction(page, "Knowledge");
    await page.getByTestId("library-v2").getByRole("button", { name: "Open" }).click();
    const restored = page.getByTestId("knowledge-library");
    const retryRow = restored.getByTestId(/^knowledge-upload-item-/u)
      .filter({ hasText: retryDocument.fileName });
    await expect(retryRow).toContainText("Needs attention");
    await retryRow.getByLabel("Retry").setInputFiles({
      buffer: retryDocument.bytes,
      mimeType: retryDocument.mimeType,
      name: retryDocument.fileName
    });
    await expect.poll(async () => {
      const batch = await uploadBatch(page, baseId);
      return batch?.items.find(({ fileName }) =>
        fileName === retryDocument.fileName)?.attemptNumber ?? null;
    }, { timeout: 120_000 }).toBe(2);

    await expect.poll(async () => {
      const batch = await uploadBatch(page, baseId);
      return batch?.items.every(terminal) ?? false;
    }, { timeout: 8 * 60_000 }).toBe(true);
    const settledBatch = await uploadBatch(page, baseId);
    if (!settledBatch) throw new Error("knowledge_release_upload_batch_missing");
    expect(settledBatch.items).toHaveLength(50);
    expect(settledBatch.items.filter(({ state }) => state === "cancelled")).toHaveLength(1);
    expect(settledBatch.items.filter(({ state }) =>
      state === "ready" || state === "ready_with_warnings" || state === "reused"
    )).toHaveLength(49);
    expect(settledBatch.items.find(({ fileName }) => fileName === retryDocument.fileName))
      .toMatchObject({ attemptNumber: 2, state: expect.stringMatching(/^ready/u) });
    const factSourceId = settledBatch.items.find(({ fileName }) =>
      fileName === factDocument.fileName)?.sourceId;
    const exactSourceId = settledBatch.items.find(({ fileName }) =>
      fileName === exactDocument.fileName)?.sourceId;
    const structuredSourceId = settledBatch.items.find(({ fileName }) =>
      fileName === structuredDocument.fileName)?.sourceId;
    if (!factSourceId || !exactSourceId || !structuredSourceId) {
      throw new Error("knowledge_release_source_identity_missing");
    }

    await restored.getByRole("button", { name: "Refresh" }).click();
    await expect(restored.getByText("49 ready · 1 cancelled", { exact: true })).toBeVisible({
      timeout: 30_000
    });
    await expect(restored.getByTestId(/^knowledge-upload-item-/u)).toHaveCount(50);

    const factPassage = await prisma.knowledgeArtifactPassageIndex.findFirst({
      select: { fileName: true, text: true },
      where: { text: { contains: "retained for exactly 37 days" } }
    });
    expect(factPassage).toMatchObject({
      fileName: expect.stringContaining("fact.md"),
      text: expect.stringContaining("retained for exactly 37 days")
    });
    const exactIdentifier = await prisma.knowledgeArtifactExactEntry.findFirst({
      select: { kind: true, normalizedValue: true, value: true },
      where: { normalizedValue: "ax-2026-0842" }
    });
    expect(exactIdentifier).toMatchObject({
      kind: "identifier",
      normalizedValue: "ax-2026-0842",
      value: "AX-2026-0842"
    });

    await restored.getByRole("button", { name: "Back to Knowledge" }).click();
    await page.getByTestId("library-v2").getByRole("button", { name: "Back to chat" }).click();
    await page.reload();
    await selectModel(
      page,
      fixture.connectionId,
      "Knowledge release grounded answer",
      "Knowledge release local provider"
    );
    await chooseSearchStrategy(page, "Off");
    await page.getByRole("button", { name: "Capabilities" }).click();
    const capabilities = page.getByRole("menu", { name: "Capabilities" });
    await capabilities.getByRole("menuitemcheckbox", { name: baseName }).click();

    const factPrompt = "According to the selected sources, how many days are completed Atlas exports retained?";
    const factAnswer = await sendPrompt(page, factPrompt, "retained for exactly 37 days");
    const personalChatId = await waitForActiveChatId(page);
    const personalFactHandle = await inspectTextCitation(
      page,
      factAnswer,
      factDocument.fileName,
      { keyboardAndMobile: true }
    );
    const personalFactEvidence = await citationEvidence(personalChatId, personalFactHandle);
    expect(personalFactEvidence).toMatchObject({
      fileName: factDocument.fileName,
      sourceId: factSourceId
    });
    await page.setViewportSize({ height: 800, width: 1280 });

    const exactAnswer = await sendPrompt(
      page,
      "What is the exact approved Atlas reconciliation identifier?",
      "AX-2026-0842"
    );
    const exactHandle = await inspectTextCitation(page, exactAnswer, exactDocument.fileName);
    await expect(citationEvidence(personalChatId, exactHandle)).resolves.toMatchObject({
      fileName: exactDocument.fileName,
      sourceId: exactSourceId
    });

    const structuredAnswer = await sendPrompt(
      page,
      KNOWLEDGE_RELEASE_STRUCTURED_QUERY,
      "cited structured evidence"
    );
    const structuredHandle = await citationHandle(structuredAnswer);
    await structuredAnswer.getByRole("button", { name: `Open source ${structuredHandle}` }).click();
    const structuredViewer = page.getByRole("dialog", { name: "Knowledge source viewer" });
    await expect(structuredViewer).toContainText(structuredDocument.fileName);
    await expect(structuredViewer.getByTestId("knowledge-workbook-evidence")).toBeVisible();
    await expect(structuredViewer.getByLabel("Cited workbook ranges")).toContainText(
      "Atlas Release!"
    );
    await expect(structuredViewer).toContainText("Amount USD");
    await expect(structuredViewer).toContainText("4897.5");
    await expect(structuredViewer.getByText("Exact accepted excerpt")).toHaveCount(0);
    await structuredViewer.getByRole("button", { name: "Close source viewer" }).click();
    await expect(citationEvidence(personalChatId, structuredHandle)).resolves.toMatchObject({
      fileName: structuredDocument.fileName,
      sourceId: structuredSourceId
    });

    const noAnswer = await sendPrompt(
      page,
      "According to the selected sources, what is the launch code for Project Zephyr?",
      "I couldn't find enough support in the selected sources to answer reliably."
    );
    await expect(noAnswer.getByRole("button", { name: /^Open source K/u })).toHaveCount(0);

    const projectName = `Stage 8 canonical source ${randomUUID().slice(0, 8)}`;
    const createProjectResponse = await page.request.post("/api/projects", {
      data: {
        description: "Knowledge release canonical Source verification",
        name: projectName,
        preferredModelId: fixture.answerModelId
      }
    });
    expect(createProjectResponse.status()).toBe(201);
    let project = (await createProjectResponse.json() as {
      project: {
        defaults: Record<string, unknown>;
        id: string;
        policyRevision: number;
      };
    }).project;
    const addKnowledgeResponse = await page.request.post(`/api/projects/${project.id}/resources`, {
      data: {
        expectedPolicyRevision: project.policyRevision,
        resourceId: baseId,
        type: "knowledge"
      }
    });
    expect(addKnowledgeResponse.status()).toBe(201);
    const projectDetailResponse = await page.request.get(`/api/projects/${project.id}`);
    expect(projectDetailResponse.ok()).toBe(true);
    project = (await projectDetailResponse.json() as { project: typeof project }).project;
    const projectDefaults = {
      ...project.defaults,
      assistantId: null,
      controlValues: {},
      knowledgePlan: { baseIds: [baseId], mode: "explicit", sourceIds: [], version: 1 },
      mcpMode: "off",
      providerModelId: fixture.answerModelId,
      searchPlan: { mode: "all_selected", optionIds: [] }
    };
    const updateProjectResponse = await page.request.patch(`/api/projects/${project.id}`, {
      data: {
        defaults: projectDefaults,
        expectedPolicyRevision: project.policyRevision
      }
    });
    expect(updateProjectResponse.ok()).toBe(true);

    await page.reload();
    const projectRow = page.locator('section[aria-label="Shared projects"] .v2-project-row')
      .filter({ hasText: projectName });
    await expect(projectRow).toBeVisible({ timeout: 30_000 });
    const priorPersonalChatId = await page.evaluate(() =>
      window.localStorage.getItem("aiqsa.activeChatId")
    );
    await projectRow.click();
    await expect(page.getByTestId("project-blank-orientation")).toContainText(projectName);
    const projectAnswer = await sendPrompt(page, factPrompt, "retained for exactly 37 days");
    const projectChatId = await waitForActiveChatId(page, priorPersonalChatId);
    const projectFactHandle = await inspectTextCitation(page, projectAnswer, factDocument.fileName);
    const projectFactEvidence = await citationEvidence(projectChatId, projectFactHandle);
    expect(projectFactEvidence.sourceId).toBe(factSourceId);

    const assistantAvatar = {
      accents: [0, 2],
      backgroundShape: "circle",
      foregroundShape: "diamond",
      kind: "generated",
      paletteId: "ocean",
      recipeVersion: 1,
      rotations: [0, 1]
    } as const;
    const assistantName = `Stage 8 Atlas guide ${randomUUID().slice(0, 8)}`;
    const assistantResponse = await page.request.post("/api/me/assistants", {
      data: {
        avatar: assistantAvatar,
        category: null,
        description: "Knowledge release canonical Source verification",
        developerPrompt: null,
        knowledgeSelection: {
          baseIds: [baseId], mode: "explicit", sourceIds: [], version: 1
        },
        mcpServerIds: [],
        name: assistantName,
        providerModelId: fixture.answerModelId,
        runControls: {},
        searchPlan: { mode: "all_selected", optionIds: [] },
        skillIds: [],
        starterPrompts: [],
        systemPrompt: "Answer only from the selected Knowledge evidence."
      }
    });
    expect(assistantResponse.status()).toBe(201);
    const assistantId = (await assistantResponse.json() as {
      assistant: { id: string };
    }).assistant.id;

    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await page.getByRole("button", { name: "Capabilities" }).click();
    await page.getByRole("menu", { name: "Capabilities" })
      .getByRole("menuitemcheckbox", { name: /Use an Assistant/u }).click();
    const assistantPicker = page.getByTestId("assistant-picker");
    await expect(assistantPicker).toBeVisible();
    await assistantPicker.getByTestId(`assistant-picker-row-${assistantId}`).click();
    await expect(page.getByTestId("composer-v2-assistant-lock")).toBeVisible();
    const assistantAnswer = await sendPrompt(page, factPrompt, "retained for exactly 37 days");
    const assistantChatId = await waitForActiveChatId(page, projectChatId);
    const assistantFactHandle = await inspectTextCitation(
      page,
      assistantAnswer,
      factDocument.fileName
    );
    const assistantFactEvidence = await citationEvidence(assistantChatId, assistantFactHandle);
    expect(assistantFactEvidence.sourceId).toBe(factSourceId);
    expect([
      personalFactEvidence.sourceId,
      projectFactEvidence.sourceId,
      assistantFactEvidence.sourceId
    ]).toEqual([factSourceId, factSourceId, factSourceId]);

    const sourceDetailResponse = await page.request.get(
      `/api/me/knowledge-sources/${factSourceId}`
    );
    expect(sourceDetailResponse.ok()).toBe(true);
    const sourceVersion = (await sourceDetailResponse.json() as {
      source: { version: number };
    }).source.version;
    const trashResponse = await page.request.post(
      `/api/me/knowledge-sources/${factSourceId}/trash`,
      { data: { expectedVersion: sourceVersion } }
    );
    expect(trashResponse.status()).toBe(204);
    const trashedDetailResponse = await page.request.get(
      `/api/me/knowledge-sources/${factSourceId}`
    );
    expect(trashedDetailResponse.ok()).toBe(true);
    const trashedVersion = (await trashedDetailResponse.json() as {
      source: { version: number };
    }).source.version;
    const deleteResponse = await page.request.post(
      `/api/me/knowledge-sources/${factSourceId}/delete-permanently`,
      { data: { expectedVersion: trashedVersion } }
    );
    expect(deleteResponse.status()).toBe(202);

    const citationUrl = `/api/runs/${personalFactEvidence.runId}/messages/${personalFactEvidence.assistantMessageId}/citations/${personalFactEvidence.handle}`;
    await expect.poll(async () => {
      const response = await page.request.get(citationUrl);
      if (!response.ok()) return `http_${response.status()}`;
      const body = await response.json() as { citation?: { state?: unknown } };
      return body.citation?.state;
    }, { timeout: 120_000 }).toBe("deleted");
    await expect(prisma.knowledgeEvidenceItem.findUnique({
      select: {
        excerpt: true,
        fileName: true,
        locator: true,
        sourceId: true,
        state: true
      },
      where: { id: personalFactEvidence.evidenceId }
    })).resolves.toEqual({
      excerpt: null,
      fileName: null,
      locator: null,
      sourceId: null,
      state: "deleted"
    });

    await page.evaluate((chatId) => {
      window.localStorage.setItem("aiqsa.activeChatId", chatId);
    }, personalChatId);
    await page.reload();
    const historicalFactAnswer = page.locator('article[data-role="assistant"]')
      .filter({ hasText: "retained for exactly 37 days" }).first();
    const historicalTrigger = historicalFactAnswer.locator(
      `[data-knowledge-citation="${personalFactEvidence.handle}"]`
    );
    await expect(historicalTrigger).toBeVisible();
    await historicalTrigger.click();
    const tombstoneViewer = page.getByRole("dialog", { name: "Knowledge source viewer" });
    await expect(tombstoneViewer).toContainText("Deleted Knowledge source");
    await expect(tombstoneViewer).toContainText(
      "Citation evidence was removed with the source. No filename, passage, or locator is retained."
    );
    await expect(tombstoneViewer).not.toContainText(factDocument.fileName);
    await expect(tombstoneViewer).not.toContainText("37 days");
  });
});
