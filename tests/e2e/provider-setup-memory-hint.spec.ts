import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import type { AdminProviderConnection } from "../../lib/contracts/adminProviders";
import { adminProviderQuickSetupPolicy } from "../../lib/server/admin/providers/quickSetupPolicy";
import { PDF_INPUT_PROBE_ANSWER } from "../../lib/server/providers/pdfInputProbe";
import { VISION_INPUT_PROBE_ANSWER } from "../../lib/server/providers/visionInputProbe";
import { signInWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

/**
 * Native OpenAI has no qualified Memory model: setup finishes with Search
 * ready, offers no Retry and points to the Memory row instead. Actual HTTP
 * adapters and database publication; only the upstream is local.
 */
test("setup without a qualified Memory model finishes with a Memory hint instead of Retry", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const connectionId = randomUUID();
  const modelId = randomUUID();
  const policy = adminProviderQuickSetupPolicy("openai");
  const candidate = policy.candidates.find(({ recommended }) => recommended)!;
  const priorChat = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorMemory = await prisma.memoryUtilityModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorSearch = await prisma.searchPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  let searchCalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.headers.authorization !== "Bearer memory-hint-local-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      const send = (value: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && request.url === "/models") {
        send({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-6-astra" }] });
        return;
      }
      if (request.method !== "POST" || request.url !== "/responses") {
        response.writeHead(404);
        response.end();
        return;
      }
      const reasoning = body.reasoning as { effort?: string } | undefined;
      if (body.model === "gpt-6-astra" && reasoning?.effort === "none") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "unsupported_value" } }));
        return;
      }
      const tools = body.tools as Array<{ type: string; name?: string }> | undefined;
      const search = tools?.some(({ type }) => type.startsWith("web_search"));
      if (search) searchCalls += 1;
      const source = { title: "Fixture source", url: "https://example.com/fixture" };
      const wire = JSON.stringify(body);
      const text = wire.includes('"type":"input_file"') ? PDF_INPUT_PROBE_ANSWER
        : wire.includes('"type":"input_image"') ? VISION_INPUT_PROBE_ANSWER
        : wire.includes('"type":"json_schema"') ? JSON.stringify({ ready: true, count: 2, label: "ready", tool_ids: ["alpha", "beta"] })
        : "OK";
      const output: unknown[] = [{ type: "message", role: "assistant", content: [{
        type: "output_text", text, annotations: search ? [{ ...source, type: "url_citation" }] : []
      }] }];
      if (search) output.unshift({ id: "search-1", type: "web_search_call", status: "completed", action: { type: "search", query: "fixture", sources: [source] } });
      const tool = tools?.find(({ name }) => name?.startsWith("aiqsa_"));
      if (tool) output.splice(0, output.length, ...(tool.name === "aiqsa_parallel_probe" ? ["Oslo", "Rome"] : ["Oslo"]).map((city, index) => ({
        type: "function_call", id: `function-${index}`, call_id: `call-${index}`, name: tool.name,
        arguments: JSON.stringify({ city }), status: "completed"
      })));
      const completed = { id: "resp-fixture", model: body.model, status: "completed", output,
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream", "connection": "close" });
        for (const event of [
          { type: "response.created", response: { id: completed.id, model: body.model, status: "in_progress" } },
          { type: "response.output_text.delta", delta: text },
          { type: "response.completed", response: completed }
        ]) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
        response.end();
      } else send(completed);
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiRoot = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    // A first-key installation: no chat default, no system roles, Memory never chosen.
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: null, reasoningEffort: null } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: null, reasoningEffort: null, chatPdfProviderModelId: null, chatPdfReasoningEffort: null
    } });
    await prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: null, reasoningEffort: null, assignmentSource: "UNASSIGNED"
    } });
    await prisma.providerConnection.create({ data: {
      id: connectionId, displayName: "Memory hint OpenAI", family: "openai", enabled: false,
      draftConfig: { ...policy.connection.configuration, allowPrivateNetwork: true, apiRoot },
      models: { create: {
        id: modelId, provider: "openai", modelId: candidate.configuration.upstreamModelId,
        displayName: candidate.displayName, enabled: false,
        capabilities: candidate.configuration.capabilities as Prisma.InputJsonValue,
        defaultParams: candidate.configuration.defaultParams as Prisma.InputJsonValue,
        draftConfig: candidate.configuration as unknown as Prisma.InputJsonValue
      } }
    } });
    await signInWithLocalToken(page);
    const read = async () => {
      const response = await page.request.get("/api/admin/providers");
      expect(response.ok()).toBe(true);
      const data = await response.json() as { connections: AdminProviderConnection[] };
      return data.connections.find(({ id }) => id === connectionId)!;
    };
    await page.goto("/admin?section=providers&resource=" + connectionId);
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    const form = page.getByTestId("provider-key-form");
    await form.getByLabel("API key", { exact: true }).fill("memory-hint-local-key");
    await form.getByRole("button", { name: "Test & Save" }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(async () => (await read()).checkRun?.state, { timeout: 60_000 }).toBe("completed");
    const checked = await read();
    expect(checked.checkRun?.setup).toMatchObject({ state: "completed", search: "ready", needsConfiguration: ["memory"] });
    expect(checked.checkRun?.failed).toEqual([]);
    expect(searchCalls).toBeGreaterThanOrEqual(1);
    expect(await prisma.memoryUtilityModelPolicy.findUnique({ where: { id: "installation" } }))
      .toMatchObject({ assignmentSource: "UNASSIGNED", providerModelId: null });

    await expect(page.getByText("Search checked and ready.", { exact: true })).toBeVisible();
    const hint = page.getByTestId("provider-setup-memory-hint");
    await expect(hint).toHaveText("Memory needs a model. Choose one in Defaults & roles");
    await expect(page.getByText("Some setup work is unfinished.")).toHaveCount(0);
    await expect(page.getByText(/could not be saved/u)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Retry/u })).toHaveCount(0);
    const link = hint.getByRole("link", { name: "Choose one in Defaults & roles" });
    await expect(link).toHaveAttribute("href", /\?section=roles&resource=memory$/u);

    for (const theme of ["light", "dark"] as const) {
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
      await page.emulateMedia({ colorScheme: theme });
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.goto("/admin?section=providers&resource=" + connectionId);
        await expect(page.getByTestId("provider-setup-memory-hint")).toBeVisible({ timeout: 30_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath("memory-hint-" + theme + "-" + viewport.width + ".png"), fullPage: true });
      }
    }

    await page.getByTestId("provider-setup-memory-hint").getByRole("link", { name: "Choose one in Defaults & roles" }).click();
    await expect(page).toHaveURL(/section=roles&resource=memory/u);
    const row = page.getByTestId("admin-role-memory");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toBeFocused();
    await expect(row.getByTestId("admin-role-memory-status")).toHaveText("Not assigned");
  } finally {
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: priorChat });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      ...priorRoles, imageParamsJson: priorRoles.imageParamsJson as Prisma.InputJsonValue,
      decisionFeaturesJson: priorRoles.decisionFeaturesJson as Prisma.InputJsonValue
    } });
    await prisma.memoryUtilityModelPolicy.update({ where: { id: "installation" }, data: priorMemory });
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: { ...priorSearch,
      defaultPlan: priorSearch.defaultPlan as Prisma.InputJsonValue
    } });
    const options = await prisma.searchOption.findMany({ where: { sourceConnectionId: connectionId }, select: { id: true } });
    const where = { searchOptionId: { in: options.map(({ id }) => id) } };
    const strategies = await prisma.searchStrategy.findMany({ where, select: { id: true } });
    await prisma.searchStrategy.updateMany({ where, data: { activeRevisionId: null } });
    await prisma.searchIntegrationRevision.deleteMany({ where: { searchStrategyId: { in: strategies.map(({ id }) => id) } } });
    await prisma.searchStrategy.deleteMany({ where });
    await prisma.searchOption.deleteMany({ where: { id: { in: options.map(({ id }) => id) } } });
    await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    const credentials = await prisma.providerCredential.findMany({ where: { connectionId }, select: { id: true } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId: { in: credentials.map(({ id }) => id) } } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
