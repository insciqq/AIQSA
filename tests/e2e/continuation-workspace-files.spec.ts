import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { LOCAL_OPERATOR_EMAIL, LOCAL_OPERATOR_PASSWORD } from "../../prisma/local-seed-auth";
import {
  activeChatId,
  loginWithPassword,
  selectFakeModel,
  sendAndExpect,
  startNewChat
} from "./support/workspace";

const prisma = new PrismaClient();

test.afterAll(() => prisma.$disconnect());
test.setTimeout(240_000);

test("continues a Workspace chat with its project files and runs in the new chat", async ({ page }) => {
  const policy = await prisma.workspacePolicy.findUniqueOrThrow({
    select: { enabled: true },
    where: { id: "installation" }
  });
  let sourceChatId: string | null = null;
  let destinationChatId: string | null = null;
  let connectionId: string | null = null;
  const previousSystemModel = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" },
    select: { providerModelId: true, reasoningEffort: true } });
  // Summary admission uses a real structured-output protocol. Its tiny local
  // provider keeps this ordinary browser test independent of paid services.
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/continuation" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const probe = body.tools?.find((tool: { name?: string }) => tool.name?.startsWith("aiqsa_"));
      const text = body.text?.format?.schema?.properties?.summary
        ? JSON.stringify({ summary: "Continue the previous file task. Verify the current files with tools." })
        : body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] })
          : JSON.stringify(body.input).includes("input_image") || JSON.stringify(body.input).includes("input_file") ? "PEARS" : "Fixture answer.";
      const output = probe ? (probe.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
        type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: probe.name,
        arguments: JSON.stringify({ city }), status: "completed"
      })) : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
      const completed = { id: randomUUID(), status: "completed", model: body.model, output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
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

  try {
    await prisma.workspacePolicy.update({ where: { id: "installation" }, data: { enabled: true } });
    await loginWithPassword(page, { email: LOCAL_OPERATOR_EMAIL, password: LOCAL_OPERATOR_PASSWORD });
    const configured = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Continuation fixture",
      modelIds: ["fixture/continuation"], protocol: "responses", responseTimeoutSeconds: 30
    } });
    expect(configured.ok()).toBe(true);
    const setup = await configured.json();
    expect(setup.outcome).toBe("ready");
    connectionId = setup.connectionId;
    const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId: connectionId! } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: model.id, reasoningEffort: null, version: { increment: 1 }
    } });
    await page.request.post("/api/auth/logout", { data: {} });
    await loginWithPassword(page, LOCAL_MCP_MEMBER);
    await startNewChat(page);
    await selectFakeModel(page);
    const workspaceDetails = page.getByRole("button", { name: /Workspace details/u });
    await workspaceDetails.click();
    const workspaceOn = page.getByRole("menuitemcheckbox", { name: /Turn off Workspace/u });
    if (!(await workspaceOn.isVisible())) {
      await page.getByRole("menuitemcheckbox", { name: /Turn on Workspace/u }).click();
    }
    await page.keyboard.press("Escape");
    await expect(workspaceDetails).toHaveAccessibleName(/Workspace details\. On/u);

    // The deterministic provider writes this file into the project disk.
    await page.getByLabel("Attach files").setInputFiles({
      buffer: Buffer.from("continuation input\n"),
      mimeType: "text/plain",
      name: "continuation-input.txt"
    });
    await sendAndExpect(
      page,
      "[AIQSA_WORKSPACE_E2E:deterministic_prepare]",
      "Workspace read the staged input and created result.zip"
    );
    sourceChatId = await activeChatId(page);
    const sourceSession = await prisma.workspaceSession.findUniqueOrThrow({
      select: { runtimeSandboxId: true, state: true },
      where: { chatId: sourceChatId }
    });
    expect(sourceSession.runtimeSandboxId).toBeTruthy();
    expect(["READY", "STOPPED"]).toContain(sourceSession.state);

    const indicator = page.getByTestId("header-context-indicator");
    await expect(indicator).toBeVisible();
    if (await indicator.getAttribute("aria-expanded") !== "true") await indicator.click();
    const dialog = page.getByRole("dialog", { name: "Chat context" });
    await expect(dialog).toContainText("project files are copied into the new chat");
    const continuationResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/chats/${sourceChatId}/continue`), { timeout: 90_000 });
    await dialog.getByRole("button", { name: "Summarize and open new chat" }).click();
    expect((await continuationResponse).status()).toBe(200);

    await expect.poll(async () => page.evaluate(() => window.localStorage.getItem("aiqsa.activeChatId")), {
      timeout: 90_000
    }).not.toBe(sourceChatId);
    destinationChatId = await activeChatId(page);
    expect(destinationChatId).not.toBe(sourceChatId);
    await expect(page.getByRole("link", { name: "Previous chat" })).toBeVisible({ timeout: 30_000 });
    const destinationWorkspaceDetails = page.getByRole("button", { name: /Workspace details/u });
    await expect(destinationWorkspaceDetails).toHaveAccessibleName(/Workspace details\. On/u);
    await destinationWorkspaceDetails.click();
    await expect(page.getByRole("menuitemcheckbox", { name: /Turn off Workspace/u })).toBeVisible();
    await page.keyboard.press("Escape");

    // Restoration is performed as part of the first run in the destination.
    await sendAndExpect(page, "[AIQSA_WORKSPACE_E2E:state_probe]", "Workspace state persisted.");
    const activity = page.getByTestId("tool-activity-disclosure").last();
    if (await activity.getAttribute("open") === null) await activity.locator(":scope > summary").click();
    await expect(activity).toContainText("Read project/persisted.txt");

    const destination = await prisma.chat.findUniqueOrThrow({
      select: { workspaceEnabled: true },
      where: { id: destinationChatId }
    });
    expect(destination.workspaceEnabled).toBe(true);
    await expect.poll(async () => (await prisma.chatContinuationWorkspaceSeed.findFirstOrThrow({
      select: { status: true },
      where: { newChatId: destinationChatId }
    })).status).toBe("RESTORED");

    // Exercise the server-projected copy states at both widths, without
    // changing the successfully restored disk or replaying the continuation.
    let projection: { status: string; reason?: string } = { status: "ready" };
    await page.route(`**/api/chats/${destinationChatId}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.chat.workspace.continuationFiles = projection;
      await route.fulfill({ response, json: body });
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [value, message] of [
        [{ status: "ready" }, "files were restored in this chat"],
        [{ status: "pending" }, "files are waiting to be restored"],
        [{ status: "none" }, "had no Workspace project disk to copy"],
        [{ status: "failed", reason: "timeout" }, "copy exceeded its time budget"]
      ] as const) {
        projection = value;
        await page.reload();
        const stateIndicator = page.getByTestId("header-context-indicator");
        if (await stateIndicator.getAttribute("aria-expanded") !== "true") await stateIndicator.click();
        await expect(page.getByRole("dialog", { name: "Chat context" })).toContainText(message);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    }
  } finally {
    const chatIds = [sourceChatId, destinationChatId].filter((id): id is string => Boolean(id));
    if (chatIds.length) {
      await prisma.$transaction(async (tx) => {
        const runs = await tx.modelRun.findMany({ select: { id: true }, where: { chatId: { in: chatIds } } });
        const runIds = runs.map((run) => run.id);
        const attachments = await tx.attachment.findMany({
          select: { id: true },
          where: { OR: [{ chatId: { in: chatIds } }, ...(runIds.length ? [{ producerModelRunId: { in: runIds } }] : [])] }
        });
        if (runIds.length) {
          // Workspace output attachments restrict deleting their producer run;
          // detach them first, then let the run cascade remove its bindings.
          await tx.attachment.updateMany({ where: { producerModelRunId: { in: runIds } }, data: { producerModelRunId: null } });
        }
        await tx.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.chat.updateMany({ where: { id: { in: chatIds } }, data: { activeLeafMessageId: null } });
        await tx.message.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.workspaceSession.deleteMany({ where: { chatId: { in: chatIds } } });
        if (attachments.length) await tx.attachment.deleteMany({ where: { id: { in: attachments.map((attachment) => attachment.id) } } });
        await tx.chat.deleteMany({ where: { id: { in: chatIds } } });
      });
    }
    await prisma.workspacePolicy.update({ where: { id: "installation" }, data: policy });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { ...previousSystemModel, version: { increment: 1 } } });
    const ownedConnectionId = connectionId;
    if (ownedConnectionId) await prisma.$transaction(async (tx) => {
      const connectionId = ownedConnectionId;
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
    });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
