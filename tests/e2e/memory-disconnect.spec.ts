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
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const userId = randomUUID();
  const email = `memory-disconnect-${userId}@example.test`;
  const password = `Synthetic-${randomUUID()}`;
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
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
      const intent = { action: "SAVE", aggregationRequested: false, applyResponsePreferences: false,
        category: "preferences", categoryHint: null, confidenceBand: "HIGH", entityMentions: [], memoryUseful: false,
        patternExclusionRequested: false, pastChatsUseful: false, profileRequested: false, queryDecompositions: [],
        queryText: null, reasonCode: "save_request", recencyRequested: false, referencedMemoryRef: null,
        replacementStatement: null, responsePreference: false, retrievalMode: "TARGETED_CURRENT", sensitiveDomainHint: null,
        sensitivity: "NORMAL", statement, targetQuery: null, temporalAsOf: null, temporalFrom: null,
        temporalIntent: "CURRENT", temporalTo: null, thisChatOnly: false };
      const tool = control ?? probe;
      const output = tool ? (probe?.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
        type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: tool.name,
        arguments: JSON.stringify(control ? intent : { city }), status: "completed"
      })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const completed = { id: randomUUID(), status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (control) {
        controlCalls += 1;
        releaseControl = () => { send(completed); releaseControl = undefined; };
        return;
      }
      if (!body.stream) { send(completed); return; }
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const event of [{ type: "response.created", response: { id: completed.id, status: "in_progress" } },
        { type: "response.output_text.delta", delta: text }, { type: "response.completed", response: completed }]) {
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let setup: AdminProviderCustomSetupReadyResult | undefined;
  try {
    await signInWithLocalToken(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Memory disconnect fixture",
      modelIds: ["fixture/memory"], protocol: "responses", responseTimeoutSeconds: 30
    } });
    expect(response.ok()).toBe(true);
    setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("ready");
    const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId: setup.connectionId } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: model.id, reasoningEffort: null, chatTitleProviderModelId: null, version: { increment: 1 }
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
    await startNewChat(page);
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill(`Remember that ${statement}`);
    await message.press("Enter");
    await expect.poll(() => controlCalls).toBe(1);
    const run = await prisma.modelRun.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    expect(run.status).toBe("preparing");
    const controlBinding = await prisma.memoryExecutionBinding.findFirstOrThrow({ where: { userId, logicalRole: "MEMORY_CONTROL" } });
    expect(controlBinding.state).toBe("RUNNING");
    await page.close();
    const observer = await context.newPage();
    // A real authenticated read also races the repository's recovery entry point.
    await observer.goto(`/?chat=${run.chatId}`);
    await expect(observer.getByTestId("app-shell")).toBeVisible();
    expect((await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("preparing");
    expect((await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: controlBinding.id } })).state).toBe("RUNNING");
    releaseControl!();
    await expect.poll(async () => (await prisma.modelRun.findUniqueOrThrow({ where: { id: run.id } })).status,
      { timeout: 25_000 }).toBe("complete");
    expect(await prisma.memoryOperationReceipt.findMany({ where: { userId, modelRunId: run.id } })).toMatchObject([
      { operation: "SAVE", outcome: "APPLIED" }
    ]);
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE", displayText: statement } })).toBe(1);
    expect(await prisma.modelRunMemoryBinding.findUniqueOrThrow({ where: { modelRunId: run.id } })).toMatchObject({ degradationCode: null });
    expect((await prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: controlBinding.id } })).state).toBe("SUCCEEDED");
    expect(await prisma.memoryJob.count({ where: { userId } })).toBe(0);
    await observer.reload();
    await expect(observer.getByText("Memory saved.", { exact: true })).toBeVisible();
    await expect(observer.getByText("Memory fixture answer.", { exact: true })).toBeVisible();
    await observer.reload();
    await expect(observer.getByText("Memory saved.", { exact: true })).toBeVisible();
    expect(controlCalls).toBe(1);

    // Explicit cancellation is a separate server operation; it must still stop
    // the same preparation while a completed SAVE remains committed.
    await startNewChat(observer);
    await observer.getByRole("textbox", { name: "Message" }).fill("Remember that I prefer coffee in the morning.");
    await observer.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect.poll(() => controlCalls).toBe(2);
    const stopped = await prisma.modelRun.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "desc" } });
    const cancel = await observer.request.post(`/api/model-runs/${stopped.id}/cancel`);
    expect(cancel.status()).toBe(200);
    expect((await cancel.json()).run.status).toBe("cancelled");
    releaseControl!();
    // Cancellation cannot prove what an already dispatched remote call did.
    // Its uncertainty is terminal and must never cause a retry or local SAVE.
    await expect.poll(async () => (await prisma.memoryExecutionBinding.findFirstOrThrow({
      where: { userId, logicalRole: "MEMORY_CONTROL", id: { not: controlBinding.id } }
    })).state).toBe("OUTCOME_UNKNOWN");
    expect(await prisma.memoryOperationReceipt.count({ where: { userId, modelRunId: stopped.id } })).toBe(0);
    expect(await prisma.memoryFactVersion.count({ where: { userId, state: "ACTIVE" } })).toBe(1);
    await observer.goto(`/?chat=${stopped.chatId}`);
    await expect(observer.getByTestId("app-shell")).toBeVisible();
    expect(controlCalls).toBe(2);
  } finally {
    releaseControl?.();
    await prisma.$transaction(async (tx) => {
      await tx.systemModelPolicy.update({ where: { id: "installation" }, data: {
        providerModelId: priorRoles.providerModelId, reasoningEffort: priorRoles.reasoningEffort,
        chatTitleProviderModelId: priorRoles.chatTitleProviderModelId, chatTitleReasoningEffort: priorRoles.chatTitleReasoningEffort,
        chatPdfProviderModelId: priorRoles.chatPdfProviderModelId, chatPdfReasoningEffort: priorRoles.chatPdfReasoningEffort,
        version: priorRoles.version
      } });
      await tx.modelPolicy.update({ where: { id: "installation" }, data: {
        defaultProviderModelId: priorPolicy.defaultProviderModelId, reasoningEffort: priorPolicy.reasoningEffort, version: priorPolicy.version
      } });
      await tx.usageEvent.deleteMany({ where: { userId } });
      await tx.memoryExecutionBinding.deleteMany({ where: { userId } });
      await tx.memoryFeedback.deleteMany({ where: { userId } });
      await tx.memorySuppression.deleteMany({ where: { userId } });
      await tx.memoryOperationReceipt.deleteMany({ where: { userId } });
      await tx.memoryMutationAuthorization.deleteMany({ where: { userId } });
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
