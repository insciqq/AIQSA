import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PDFDocument, PDFName } from "pdf-lib";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { decodeUploadAttachmentResponse } from "../../lib/contracts/uploads";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { createS3StorageAdapter } from "../../lib/server/uploads/storage";
import { signInWithLocalToken } from "./support/localAuth";
import { loginWithPassword, sendAndExpect, startNewChat } from "./support/workspace";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("verified PDF pages survive upload, refresh and Library reuse and admit a large native PDF", async ({ page }) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  // Two actual pages plus an inert, uncompressed stream make a large binary
  // without a large text context. No private PDF is part of this fixture.
  const document = await PDFDocument.create();
  document.addPage();
  document.addPage();
  document.catalog.set(PDFName.of("FixturePadding"), document.context.register(
    document.context.stream(Buffer.alloc(19_087_000, 32))
  ));
  const bytes = Buffer.from(await document.save({ useObjectStreams: false }));
  expect(bytes.length).toBeGreaterThan(19_000_000);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const userId = randomUUID();
  const user = { email: `pdf-budget-${userId}@example.test`, password: `Synthetic-${randomUUID()}` };
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const received: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const send = (value: unknown) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET") { send({ data: [{ id: "fixture/pdf" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      const wire = JSON.stringify(body.input);
      const ordinary = wire.includes("PDF budget fixture question");
      if (ordinary) {
        const file = body.input.flatMap((item: { content?: unknown[] }) => item.content ?? [])
          .find((item: { type?: string }) => item.type === "input_file");
        received.push(createHash("sha256").update(Buffer.from(file.file_data.split(",")[1], "base64")).digest("hex"));
      }
      const text = ordinary ? "PDF budget fixture answer."
        : wire.includes("input_image") || wire.includes("input_file") ? "PEARS"
        : body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] }) : "OK";
      const probe = body.tools?.find((item: { name?: string }) => item.name?.startsWith("aiqsa_"));
      const output = probe && !ordinary
        ? (probe.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
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
  let setup: AdminProviderCustomSetupReadyResult | undefined;
  try {
    await signInWithLocalToken(page);
    const response = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "PDF budget fixture",
      modelIds: ["fixture/pdf"], protocol: "responses", responseTimeoutSeconds: 30,
      perModelCapabilities: { "fixture/pdf": { contextWindow: 1_050_000, defaultMaxOutputTokens: 65_536, maxOutputTokens: 65_536 } }
    } });
    expect(response.ok()).toBe(true);
    setup = await response.json() as AdminProviderCustomSetupReadyResult;
    expect(setup.outcome).toBe("ready");
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { chatTitleProviderModelId: null } });
    const group = await prisma.group.findFirstOrThrow({ where: { systemRole: "full_access" } });
    await prisma.user.create({ data: { id: userId, email: user.email, displayName: "PDF budget fixture", status: "active",
      authIdentities: { create: { normalizedEmail: user.email, provider: "password", providerAccountId: user.email,
        passwordHash: await hashPassword(user.password), emailVerifiedAt: new Date() } } } });
    await prisma.$transaction((tx) => provisionActiveUser(tx, { userId, groups: [{ groupId: group.id, role: "member" }] }));
    await prisma.userSettings.update({ where: { userId }, data: { defaultProviderModelId: setup.providerModelId,
      defaultWorkspaceEnabled: false, defaultSearchPlan: { mode: "all_selected", optionIds: [] } } });
    await prisma.userMemorySettings.update({ where: { userId }, data: { learnAutomatically: false,
      referenceChatHistory: false, useMemoryFacts: false, synthesisEnabled: false } });
    await page.goto("about:blank");
    await page.request.post("/api/auth/logout", { data: {} });
    await loginWithPassword(page, user);
    await startNewChat(page);
    const uploaded = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/uploads" && item.request().method() === "POST");
    await page.getByLabel("Attach files").setInputFiles({ buffer: bytes, mimeType: "application/pdf", name: "two-pages.pdf" });
    const upload = await uploaded;
    expect(upload.ok()).toBe(true);
    const attachment = decodeUploadAttachmentResponse(await upload.json())!.attachment;
    expect(attachment).toMatchObject({ pageCount: 2, extractedText: null, byteSize: bytes.length });
    expect(attachment.processing).toBeUndefined();
    await expect(page.getByTestId("header-context-indicator")).toHaveAccessibleName("Chat context is approximately 0% full");
    const refreshed = await page.request.get(`/api/uploads/${attachment.id}`);
    expect(decodeUploadAttachmentResponse(await refreshed.json())!.attachment.pageCount).toBe(2);
    const saved = await page.request.post(`/api/uploads/${attachment.id}/save`);
    expect(saved.ok()).toBe(true);
    const savedFile = decodeUploadAttachmentResponse(await saved.json())!.attachment;
    expect(savedFile.pageCount).toBe(2);
    await page.getByRole("button", { name: "Remove two-pages.pdf" }).click();
    await page.reload();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: /Saved files/ }).click();
    const reusedResponse = page.waitForResponse((item) => new URL(item.url()).pathname === `/api/uploads/${savedFile.id}/reuse`);
    await page.getByRole("list", { name: "Saved files" }).getByRole("button", { name: "Use file" }).click();
    expect(decodeUploadAttachmentResponse(await (await reusedResponse).json())!.attachment.pageCount).toBe(2);
    await expect(page.getByTestId("header-context-indicator")).toHaveAccessibleName("Chat context is approximately 0% full");
    await sendAndExpect(page, "PDF budget fixture question", "PDF budget fixture answer.");
    expect(received).toEqual([digest]);
    const run = await prisma.modelRun.findFirstOrThrow({ where: { userId } });
    expect(run.status).toBe("complete");
    await page.reload();
    await expect(page.getByText("PDF budget fixture answer.", { exact: true })).toBeVisible();
  } finally {
    try {
      const objects = await prisma.attachment.findMany({ where: { userId }, select: { storageKey: true } });
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
        await tx.modelRun.deleteMany({ where: { userId } });
        await tx.workspaceSession.deleteMany({ where: { chat: { userId } } });
        await tx.chat.deleteMany({ where: { userId } });
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
      const storage = createS3StorageAdapter();
      for (const storageKey of new Set(objects.map((item) => item.storageKey))) {
        expect(await prisma.attachment.count({ where: { storageKey } })).toBe(0);
        await storage.deleteObject(storageKey);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
