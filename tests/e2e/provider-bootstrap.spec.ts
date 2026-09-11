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

/** Actual HTTP adapters and database publication; only the upstream is local. */
test("one key save activates models, fills empty defaults and retries failed Search", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const connectionId = randomUUID();
  const modelId = randomUUID();
  const policy = adminProviderQuickSetupPolicy("openai");
  const candidate = policy.candidates.find(({ recommended }) => recommended)!;
  const priorChat = await prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorRoles = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const priorSearch = await prisma.searchPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  let failSearch = true;
  let failPdf = true;
  let failJsonOnce = true;
  const capabilityCalls: Array<{ model: unknown; check: string }> = [];
  let searchCalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.headers.authorization !== "Bearer bootstrap-local-key") {
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
      if (search) {
        searchCalls += 1;
        if (failSearch) {
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
          return;
        }
      }
      const source = { title: "Fixture source", url: "https://example.com/fixture" };
      const wire = JSON.stringify(body);
      const check = wire.includes('"type":"input_file"') ? "pdf" : wire.includes('"type":"input_image"') ? "vision"
        : wire.includes('"type":"json_schema"') ? "json" : tools?.[0]?.name ?? (body.stream ? "stream" : "access");
      if (!search) capabilityCalls.push({ model: body.model, check });
      if (check === "json" && body.model === "gpt-5.6-terra" && failJsonOnce) {
        failJsonOnce = false;
        response.writeHead(503, { "content-type": "application/json" }); response.end("{}"); return;
      }
      if (check === "pdf" && body.model === "gpt-6-astra" && failPdf) {
        send({ id: "resp-fixture", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } }); return;
      }
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
    await prisma.searchPolicy.update({ where: { id: "installation" }, data: {
      defaultPlan: { mode: "all_selected", optionIds: [] }, version: 1, updatedByUserId: null
    } });
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: { defaultProviderModelId: null, reasoningEffort: null } });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      providerModelId: null, reasoningEffort: null, chatPdfProviderModelId: null, chatPdfReasoningEffort: null
    } });
    await prisma.providerConnection.create({ data: {
      id: connectionId, displayName: "Bootstrap OpenAI", family: "openai", enabled: false,
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
    await expect(form.getByLabel("Label", { exact: true })).toHaveValue("Main");
    const key = form.getByLabel("API key", { exact: true });
    await expect(key).toBeFocused();
    await expect(key).toHaveAttribute("type", "text");
    expect(await key.evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-text-security"))).toBe("disc");
    await key.fill("rejected-fixture-key");
    await form.getByRole("button", { name: "Test & Save" }).click();
    await expect(form.getByRole("alert")).toBeVisible();
    expect((await read()).credentials).toHaveLength(0);
    expect((await read()).activeVersion).toBe(0);
    await key.fill("bootstrap-local-key");
    await form.getByRole("button", { name: "Test & Save" }).click();
    await expect(form).toHaveCount(0);
    await expect.poll(async () => (await read()).checkRun?.state, { timeout: 60_000 }).toBe("completed");
    const checked = await read();
    expect(checked.enabled).toBe(true);
    expect(checked.models).toHaveLength(2);
    expect(checked.models.every((model) => model.enabled && model.activeVersion > 0)).toBe(true);
    expect(checked.checkRun).toMatchObject({ total: 2, setup: { state: "partial", search: "failed" } });
    expect(checked.checkRun?.failed).toHaveLength(1);
    const partial = checked.activeChecks.find((check) => check.evidence?.capabilitySetup?.checks.directPdf === "incomplete");
    expect(partial?.evidence?.capabilitySetup).toMatchObject({ checks: { modelAccess: "verified", streaming: "verified" },
      attempts: { directPdf: { attempts: 2, reason: "budget_exhausted" } } });
    expect(checked.activeChecks.some((check) => check.evidence?.capabilitySetup?.attempts?.structuredOutput?.attempts === 2)).toBe(true);
    expect(await prisma.searchPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({
      defaultPlan: { mode: "all_selected", optionIds: [] }, version: 1, updatedByUserId: null
    });
    expect(checked.models.map(({ activeConfig }) => activeConfig?.upstreamModelId)).toContain("gpt-6-astra");
    await expect(page.getByRole("button", { name: "Retry checks" })).toBeVisible();
    failSearch = false;
    failPdf = false;
    capabilityCalls.length = 0;
    await page.getByRole("button", { name: "Retry checks" }).click();
    await expect.poll(async () => (await read()).checkRun?.setup, { timeout: 60_000 })
      .toMatchObject({ search: "ready", state: "completed" });
    await expect(page.getByText("Search checked and ready.", { exact: true })).toBeVisible();
    expect(capabilityCalls).toEqual([{ model: "gpt-6-astra", check: "pdf" }]);
    expect((await read()).checkRun?.failed).toEqual([]);
    await expect(page.getByRole("group", { name: "Model setup summary" })).toContainText("2 of 2 model results saved.");
    expect(searchCalls).toBeGreaterThanOrEqual(2);
    expect(await prisma.modelPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({ defaultProviderModelId: modelId });
    expect(await prisma.systemModelPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({
      providerModelId: modelId, chatPdfProviderModelId: modelId
    });
    const search = await prisma.searchOption.findFirstOrThrow({ where: { sourceConnectionId: connectionId },
      include: { strategies: { include: { activeRevision: true } } } });
    expect(search.enabled).toBe(true);
    expect(search.strategies.some(({ activeRevision }) => activeRevision !== null)).toBe(true);
    expect(await prisma.searchPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({
      defaultPlan: { mode: "all_selected", optionIds: [search.optionId] }, version: 2
    });
    const selectOff = await page.request.patch("/api/admin/search", { data: {
      defaultPlan: { mode: "all_selected", optionIds: [] }, expectedVersion: 2
    } });
    expect(selectOff.ok()).toBe(true);
    const enableAgain = await page.request.post(`/api/admin/search/${search.id}/actions`, {
      data: { action: "enable" }
    });
    expect(enableAgain.ok()).toBe(true);
    expect(await prisma.searchPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({
      defaultPlan: { mode: "all_selected", optionIds: [] }, version: 3
    });
    await page.reload();
    await expect(page.getByTestId("provider-page-status")).not.toContainText("Disabled");
    expect((await read()).credentials).toHaveLength(1);
    for (const theme of ["light", "dark"] as const) {
      await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
      await page.emulateMedia({ colorScheme: theme });
      for (const viewport of [
        { width: 1440, height: 900 }, { width: 1024, height: 768 },
        { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 844, height: 390 }
      ]) {
        await page.setViewportSize(viewport);
        await page.goto("/admin?section=providers&resource=" + connectionId);
        await expect(page.getByTestId("provider-page")).toBeVisible({ timeout: 30_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const model of checked.models) {
          const row = page.getByTestId("provider-model-" + model.id);
          const toggle = await row.getByRole("switch").boundingBox();
          expect(toggle).not.toBeNull();
          expect(toggle!.x).toBeGreaterThanOrEqual(0);
          expect(toggle!.x + toggle!.width).toBeLessThanOrEqual(viewport.width);
          const capabilities = row.getByTestId("provider-model-" + model.id + "-works-with");
          expect(await capabilities.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
        await page.screenshot({ path: testInfo.outputPath("bootstrap-" + theme + "-" + viewport.width + ".png"), fullPage: true });
        await page.goto("/admin?section=roles");
        const knowledgeStatus = page.getByTestId("admin-knowledge-state");
        await expect(knowledgeStatus).toBeVisible({ timeout: 30_000 });
        const chip = await knowledgeStatus.boundingBox();
        const group = await page.getByTestId("admin-role-knowledge").boundingBox();
        expect(chip).not.toBeNull();
        expect(group).not.toBeNull();
        expect(chip!.x).toBeGreaterThanOrEqual(group!.x);
        expect(chip!.x + chip!.width).toBeLessThanOrEqual(group!.x + group!.width);
        expect(await knowledgeStatus.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (viewport.width >= 1280) {
          const memoryStatus = await page.getByTestId("admin-role-memory-status").boundingBox();
          expect(memoryStatus).not.toBeNull();
          expect(Math.abs(chip!.x - memoryStatus!.x)).toBeLessThanOrEqual(1);
        }
        await page.screenshot({ path: testInfo.outputPath("roles-" + theme + "-" + viewport.width + ".png"), fullPage: true });
      }
    }
  } finally {
    await prisma.modelPolicy.update({ where: { id: "installation" }, data: priorChat });
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      ...priorRoles, imageParamsJson: priorRoles.imageParamsJson as Prisma.InputJsonValue
    } });
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
