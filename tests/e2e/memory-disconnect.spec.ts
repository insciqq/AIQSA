import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { signInWithLocalToken } from "./support/localAuth";
import { startNewChat } from "./support/workspace";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("accepted Memory survives closing its tab, reconnects once, and still honors server Stop", async ({ page, context }) => {
  test.setTimeout(240_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const userId = randomUUID();
  const email = `memory-disconnect-${userId}@example.test`;
  const password = `Synthetic-${randomUUID()}`;
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorMemory = await prisma.memoryUtilityModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  let releaseAnswer: (() => void) | undefined;
  let holdAnswer = false;
  let answerCalls = 0;
  let releaseControl: (() => void) | undefined;
  let controlCalls = 0;
  const statement = "I prefer tea for afternoon breaks.";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/memory" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const control = body.tools?.find((tool: { name?: string }) => tool.name === "MemoryActionIntent");
      const probe = body.tools?.find((tool: { name?: string }) => tool.name?.startsWith("aiqsa_"));
      const wire = JSON.stringify(body.input);
      const text = body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] })
        : wire.includes("input_image") || wire.includes("input_file") ? "PEARS" : "Memory fixture answer.";
      const intent = { decision: controlCalls === 0 ? {
        action: "SAVE", answerRequested: true, category: "preferences", confidenceBand: "HIGH",
        patternExclusionRequested: false, reasonCode: "save_request", responsePreference: false,
        sensitivity: "NORMAL", statement, thisChatOnly: false
      } : { action: "NONE", patternExclusionRequested: false, reasonCode: "no_memory_request" } };
      const tool = control ?? probe;
      const output = tool ? (probe?.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
        type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: tool.name,
        arguments: JSON.stringify(control ? intent : { city }), status: "completed"
      })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const completed = { id: randomUUID(), status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (control) {
        controlCalls += 1;
        if (controlCalls === 1) {
          releaseControl = () => { send(completed); releaseControl = undefined; };
        } else send(completed);
        return;
      }
      const completeAnswer = () => {
        if (response.destroyed) return;
        if (!body.stream) { send(completed); return; }
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        for (const event of [{ type: "response.created", response: { id: completed.id, status: "in_progress" } },
          { type: "response.output_text.delta", delta: text }, { type: "response.completed", response: completed }]) {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      };
      if (!probe && !body.text?.format) {
        answerCalls += 1;
        if (holdAnswer) {
          releaseAnswer = () => { completeAnswer(); releaseAnswer = undefined; };
          return;
        }
      }
      completeAnswer();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let setup: AdminProviderCustomSetupReadyResult | undefined;
  try {
    await signInWithLocalToken(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Memory disconnect fixture",
      modelIds: ["fixture/memory"], protocol: "responses", responseTimeoutSeconds: 120
    } });
    expect(response.ok()).toBe(true);
    setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("ready");
    const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId: setup.connectionId } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: null, reasoningEffort: null, chatTitleProviderModelId: null, version: { increment: 1 }
    } });
    // Memory has its own verified deployment; the legacy System role remains unset.
    await prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: model.id, reasoningEffort: null, assignmentSource: "OPERATOR", version: { increment: 1 }
    } });
    const group = await prisma.group.findFirstOrThrow({ where: { systemRole: "full_access" } });
    await prisma.user.create({ data: { id: userId, email, displayName: "Memory disconnect fixture", status: "active",
      authIdentities: { create: { normalizedEmail: email, provider: "password", providerAccountId: email,
        passwordHash: await hashPassword(password), emailVerifiedAt: new Date() } } } });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId, groups: [{ groupId: group.id, role: "member" }] }));
    await prisma.userSettings.update({ where: { userId }, data: { defaultProviderModelId: model.id,
      defaultWorkspaceEnabled: false, defaultSearchPlan: { mode: "all_selected", optionIds: [] } } });
    await prisma.userMemorySettings.update({ where: { userId }, data: {
      learnAutomatically: false, referenceChatHistory: false, synthesisEnabled: false
    } });
    await page.goto("about:blank");
    await page.request.post("/api/auth/logout", { data: {} });
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    // Next development instrumentation starts the real background coordinator.
    // Reuse its durable queue; the test must not introduce a second claimant.
    await expect.poll(async () => prisma.memoryWorkerHeartbeat.count({ where: {
      ready: true, lastSeenAt: { gt: new Date(Date.now() - 60_000) }
    } }), { timeout: 20_000 }).toBe(1);
    const answersBefore = answerCalls;
    await startNewChat(page);
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill(`Remember that ${statement}`);
    await message.press("Enter");
    await expect.poll(() => controlCalls, { timeout: 20_000 }).toBe(1);
    const run = await prisma.modelRun.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    const command = await prisma.memoryJob.findFirstOrThrow({ where: {
      userId, kind: "MEMORY_COMMAND", sourceMessageId: run.userMessageId
    } });
    expect(command.state).toBe("CLAIMED");
    const controlBinding = await prisma.memoryExecutionBinding.findFirstOrThrow({ where: {
      userId, logicalRole: "MEMORY_CONTROL", memoryJobId: command.id
    } });
    expect(controlBinding).toMatchObject({ state: "RUNNING", ownerType: "JOB" });
    // A held classifier cannot delay the independently generated answer.
    await expect.poll(async () => (await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status,
      { timeout: 25_000 }).toBe("complete");
    expect(answerCalls).toBe(answersBefore + 1);
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE" } })).toBe(0);
    expect(await prisma.memoryOperationReceipt.count({ where: { userId, modelRunId: run.id } })).toBe(0);
    await expect(page.getByText("Memory saved.", { exact: true })).toHaveCount(0);
    await page.close();
    const observer = await context.newPage();
    await observer.goto(`/c/${run.chatId}`);
    await expect(observer.getByTestId("app-shell")).toBeVisible();
    await expect(observer.getByText("Memory fixture answer.", { exact: true })).toBeVisible();
    // Reopening the chat must retain the answer while the command remains
    // unresolved; success feedback is rendered only after its receipt commits.
    await expect(observer.getByText("Memory saved.", { exact: true })).toHaveCount(0);
    expect((await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: controlBinding.id } })).state).toBe("RUNNING");
    releaseControl!();
    await expect.poll(async () => (await prisma.memoryJob.findUniqueOrThrow({ where: { id: command.id } })).commandStatus,
      { timeout: 25_000 }).toBe("COMMITTED");
    await expect.poll(async () => (await prisma.memoryJob.findUniqueOrThrow({ where: { id: command.id } })).state)
      .toBe("SUCCEEDED");
    const receipts = await prisma.memoryOperationReceipt.findMany({ where: { userId, modelRunId: run.id } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ operation: "SAVE", outcome: "APPLIED" });
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE", displayText: statement } })).toBe(1);
    expect(await prisma.modelRunMemoryBinding.findUniqueOrThrow({ where: { modelRunId: run.id } })).toMatchObject({ degradationCode: null });
    expect((await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: controlBinding.id } })).state).toBe("SUCCEEDED");
    await expect(observer.getByText("Memory saved.", { exact: true })).toBeVisible();
    await observer.reload();
    await expect(observer.getByText("Memory saved.", { exact: true })).toBeVisible();
    await observer.reload();
    await expect(observer.getByText("Memory saved.", { exact: true })).toBeVisible();
    expect(controlCalls).toBe(1);
    expect(await prisma.memoryJob.count({ where: { userId, kind: "MEMORY_COMMAND", sourceMessageId: run.userMessageId } })).toBe(1);
    expect(await prisma.memoryOperationReceipt.count({ where: { userId, modelRunId: run.id } })).toBe(1);
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE" } })).toBe(1);

    // Stop is an answer operation. Hold a separate ordinary answer while its
    // independent command classifier returns NONE; the earlier SAVE survives.
    holdAnswer = true;
    await startNewChat(observer);
    await observer.getByRole("textbox", { name: "Message" }).fill("Describe a long imaginary voyage.");
    await observer.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect.poll(() => Boolean(releaseAnswer), { timeout: 20_000 }).toBe(true);
    const stopped = await prisma.modelRun.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    expect(["preparing", "queued", "streaming", "in_progress"]).toContain(stopped.status);
    const cancel = await observer.request.post(`/api/model-runs/${stopped.id}/cancel`);
    expect(cancel.status()).toBe(200);
    expect((await cancel.json()).run.status).toBe("cancelled");
    releaseAnswer!();
    expect(await prisma.memoryOperationReceipt.count({ where: { userId, modelRunId: stopped.id } })).toBe(0);
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE" } })).toBe(1);
    await observer.goto(`/c/${stopped.chatId}`);
    await expect(observer.getByTestId("app-shell")).toBeVisible();
    expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: stopped.id } })).status).toBe("cancelled");
    // Stop does not own the stopped turn's command: it is classified exactly
    // once as no command, and the first command is never classified again.
    const stoppedCommand = await prisma.memoryJob.findFirstOrThrow({ where: {
      userId, kind: "MEMORY_COMMAND", sourceMessageId: stopped.userMessageId
    } });
    await expect.poll(async () => {
      const current = await prisma.memoryJob.findUniqueOrThrow({ where: { id: stoppedCommand.id } });
      return { commandStatus: current.commandStatus, commandResult: current.commandResult, state: current.state };
    }, { timeout: 25_000 }).toEqual({ commandStatus: "REJECTED", commandResult: { classification: "NONE" }, state: "SUCCEEDED" });
    expect(controlCalls).toBe(2);
    expect(await prisma.memoryOperationReceipt.count({ where: { userId, modelRunId: stopped.id } })).toBe(0);
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE" } })).toBe(1);
  } finally {
    releaseControl?.();
    releaseAnswer?.();
    await prisma.$transaction(async (tx) => {
      await tx.systemModelPolicy.update({ where: { id: "installation" }, data: {
        providerModelId: priorRoles.providerModelId, reasoningEffort: priorRoles.reasoningEffort,
        chatTitleProviderModelId: priorRoles.chatTitleProviderModelId, chatTitleReasoningEffort: priorRoles.chatTitleReasoningEffort,
        chatPdfProviderModelId: priorRoles.chatPdfProviderModelId, chatPdfReasoningEffort: priorRoles.chatPdfReasoningEffort,
        version: priorRoles.version
      } });
      await tx.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: priorMemory });
      await tx.modelPolicy.update({ where: { id: "installation" }, data: {
        defaultProviderModelId: priorPolicy.defaultProviderModelId, reasoningEffort: priorPolicy.reasoningEffort, version: priorPolicy.version
      } });
      await tx.usageEvent.deleteMany({ where: { userId } });
      await tx.memoryMutationAuthorization.deleteMany({ where: { userId } });
      await tx.memoryJob.deleteMany({ where: { userId } });
      await tx.memoryExecutionBinding.deleteMany({ where: { userId } });
      await tx.memoryFeedback.deleteMany({ where: { userId } });
      await tx.memorySuppression.deleteMany({ where: { userId } });
      await tx.memoryOperationReceipt.deleteMany({ where: { userId } });
      await tx.memoryRetrievalAttemptItem.deleteMany({ where: { userId, recallChunkId: { not: null } } });
      await tx.memoryRecallChunk.deleteMany({ where: { userId } });
      await tx.chatMemoryCheckpointMessage.deleteMany({ where: { userId } });
      await tx.chat.deleteMany({ where: { userId } });
      await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await tx.user.deleteMany({ where: { id: userId } });
      if (setup) {
        const connectionId = setup.connectionId;
        await tx.accessGrant.deleteMany({ where: { OR: [{ providerConnectionId: connectionId }, { providerModel: { connectionId } }] } });
        await tx.providerUserCredentialAssignment.deleteMany({ where: { connectionId } });
        await tx.providerDraftCheck.deleteMany({ where: { connectionId } });
        await tx.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
        await tx.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: null } });
        await tx.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
        await tx.providerCredentialVersion.deleteMany({ where: { credential: { connectionId } } });
        await tx.providerCredential.deleteMany({ where: { connectionId } });
        await tx.providerModel.deleteMany({ where: { connectionId } });
        await tx.providerConnection.delete({ where: { id: connectionId } });
      }
    });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
