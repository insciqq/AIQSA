import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { AdminProviderCustomSetupReadyResult } from "../../lib/contracts/adminProviderCustomSetup";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { setWorkspaceDefault } from "./support/chatDefaults";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { disableMemoryRecall, lastAnswer, startNewChat } from "./support/workspace";
import { chooseSearchStrategy, selectModel } from "./shell/composer";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const ANSWER = "Observability fixture answer.";
/** The recorder writes 5 s after start and every 30 s after that. */
const TELEMETRY_FLUSH_TIMEOUT_MS = 75_000;

type ProviderMode = "ok" | 401 | 503;

async function send(page: Page, prompt: string): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 60_000 });
}

async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function telemetryCount(connectionId: string, code: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: bigint | null }>>`
    SELECT sum("count") AS total FROM "TelemetryCounter"
    WHERE "event" = 'provider_operation' AND "dimensions"->>'connectionId' = ${connectionId}
      AND "dimensions"->>'code' = ${code}`;
  return Number(rows[0]?.total ?? 0);
}

test("a provider that starts rejecting its key surfaces in the answer, Needs attention, the shell badge and Health", async ({ page }, testInfo) => {
  test.setTimeout(420_000);
  page.setDefaultTimeout(20_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const userId = DEFAULT_BOOTSTRAP_USER_ID;
  const priorSettings = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
  let mode: ProviderMode = "ok";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET") { json(200, { data: [{ id: "fixture/observability" }] }); return; }
      if (request.url !== "/responses") { response.writeHead(404); response.end(); return; }
      // The same shapes a real OpenAI-compatible upstream returns for a revoked key and an outage.
      if (mode === 401) {
        json(401, { error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } });
        return;
      }
      if (mode === 503) { json(503, { error: { message: "The server is overloaded.", type: "server_error" } }); return; }
      const text = body.text?.format ? JSON.stringify({ ready: true, count: 2, label: "OK", tool_ids: ["alpha", "beta"] })
        : JSON.stringify(body.input).includes("input_image") || JSON.stringify(body.input).includes("input_file") ? "PEARS"
        : JSON.stringify(body.input).includes("Observability fixture") ? ANSWER : "OK";
      const completed = { id: `fixture-${Date.now()}`, status: "completed", model: body.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (!body.stream) { json(200, completed); return; }
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
    await disableMemoryRecall(page);
    const created = await page.request.post("/api/admin/providers/custom-setup", { timeout: 90_000, data: {
      allowPrivateNetwork: true, apiRoot: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authenticationMode: "none", confirmPaidRequest: true, connectionDisplayName: "Observability fixture provider",
      modelIds: ["fixture/observability"], protocol: "responses", responseTimeoutSeconds: 30
    } });
    expect(created.ok(), await created.text()).toBe(true);
    setup = await created.json() as AdminProviderCustomSetupReadyResult;
    const connectionId = setup.connectionId;
    const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId } });
    await setWorkspaceDefault(page.request, false);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await startNewChat(page);
    await selectModel(page, connectionId, model.displayName!);
    if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
    await send(page, "Observability fixture before the key is revoked");
    await expect(lastAnswer(page)).toContainText(ANSWER);

    // The upstream starts rejecting the key: the answer names the cause and an error reference.
    mode = 401;
    await send(page, "Observability fixture after the key is revoked");
    const failed = lastAnswer(page);
    await expect(failed).toContainText("The model provider rejected the configured credentials (HTTP 401)");
    await expect(failed).toContainText("Ask an administrator to check the provider key.");
    const reference = failed.getByTestId("run-error-reference");
    await expect(reference).toBeVisible();
    const shortReference = (await reference.locator("code").first().innerText()).trim();
    expect(shortReference).toMatch(/^[0-9a-f]{8}$/u);
    const failedRun = await prisma.$queryRaw<Array<{ id: string; code: string | null }>>`
      SELECT id, "errorPayload"->>'code' AS code FROM "ModelRun"
      WHERE "userId" = ${userId} AND status = 'error' AND starts_with(id, ${shortReference})`;
    expect(failedRun).toEqual([expect.objectContaining({ code: "provider_auth_rejected" })]);
    await failed.scrollIntoViewIfNeeded();
    await shoot(page, testInfo, "chat-key-rejected-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await failed.scrollIntoViewIfNeeded();
    await shoot(page, testInfo, "chat-key-rejected-phone");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Within one telemetry flush the rejection is counted for this connection.
    await expect.poll(() => telemetryCount(connectionId, "provider_auth_rejected"),
      { timeout: TELEMETRY_FLUSH_TIMEOUT_MS, intervals: [2_000] }).toBeGreaterThan(0);

    await page.goto("/admin?section=overview");
    const keyItem = page.getByTestId("admin-attention-item").filter({ hasText: "Observability fixture provider" })
      .filter({ hasText: "rejected its key" });
    await expect(keyItem).toBeVisible();
    await shoot(page, testInfo, "overview-key-rejected-desktop");

    // The chat shell shows an administrator badge (the summary is cached up to a minute).
    await expect.poll(async () => {
      await page.goto("/");
      return page.getByTestId("admin-attention-dot").count();
    }, { timeout: 90_000, intervals: [10_000] }).toBeGreaterThan(0);
    await expect(page.getByRole("link", { name: /^Control Center, \d+ items? needs? attention$/u })).toBeVisible();
    await shoot(page, testInfo, "shell-badge-desktop");

    // Health: provider reliability and the incident, found by the user's reference.
    for (const [name, size] of [["desktop", { width: 1440, height: 900 }], ["tablet-portrait", { width: 820, height: 1180 }],
      ["tablet-landscape", { width: 1180, height: 820 }], ["phone-portrait", { width: 390, height: 844 }],
      ["phone-landscape", { width: 844, height: 390 }]] as const) {
      await page.setViewportSize(size);
      await page.goto("/admin?section=health");
      await expect(page.getByTestId("admin-health-summary")).toBeVisible();
      await expect(page.getByTestId("admin-health-providers")).toContainText("Observability fixture provider");
      await shoot(page, testInfo, `health-${name}-light`);
      if (name === "desktop" || name === "phone-portrait") {
        await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
        await shoot(page, testInfo, `health-${name}-dark`);
        await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin?section=health");
    const incidents = page.getByTestId("admin-health-incidents");
    await incidents.getByRole("searchbox", { name: "Run or trace id" }).fill(shortReference);
    await incidents.getByRole("button", { name: "Search" }).click();
    const lookup = page.getByTestId("admin-health-run-lookup");
    await expect(lookup).toContainText("provider_auth_rejected");
    await expect(lookup).toContainText("Observability fixture provider");
    await expect(page.getByTestId("admin-health-incident").first()).toContainText("provider_auth_rejected");
    await lookup.scrollIntoViewIfNeeded();
    await shoot(page, testInfo, "health-reference-lookup-desktop");

    // An outage is named as a server error, then a recovered key clears the key item.
    await page.goto("/");
    await startNewChat(page);
    await selectModel(page, connectionId, model.displayName!);
    if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
    mode = 503;
    await send(page, "Observability fixture during an outage");
    await expect(lastAnswer(page)).toContainText("The model provider returned a server error (HTTP 503)");
    mode = "ok";
    await send(page, "Observability fixture after the key is replaced");
    await expect(lastAnswer(page)).toContainText(ANSWER);
    await expect.poll(async () => {
      await page.goto("/admin?section=overview");
      await expect(page.getByRole("heading", { name: "Needs attention" })).toBeVisible();
      return page.getByTestId("admin-attention-item").filter({ hasText: "Observability fixture provider" })
        .filter({ hasText: "rejected its key" }).count();
    }, { timeout: TELEMETRY_FLUSH_TIMEOUT_MS, intervals: [10_000] }).toBe(0);
  } finally {
    mode = "ok";
    if (setup) {
      const connectionId = setup.connectionId;
      await prisma.$transaction(async (tx) => {
        await tx.userSettings.update({ where: { userId }, data: { defaultProviderModelId: priorSettings.defaultProviderModelId,
          defaultControlValues: priorSettings.defaultControlValues as Prisma.InputJsonValue,
          defaultWorkspaceEnabled: priorSettings.defaultWorkspaceEnabled } });
        const runs = await tx.modelRun.findMany({ where: { userId, providerRunBindings: { some: { connectionId } } }, select: { id: true, chatId: true } });
        const chats = await tx.chat.findMany({ where: { userId, defaultProviderModel: { connectionId } }, select: { id: true } });
        const chatIds = [...new Set([...chats.map(({ id }) => id), ...runs.map(({ chatId }) => chatId)])];
        await tx.providerRunBinding.deleteMany({ where: { connectionId } });
        await tx.modelRun.deleteMany({ where: { id: { in: runs.map(({ id }) => id) } } });
        await tx.memoryJob.deleteMany({ where: { userId, chatId: { in: chatIds } } });
        await tx.memoryRetrievalAttempt.deleteMany({ where: { userId, chatId: { in: chatIds } } });
        await tx.memoryRecallChunk.deleteMany({ where: { userId, chatId: { in: chatIds } } });
        await tx.chat.deleteMany({ where: { userId, id: { in: chatIds } } });
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
        // Telemetry of this fixture connection would otherwise keep raising items for later specs.
        await tx.$executeRaw`DELETE FROM "TelemetryCounter" WHERE "dimensions"->>'connectionId' = ${connectionId}`;
        await tx.$executeRaw`DELETE FROM "TelemetryIncident" WHERE "connectionId" = ${connectionId}`;
      });
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
