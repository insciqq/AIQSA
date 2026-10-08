import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import type { Prisma, PrismaClient } from "@prisma/client";
import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../../lib/contracts/adminProviderCustomSetup";
import { snapshotComposerDefaults } from "./composerToolsOff";
import { signInWithLocalToken } from "./localAuth";

/**
 * The answer review stand for the fake-provider suites. Fake QSA writes the
 * answer and its revision (scripted `record_review_decisions`, see the fake
 * provider); the reviewer is a second model on a local Responses endpoint set
 * up through the admin custom setup, because the stand's catalog offers one
 * fake model and a review never uses the answer's own model. The question
 * names the reviewer's outcome: `[AIQSA_REVIEW_E2E:findings]` (one finding),
 * `[AIQSA_REVIEW_E2E:clean]`, or `[AIQSA_REVIEW_E2E:converge]` (one finding
 * until the author has revised once, then clean).
 */

export const REVIEWER_NAME = "Fixture Reviewer";

export const REVIEW_FINDING = { claim: "The answer states the total without checking it.", evidence: null, id: "F1",
  problem: "The total is not verified against the figures in the question.", repeatsFindingId: null, severity: "high",
  suggestion: "Verify the total and say how it was computed." };

export type ReviewerEndpoint = Readonly<{
  /** Holds reviews until the returned function is called; `after` more reviews pass first. */
  hold(after?: number): () => void;
  reviews: string[];
  url: string;
  close(): Promise<void>;
}>;

/**
 * A Responses endpoint: the custom setup's probes as in
 * chat-output-defaults.spec.ts, and a reviewer that submits one finding or
 * none through `submit_answer_review`, then says so.
 */
export async function startReviewerEndpoint(): Promise<ReviewerEndpoint> {
  let held: Promise<void> | null = null;
  let heldAfter = 0;
  const reviews: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ context_length: 128_000, id: "fixture/reviewer" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const tools: Array<{ name?: string }> = Array.isArray(body.tools) ? body.tools : [];
      let text = "";
      let output: unknown[];
      if (tools.some((tool) => tool.name === "submit_answer_review")) {
        // A later round's reviewer reads the session's whole chain, the author's revision request included.
        const clean = wire.includes("AIQSA_REVIEW_E2E:clean") ||
          (wire.includes("AIQSA_REVIEW_E2E:converge") && wire.includes("Answer revision request"));
        if (wire.includes("function_call_output")) {
          text = clean ? "Review submitted: no substantive issues." : "Review submitted: one finding.";
          output = [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }];
        } else {
          reviews.push(wire);
          // A held review ends with the request: Stop aborts the app's fetch and closes this connection.
          if (held && reviews.length > heldAfter) {
            await Promise.race([held, new Promise<void>((resolve) => response.once("close", () => resolve()))]);
          }
          if (response.destroyed || response.writableEnded) return;
          output = [{ arguments: JSON.stringify({ findings: clean ? [] : [REVIEW_FINDING], verdict: clean ? "clean" : "changes_needed" }),
            call_id: `review-${reviews.length}`, id: `review-${reviews.length}`, name: "submit_answer_review", status: "completed",
            type: "function_call" }];
        }
      } else {
        // The custom setup's probes.
        const title = body.text?.format?.name === "chat_title";
        text = title ? JSON.stringify({ title: "Answer review fixture" })
          : wire.includes("input_file") || wire.includes("input_image") ? "PEARS"
            : body.text?.format ? JSON.stringify({ count: 2, label: "OK", ready: true, tool_ids: ["alpha", "beta"] }) : "OK";
        const tool = tools.find((item) => item.name?.startsWith("aiqsa_"));
        output = tool
          ? (tool.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
            arguments: JSON.stringify({ city }), call_id: `call-${index}`, id: `function-${index}`, name: tool.name, status: "completed",
            type: "function_call" }))
          : [{ content: [{ text, type: "output_text" }], role: "assistant", type: "message" }];
        if (tool) text = "";
      }
      const completed = { id: `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`, model: body.model, output,
        status: "completed", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { connection: "close", "content-type": "text/event-stream" });
      const events = [{ response: { id: completed.id, status: "in_progress" }, type: "response.created" },
        ...(text ? [{ delta: text, type: "response.output_text.delta" }] : []), { response: completed, type: "response.completed" }];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    hold(after = 0) {
      let release!: () => void;
      heldAfter = reviews.length + after;
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { held = null; release(); };
    },
    reviews,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  };
}

export type AnswerReviewStand = Readonly<{
  /** Chats the cases created; the teardown deletes them with the fixture's runs. */
  chatIds: Set<string>;
  connectionId: string;
  endpoint: ReviewerEndpoint;
  /** Restores the account's defaults and the installation's policies, and removes the fixture deployment. */
  close(): Promise<void>;
}>;

/**
 * Resets the stand, starts the reviewer endpoint, registers it as a model
 * through the admin custom setup and warms the given routes: a cold dev
 * server compiles each route on its first request, the step and Stop routes
 * with the whole run pipeline, so the cases time the review, not the compiler.
 */
export async function openAnswerReviewStand(input: Readonly<{
  baseURL: string | undefined;
  browser: Browser;
  prisma: PrismaClient;
  userId: string;
  warmPaths: readonly string[];
}>): Promise<AnswerReviewStand> {
  const { prisma, userId } = input;
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const endpoint = await startReviewerEndpoint();
  const chatIds = new Set<string>();
  const restoreDefaults = await snapshotComposerDefaults(prisma, userId);
  const policy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const roles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  // The custom setup's bootstrap makes a new deployment the installation's default and roles where none is set.
  const restorePolicies = async (tx: Prisma.TransactionClient) => {
    await tx.modelPolicy.update({ data: { defaultProviderModelId: policy.defaultProviderModelId,
      reasoningEffort: policy.reasoningEffort, version: policy.version }, where: { id: "installation" } });
    await tx.systemModelPolicy.update({ data: { chatPdfProviderModelId: roles.chatPdfProviderModelId,
      chatPdfReasoningEffort: roles.chatPdfReasoningEffort, providerModelId: roles.providerModelId,
      reasoningEffort: roles.reasoningEffort, version: roles.version }, where: { id: "installation" } });
  };
  let connectionId: string | null = null;
  const close = async () => {
    await restoreDefaults();
    if (connectionId) await removeFixtureDeployment(prisma, { chatIds, connectionId, restorePolicies, userId });
    await endpoint.close();
  };
  const page = await input.browser.newPage({ baseURL: input.baseURL });
  try {
    await signInWithLocalToken(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { data: {
      allowPrivateNetwork: true, apiRoot: endpoint.url, authenticationMode: "none", confirmPaidRequest: true,
      connectionDisplayName: "Answer review fixture", modelDisplayName: REVIEWER_NAME, modelIds: ["fixture/reviewer"],
      perModelCapabilities: { "fixture/reviewer": { contextWindow: 128_000 } }, protocol: "responses", responseTimeoutSeconds: 30
    }, timeout: 90_000 });
    expect(response.ok(), await response.text()).toBe(true);
    const setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("ready");
    connectionId = setup.connectionId;
    const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId } });
    expect(model.displayName).toBe(REVIEWER_NAME);
    expect((model.capabilities as Prisma.JsonObject).toolCalling, "the reviewer fixture must verify tool calling").toBe(true);
    for (const path of input.warmPaths) {
      const warmed = await page.request.post(path, { data: {}, timeout: 240_000 });
      expect([400, 404], path).toContain(warmed.status());
    }
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  } finally {
    await page.close();
  }
  return { chatIds, close, connectionId, endpoint };
}

/** References first, as the admin deletion of a deployment clears them. */
async function removeFixtureDeployment(prisma: PrismaClient, input: Readonly<{
  chatIds: ReadonlySet<string>;
  connectionId: string;
  restorePolicies(tx: Prisma.TransactionClient): Promise<void>;
  userId: string;
}>): Promise<void> {
  const { connectionId: id, userId } = input;
  await prisma.$transaction(async (tx) => {
    // The restored policies, then any default or role still naming the fixture
    // (ModelPolicy and the roles restrict deleting the model).
    await input.restorePolicies(tx);
    const modelIds = (await tx.providerModel.findMany({ select: { id: true }, where: { connectionId: id } }))
      .map((model) => model.id);
    await tx.userSettings.updateMany({ data: { defaultProviderModelId: null }, where: { defaultProviderModelId: { in: modelIds } } });
    await tx.modelPolicy.updateMany({ data: { defaultProviderModelId: null, reasoningEffort: null },
      where: { defaultProviderModelId: { in: modelIds } } });
    await tx.memoryUtilityModelPolicy.updateMany({ data: { assignmentSource: "OPERATOR", providerModelId: null, reasoningEffort: null },
      where: { providerModelId: { in: modelIds } } });
    for (const field of ["providerModelId", "rerankerProviderModelId", "visionProviderModelId", "chatPdfProviderModelId",
      "chatPdfNativeProviderModelId", "chatTitleProviderModelId"] as const) {
      await tx.systemModelPolicy.updateMany({
        data: {
          [field]: null,
          ...(field === "providerModelId" ? { reasoningEffort: null } : {}),
          ...(field === "chatTitleProviderModelId" ? { chatTitleReasoningEffort: null } : {}),
          ...(field === "visionProviderModelId" ? { visionReasoningEffort: null } : {}),
          ...(field === "chatPdfProviderModelId" ? { chatPdfReasoningEffort: null } : {}),
          ...(field === "chatPdfNativeProviderModelId" ? { chatPdfNativeReasoningEffort: null } : {})
        },
        where: { [field]: { in: modelIds } }
      });
    }
    await tx.chat.updateMany({ data: { defaultProviderModelId: null }, where: { defaultProviderModelId: { in: modelIds } } });
    const runs = await tx.modelRun.findMany({ select: { chatId: true, id: true }, where: { providerRunBindings: { some: { connectionId: id } } } });
    const chatIds = [...new Set([...runs.map((run) => run.chatId), ...input.chatIds])];
    await tx.providerRunBinding.deleteMany({ where: { connectionId: id } });
    await tx.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
    await tx.memoryJob.deleteMany({ where: { chatId: { in: chatIds }, userId } });
    await tx.memoryRetrievalAttempt.deleteMany({ where: { chatId: { in: chatIds }, userId } });
    await tx.memoryRecallChunk.deleteMany({ where: { chatId: { in: chatIds }, userId } });
    // A chat Memory checkpointed restricts its messages' deletion.
    await tx.chatMemoryCheckpointMessage.deleteMany({ where: { chatId: { in: chatIds } } });
    await tx.chatMemoryCheckpoint.deleteMany({ where: { chatId: { in: chatIds } } });
    await tx.chat.deleteMany({ where: { id: { in: chatIds }, userId } });
    await tx.accessGrant.deleteMany({ where: { OR: [{ providerConnectionId: id }, { providerModel: { connectionId: id } }] } });
    await tx.providerUserCredentialAssignment.deleteMany({ where: { connectionId: id } });
    await tx.providerDraftCheck.deleteMany({ where: { connectionId: id } });
    await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId: id } });
    await tx.providerConnection.update({ data: { defaultCredentialId: null }, where: { id } });
    await tx.providerCredential.updateMany({ data: { activeVersionId: null }, where: { connectionId: id } });
    await tx.providerCredentialVersion.deleteMany({ where: { credential: { connectionId: id } } });
    await tx.providerCredential.deleteMany({ where: { connectionId: id } });
    await tx.providerModel.deleteMany({ where: { connectionId: id } });
    await tx.providerConnection.delete({ where: { id } });
  });
}

/** The transcript's last answer block: a review group's latest version, never an answer inside its history. */
export function shownAnswer(page: Page): Locator {
  return page.locator('[data-testid="conversation-thread"] article[data-role="assistant"]:not([data-testid="answer-review-history"] *)').last();
}

/** The latest review group's quiet status line. */
export function reviewStatus(page: Page): Locator {
  return page.getByTestId("answer-review-status");
}
