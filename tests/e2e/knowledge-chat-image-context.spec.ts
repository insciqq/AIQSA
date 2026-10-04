import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient, type SystemModelPolicy } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { createKnowledgeVectorSpacePin, KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "../../lib/server/knowledge/indexProfile";
import { KNOWLEDGE_HIERARCHICAL_INDEX_VERSION } from "../../lib/server/knowledge/hierarchicalIndex";
import { knowledgeProfileConfiguration, knowledgeProfileEgressPolicy } from "../../lib/server/knowledge/knowledgeProfile";
import { deleteKnowledgeSearchArtifacts, runKnowledgeSearchProjectionPass } from "../../lib/server/knowledge/searchProjection";
import { encryptProviderCredentialSecret } from "../../lib/server/providers/credentialSecrets";
import { normalizeProviderModelConfiguration } from "../../lib/server/providers/providerConfiguration";
import { getSecretEncryptionKey } from "../../lib/server/secrets/envelope";
import { syntheticPng } from "../support/rasterFixtures";
import { selectModel } from "./shell/composer";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * Images in Knowledge chats reach the grounded answer as one labelled
 * description made before it: by the answer model when it reads images,
 * otherwise by the System Vision Model, on the full-context route and on the
 * search route. Real admission, run and grounding against a local stub
 * provider, a synthetic ready Knowledge source and its lexical projection.
 */
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());
const json = (value: unknown) => value as Prisma.InputJsonValue;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const OBSERVATION = "IMAGE-OBSERVATION: a poster whose headline is set in a flowing script typeface.";
const AWARE = "IMAGE-AWARE VERDICT: the poster headline uses a script typeface, but the guide requires Helvetica Bold.";
const BLIND = "IMAGE-BLIND VERDICT: no image description reached this answer.";
const GUIDE = "Brand style guide typography: every poster headline must use Helvetica Bold; script typefaces are not allowed for headlines.";
const QUESTION = "Does the headline in this poster follow the style guide?";
const unavailableWorkspace = { workspace: { available: false, enabled: false, internetEnabled: null, sessionState: null,
  unavailableReason: "installation_disabled" } };

type StubState = {
  descriptions: { model: string; images: number }[];
  compose: { model: string; observation: unknown }[];
  review: { model: string; observation: unknown }[];
  rounds: { model: string; pixels: boolean; observationLeaked: boolean }[];
  embeddings: number;
};

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
}

/** The first input_text of a Responses request: the grounded operation's canonical JSON prompt. */
function inputText(value: Record<string, unknown>): string {
  for (const item of Array.isArray(value.input) ? value.input as { content?: unknown }[] : []) {
    for (const part of Array.isArray(item.content) ? item.content as { type?: string; text?: string }[] : []) {
      if (part.type === "input_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

/** One connection: vision and text-only answer models for each route, the Vision analyst and the embedding model. */
async function installKnowledgeImageFixture(ownerUserId: string) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const state: StubState = { descriptions: [], compose: [], review: [], rounds: [], embeddings: 0 };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== "Bearer knowledge-image-fixture") { send({}, 401); return; }
      const value = await body(request);
      const usage = { input_tokens: 5, output_tokens: 5, total_tokens: 10 };
      if (request.url === "/embeddings") {
        const inputs = Array.isArray(value.input) ? value.input : [value.input];
        state.embeddings += 1;
        send({ object: "list", model: value.model, usage: { prompt_tokens: 4, total_tokens: 4 },
          data: inputs.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: 1024 }, (_unused, axis) => axis === index ? 1 : 0.001) })) });
        return;
      }
      if (request.url !== "/responses") { send({}, 404); return; }
      const model = String(value.model);
      const wire = JSON.stringify(value);
      const message = (text: string) => [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const format = (value.text as { format?: { name?: string } } | undefined)?.format?.name;
      let output: unknown[];
      if (format === "knowledge_evidence_compose_v2") {
        const prompt = JSON.parse(inputText(value)) as { evidenceManifest: string; attachedImageObservation?: { text?: string } };
        const handle = /"handle":"(K\d+)"/u.exec(prompt.evidenceManifest)?.[1] ?? "K1";
        state.compose.push({ model, observation: prompt.attachedImageObservation ?? null });
        output = message(JSON.stringify({ version: 1, blocks: [{ kind: "paragraph", evidenceHandles: [handle],
          text: prompt.attachedImageObservation?.text?.includes("script typeface") ? AWARE : BLIND }] }));
      } else if (format === "knowledge_evidence_review_v2") {
        const prompt = JSON.parse(inputText(value)) as { draft: { blocks: { id: string; evidenceHandles: string[] }[] }; attachedImageObservation?: unknown };
        state.review.push({ model, observation: prompt.attachedImageObservation ?? null });
        output = message(JSON.stringify({ version: 2, analysisComplete: true, followUps: [],
          blocks: prompt.draft.blocks.map((block) => ({ blockId: block.id, verdict: "supported", evidenceHandles: block.evidenceHandles, reason: "" })),
          requirements: [{ requirement: "Judge the poster headline against the style guide.", status: "answered",
            blockIds: prompt.draft.blocks.map((block) => block.id), correctionEvidenceHandles: [], gap: "" }] }));
      } else if (wire.includes("Describe the supplied images")) {
        state.descriptions.push({ model, images: (wire.match(/"type":"input_image"/gu) ?? []).length });
        output = message(OBSERVATION);
      } else {
        const input = Array.isArray(value.input) ? value.input as { type?: string }[] : [];
        const tools = Array.isArray(value.tools) ? value.tools as { name?: string }[] : [];
        state.rounds.push({ model, pixels: wire.includes("input_image"), observationLeaked: wire.includes(OBSERVATION) });
        output = tools.some((tool) => tool.name === "search_knowledge") && !input.some((item) => item.type === "function_call_output")
          ? [{ type: "function_call", id: randomUUID(), call_id: randomUUID(), name: "search_knowledge", status: "completed",
            arguments: JSON.stringify({ query: "poster headline typeface style guide", sourceAliases: [] }) }]
          : message("Retrieval complete.");
      }
      const completed = { id: randomUUID(), model, status: "completed", output, usage };
      if (!value.stream) { send(completed); return; }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [{ type: "response.created", response: { id: completed.id, model, status: "in_progress" } },
        { type: "response.completed", response: completed }]) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID();
  const ids = { visualFull: randomUUID(), textFull: randomUUID(), visualSearch: randomUUID(), textSearch: randomUUID(),
    analyst: randomUUID(), embedding: randomUUID() };
  const suffix = randomUUID();
  const k = { profileId: `knowledge-image-e2e-${suffix}`, revisionId: randomUUID(), baseId: randomUUID(), generationId: randomUUID(),
    sourceId: randomUUID(), sourceVersionId: randomUUID(), artifactId: randomUUID(), hierarchyId: randomUUID(), sectionId: randomUUID(),
    passageId: randomUUID(), baseName: `Image style guide ${suffix.slice(0, 8)}` };
  const chatIds: string[] = [];
  let priorRoles: SystemModelPolicy | null = null;
  /** Removes everything this fixture created and restores the role it changed, also after a partial setup. */
  async function cleanup() {
    await deleteKnowledgeSearchArtifacts({ indexArtifactIds: [k.hierarchyId] }).catch(() => undefined);
    const runs = await prisma.modelRun.findMany({ where: { providerRunBindings: { some: { connectionId } } }, select: { chatId: true } });
    const allChats = [...new Set([...runs.map((row) => row.chatId), ...chatIds])];
    const uploads = await prisma.attachment.findMany({ where: { chatId: { in: allChats } }, select: { storageKey: true } });
    await prisma.attachmentDeletionJob.createMany({ data: uploads.map(({ storageKey }) => ({ storageKey })), skipDuplicates: true });
    await prisma.$transaction(async (tx) => {
      // Ready Knowledge rows are immutable outside a purge of exactly this synthetic aggregate.
      await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
      await tx.usageEvent.deleteMany({ where: { OR: [{ chatId: { in: allChats } }, { knowledgeBaseId: k.baseId }] } });
      await tx.attachment.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.modelRun.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.memoryJob.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: allChats } } });
      await tx.chat.deleteMany({ where: { id: { in: allChats } } });
      await tx.knowledgeBaseSnapshotSource.deleteMany({ where: { knowledgeBaseId: k.baseId } });
      await tx.knowledgeBaseSnapshot.deleteMany({ where: { knowledgeBaseId: k.baseId } });
      await tx.knowledgeBaseSource.deleteMany({ where: { knowledgeBaseId: k.baseId } });
      await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: k.artifactId } });
      await tx.knowledgeSource.updateMany({ where: { id: k.sourceId }, data: { currentVersionId: null } });
      await tx.knowledgeSourceVersion.deleteMany({ where: { id: k.sourceVersionId } });
      await tx.knowledgeSource.deleteMany({ where: { id: k.sourceId } });
      await tx.knowledgeBase.updateMany({ where: { id: k.baseId }, data: { activeIndexGenerationId: null } });
      await tx.knowledgeIndexGeneration.deleteMany({ where: { id: k.generationId } });
      await tx.knowledgeBase.deleteMany({ where: { id: k.baseId } });
    });
    let revisionRemoved = true;
    try {
      // Profile revisions are immutable by design; only this synthetic one is removed, as a replica session.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.knowledgeIndexProfileRevision.deleteMany({ where: { id: k.revisionId } });
        await tx.knowledgeIndexProfile.deleteMany({ where: { id: k.profileId } });
      });
    } catch {
      revisionRemoved = false;
    }
    if (priorRoles) await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      visionProviderModelId: priorRoles.visionProviderModelId, visionReasoningEffort: priorRoles.visionReasoningEffort, version: { increment: 1 } } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null, enabled: false } });
    // Without a replica session the immutable revision keeps its embedding model: leave the disabled connection.
    await prisma.providerModel.deleteMany({ where: { connectionId, ...(revisionRemoved ? {} : { id: { not: ids.embedding } }) } });
    if (revisionRemoved) {
      await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { connectionId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    const connectionConfig = { apiRoot: "http://127.0.0.1:" + (server.address() as AddressInfo).port, authenticationMode: "bearer",
      allowPrivateNetwork: true, responseTimeoutMs: 30_000 };
    const answer = (upstreamModelId: string, vision: boolean, contextWindow?: number, answerSelectable = true) => ({
      adapterKind: "openai_responses_native", answerSelectable, modelClass: "answer", upstreamModelId, defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision, toolCalling: true, streaming: true,
        ...(contextWindow ? { contextWindow } : {}) } });
    const embedding = { adapterKind: "openai_embeddings_compatible", answerSelectable: false, modelClass: "embedding",
      upstreamModelId: "knowledge-image-embedding", defaultParams: {},
      capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      embedding: { providerFamily: "openai", nativeDimension: 1024, targetDimension: 1024, supportsMrl: false, queryInstructionTemplate: null } };
    // A declared window lets the small corpus take the full-context route; without one a run always searches.
    const models = [
      { id: ids.visualFull, name: "Knowledge Image Visual Full", modelClass: "answer", configuration: answer("knowledge-image-visual-full", true, 128_000) },
      { id: ids.textFull, name: "Knowledge Image Text Full", modelClass: "answer", configuration: answer("knowledge-image-text-full", false, 128_000) },
      { id: ids.visualSearch, name: "Knowledge Image Visual Search", modelClass: "answer", configuration: answer("knowledge-image-visual-search", true) },
      { id: ids.textSearch, name: "Knowledge Image Text Search", modelClass: "answer", configuration: answer("knowledge-image-text-search", false) },
      { id: ids.analyst, name: "Knowledge Image Analyst", modelClass: "answer", configuration: answer("knowledge-image-analyst", true, undefined, false) },
      { id: ids.embedding, name: "Knowledge Image Embedding", modelClass: "embedding", configuration: embedding }
    ] as const;
    await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Knowledge image fixture", family: "openai", enabled: true,
      draftConfig: connectionConfig, activeConfig: connectionConfig, activeVersion: 1, activatedAt: new Date() } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Fixture", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1, activatedAt: new Date(), testedAt: new Date(),
      testEvidence: { authenticationMode: "bearer" }, secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: credentialVersionId,
        key: getSecretEncryptionKey(), secret: "knowledge-image-fixture" }) } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    for (const model of models) {
      const configuration = model.configuration;
      const embeddingModel = model.modelClass === "embedding";
      await prisma.providerModel.create({ data: { id: model.id, connectionId, provider: "openai", modelId: configuration.upstreamModelId,
        displayName: model.name, enabled: true, modelClass: model.modelClass, capabilities: configuration.capabilities, defaultParams: {},
        draftConfig: json(configuration), activeConfig: json(configuration), activeVersion: 1, activatedAt: new Date() } });
      const visionProof = { adapterKind: "openai_responses_native", upstreamModelId: configuration.upstreamModelId, probeVersion: 1, verified: true };
      await prisma.providerModelCredentialCheck.create({ data: { connectionId, providerModelId: model.id, credentialId, credentialVersionId,
        connectionVersion: 1, modelVersion: 1, checkedAt: new Date(), status: "available", evidence: { method: "tiny_generation", detail: "ok",
          selectedProviders: [], upstreamModelId: configuration.upstreamModelId,
          ...(embeddingModel ? { embedding: { probeVersion: 1, document: true, query: true, dimensions: 1024 } }
            : { compatibility: { toolCalling: "supported", streaming: "supported" },
              ...(configuration.capabilities.vision ? { visionInput: visionProof } : {}) }) } } });
    }
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { visionProviderModelId: ids.analyst, visionReasoningEffort: null,
      version: { increment: 1 } } });

    // A ready Knowledge base on its own installation-authority profile revision, pinned to the embedding model.
    const pin = createKnowledgeVectorSpacePin({ configuration: normalizeProviderModelConfiguration(embedding), deploymentId: ids.embedding });
    if (!pin) throw new Error("knowledge_image_fixture_pin_invalid");
    const now = new Date();
    await prisma.knowledgeIndexProfile.create({ data: { id: k.profileId } });
    await prisma.knowledgeIndexProfileRevision.create({ data: { id: k.revisionId, profileId: k.profileId, revisionNumber: 1,
      embeddingProviderModelId: ids.embedding, embeddingConfiguration: json(pin.configuration), vectorSpaceFingerprint: pin.fingerprint,
      targetDimension: 1024, chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION, executionAuthority: "installation",
      profileConfiguration: knowledgeProfileConfiguration({ embeddingProviderModelId: ids.embedding }),
      egressPolicy: knowledgeProfileEgressPolicy({ embeddingProviderModelId: ids.embedding }),
      preflightStatus: "ready", preflightCheckedAt: now, activatedAt: now } });
    await prisma.knowledgeBase.create({ data: { id: k.baseId, ownerUserId, name: k.baseName } });
    await prisma.knowledgeIndexGeneration.create({ data: { id: k.generationId, knowledgeBaseId: k.baseId, profileRevisionId: k.revisionId,
      embeddingProviderModelId: ids.embedding, embeddingConfiguration: json(pin.configuration), vectorSpaceFingerprint: pin.fingerprint,
      targetDimension: 1024, chunkingProfileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION, status: "active", readyAt: now, activatedAt: now } });
    await prisma.knowledgeBase.update({ where: { id: k.baseId }, data: { activeIndexGenerationId: k.generationId } });
    await prisma.knowledgeSource.create({ data: { id: k.sourceId, ownerUserId, name: "Brand style guide" } });
    await prisma.knowledgeSourceVersion.create({ data: { id: k.sourceVersionId, sourceId: k.sourceId, ownerUserId, versionNumber: 1,
      fileName: "style-guide.md", mimeType: "text/markdown", byteSize: Buffer.byteLength(GUIDE), checksum: sha256(GUIDE) } });
    await prisma.knowledgeSource.update({ where: { id: k.sourceId }, data: { currentVersionId: k.sourceVersionId } });
    // One transaction: the in-app ingestion coordinator never sees a claimable pending artifact.
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeSourceIndexArtifact.create({ data: { id: k.artifactId, sourceVersionId: k.sourceVersionId, profileRevisionId: k.revisionId,
        processingStage: "embedding", chunkCount: 1, embeddedPassageCount: 1, normalizedTextByteSize: Buffer.byteLength(GUIDE),
        normalizedTextChecksum: sha256(GUIDE), normalizedTextStorageKey: `knowledge-image-e2e/${suffix}/normalized`, pageCount: 1 } });
      await tx.knowledgeHierarchicalIndexArtifact.create({ data: { id: k.hierarchyId, derivationMode: "normalized_v2",
        schemaVersion: KNOWLEDGE_HIERARCHICAL_INDEX_VERSION, sourceArtifactId: k.artifactId, sourceVersionId: k.sourceVersionId } });
      await tx.knowledgeArtifactDocumentIndex.create({ data: { contentHash: sha256(`document:${GUIDE}`), documentType: "text/markdown",
        fileName: "style-guide.md", indexArtifactId: k.hierarchyId, pageCount: 1, sourceName: "Brand style guide" } });
      await tx.knowledgeArtifactSectionIndex.create({ data: { id: k.sectionId, contentHash: sha256(`section:${GUIDE}`), fileName: "style-guide.md",
        indexArtifactId: k.hierarchyId, label: "Typography", ordinal: 0, page: 1, pageEnd: 1, passageEnd: 0, passageStart: 0 } });
      await tx.knowledgeArtifactPassageIndex.create({ data: { id: k.passageId, contentHash: sha256(`passage:${GUIDE}`),
        embeddingTextHash: sha256(`embedding:${GUIDE}`), fileName: "style-guide.md", indexArtifactId: k.hierarchyId, ordinal: 0, page: 1, pageEnd: 1,
        sectionId: k.sectionId, sourceBlockEnd: 0, sourceBlockIds: ["block-0"], sourceBlockStart: 0, sourceName: "Brand style guide",
        text: GUIDE, tokenCount: 24 } });
      await tx.knowledgeArtifactExactEntry.create({ data: { id: `knowledge-image-exact-${suffix}`, indexArtifactId: k.hierarchyId, kind: "filename",
        normalizedValue: "style-guide.md", ordinal: 0, value: "style-guide.md", valueHash: sha256("style-guide.md") } });
      await tx.knowledgeHierarchicalIndexArtifact.update({ where: { id: k.hierarchyId }, data: { checksum: sha256(`hierarchy:${GUIDE}`),
        documentCount: 1, exactEntryCount: 1, passageCount: 1, readyAt: now, sectionCount: 1, state: "ready" } });
      await tx.knowledgeSourceIndexArtifact.update({ where: { id: k.artifactId }, data: { processingStage: null, readyAt: now, state: "ready" } });
    });
    await prisma.knowledgeBaseSource.create({ data: { knowledgeBaseId: k.baseId, sourceId: k.sourceId, ownerUserId } });
    // The search route needs the passage in the lexical projection; a running worker may project it first.
    await runKnowledgeSearchProjectionPass({ client: prisma, limit: 16 });
    await expect.poll(async () => (await prisma.knowledgeSearchProjection.findUnique({ where: { indexArtifactId: k.hierarchyId },
      select: { state: true } }))?.state, { timeout: 30_000 }).toBe("READY");
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
  return { chatIds, connectionId, knowledge: k, state, cleanup };
}

async function attach(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByLabel("Attach files").setInputFiles(file);
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function settled(page: Page, connectionId: string) {
  await expect.poll(async () => prisma.modelRun.count({ where: { providerRunBindings: { some: { connectionId } },
    status: { in: ["queued", "in_progress", "streaming"] } } }), { timeout: 60_000 }).toBe(0);
  await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
}

type Fixture = Awaited<ReturnType<typeof installKnowledgeImageFixture>>;

/** One fresh Knowledge chat per model: the image goes with the question and the answer survives reload. */
async function askAboutPoster(page: Page, fixture: Fixture, input: Readonly<{
  modelName: string; upstreamModelId: string; route: "full_context_v1" | "rag_v1"; describer: "answer" | "vision_analysis";
}>) {
  const created = await page.request.post("/api/chats", { data: { memoryMode: "EXCLUDED", workspaceEnabled: false } });
  expect(created.ok()).toBe(true);
  const chatId = (await created.json()).chat.id as string;
  fixture.chatIds.push(chatId);
  const selected = await page.request.patch(`/api/chats/${chatId}`, { data: { defaultKnowledgePlan: {
    version: 1, mode: "explicit", baseIds: [fixture.knowledge.baseId], sourceIds: [] } } });
  expect(selected.ok()).toBe(true);
  await page.goto(`/c/${chatId}`);
  await expect(async () => selectModel(page, fixture.connectionId, input.modelName)).toPass({ timeout: 30_000 });
  await attach(page, { name: "poster.png", mimeType: "image/png", buffer: syntheticPng() });
  await expect(page.getByRole("region", { name: "Attachments" })).toContainText("Ready");
  await expect(page.locator(".v2-live-composer-error")).toHaveCount(0);
  const before = { descriptions: fixture.state.descriptions.length, compose: fixture.state.compose.length,
    review: fixture.state.review.length, rounds: fixture.state.rounds.length };
  await send(page, QUESTION);
  await expect(page.getByText("IMAGE-AWARE VERDICT").first()).toBeVisible({ timeout: 60_000 });
  await settled(page, fixture.connectionId);
  await expect(page.getByText("IMAGE-BLIND VERDICT")).toHaveCount(0);

  const run = await prisma.modelRun.findFirstOrThrow({ where: { chatId }, orderBy: { createdAt: "desc" },
    include: { knowledgeRunScope: { select: { answerRoute: true } }, knowledgeImageObservation: true } });
  expect(run.status).toBe("complete");
  expect(run.knowledgeRunScope?.answerRoute).toBe(input.route);
  // One frozen description by the admitted route, with its own usage receipt.
  expect(run.knowledgeImageObservation).toMatchObject({ state: "settled", providerBindingKey: input.describer, failureCode: null });
  expect(JSON.stringify(run.knowledgeImageObservation?.result)).toContain("script typeface");
  expect(await prisma.usageEvent.count({ where: { chatId, visionAnalysis: true, knowledgeImageObservationRunId: run.id } })).toBe(1);
  expect(fixture.state.descriptions.slice(before.descriptions)).toEqual([{
    model: input.describer === "answer" ? input.upstreamModelId : "knowledge-image-analyst", images: 1 }]);
  // Every compose and review carries the labelled description; the answer model's rounds never do.
  const composes = fixture.state.compose.slice(before.compose);
  const reviews = fixture.state.review.slice(before.review);
  expect(composes.length).toBeGreaterThan(0);
  expect(reviews.length).toBeGreaterThan(0);
  for (const operation of [...composes, ...reviews]) {
    expect(operation).toEqual({ model: input.upstreamModelId, observation: { text: OBSERVATION, truncated: false } });
  }
  const rounds = fixture.state.rounds.slice(before.rounds);
  expect(rounds.length).toBe(input.route === "rag_v1" ? 2 : 0);
  expect(rounds.every((round) => !round.observationLeaked)).toBe(true);

  // Reload shows the published answer without describing the image again.
  const settledCounts = [fixture.state.descriptions.length, fixture.state.compose.length, fixture.state.review.length];
  await page.reload();
  await expect(page.getByText("IMAGE-AWARE VERDICT").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(QUESTION).first()).toBeVisible();
  expect([fixture.state.descriptions.length, fixture.state.compose.length, fixture.state.review.length]).toEqual(settledCounts);
}

for (const route of [
  { name: "full-context", models: { visual: "Visual Full", text: "Text Full" }, upstream: { visual: "knowledge-image-visual-full",
    text: "knowledge-image-text-full" }, answerRoute: "full_context_v1" as const },
  { name: "search-route", models: { visual: "Visual Search", text: "Text Search" }, upstream: { visual: "knowledge-image-visual-search",
    text: "knowledge-image-text-search" }, answerRoute: "rag_v1" as const }
]) {
  test(`a ${route.name} Knowledge answer uses one description of the attached image with vision and text-only models, through reload`, async ({ page }) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(15_000);
    await page.route("**/api/workspace", (request) => request.fulfill({ json: unavailableWorkspace }));
    await signInWithLocalToken(page);
    const me = await page.request.get("/api/me");
    expect(me.ok()).toBe(true);
    const fixture = await installKnowledgeImageFixture((await me.json()).user.id as string);
    try {
      // A model that reads images describes its own image; a text-only model gets the System Vision description.
      await askAboutPoster(page, fixture, { modelName: `Knowledge Image ${route.models.visual}`, upstreamModelId: route.upstream.visual,
        route: route.answerRoute, describer: "answer" });
      await askAboutPoster(page, fixture, { modelName: `Knowledge Image ${route.models.text}`, upstreamModelId: route.upstream.text,
        route: route.answerRoute, describer: "vision_analysis" });
      if (route.answerRoute === "rag_v1") expect(fixture.state.embeddings).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });
}
