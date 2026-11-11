/**
 * MCP oversized call isolation on the fake provider: a `tools/call` whose
 * own response exceeds the client's transport bound (but not the per-call
 * result ceiling, `MCP_CALL_RESULT_CEILING_BYTES`) is still read and arrives
 * as an ordinary completed call, cut to the result limit with the truncation
 * marker, its tail undelivered; the tool is dispatched once, and the next
 * call on the same server succeeds over the same MCP session (no
 * re-initialize, no eviction). The scripted `[AIQSA_MCP_E2E:<tool>:<id>]`
 * turn makes exactly one call per run, so the two calls are two turns of one
 * chat; the paid spec (prod-1018-paid.spec.ts) proves the same within one
 * run, and mcp-wire-limit-truncation.spec.ts the same with the default limits.
 *
 * The stand's app must run with AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES
 * lowered (32768 recommended, 4096..65536), set in the Playwright process
 * environment so Playwright's webServer passes it to `next dev`; a reused
 * server (PLAYWRIGHT_REUSE_SERVER=1) must already run with the same value.
 * That value is the delivered result limit and the transport accepts twice
 * it, so the synthetic thread (four times the value) is over the wire bound
 * and the small message is not.
 *
 * Oracles are the synthetic peer's dispatches and session counts and the
 * persisted tool calls (status, truncation sizes, marker, tail token), never
 * wording beyond the scripted fake answer.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { signInWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { activeChatId, disableMemoryRecall, lastAnswer, selectFakeModel } from "./support/workspace";

const configuredLimit = Number(process.env.AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES?.trim() || Number.NaN);
const limitLowered = Number.isSafeInteger(configuredLimit) && configuredLimit >= 4_096 && configuredLimit <= 65_536;
test.skip(!limitLowered, "requires AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES between 4096 and 65536 on the stand");

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const BIG_TOOL = "read_thread";
const SMALL_TOOL = "read_message";
/** The client's marker opens with this stable English text (`lib/server/mcp/resultTruncation.ts`). */
const MARKER_PREFIX = "[Result truncated: the MCP tool returned ";
/** Codes the oversized call used to fail with, or cascade into on the next call. */
const CASCADE_CODES = ["mcp_call_result_too_large", "mcp_response_too_large", "mcp_session_closed", "mcp_session_evicted",
  "mcp_server_unavailable"];

/** Four times the delivered-result limit (over the transport bound, twice it), ending in a unique tail token. */
function oversizedThread(tail: string): string {
  const line = "Synthetic message: a routine status note about a fictional project, with nothing to act on.\n";
  return `${line.repeat(Math.ceil((configuredLimit * 4) / Buffer.byteLength(line)))}${tail}\n`;
}

type Dispatch = Readonly<{ initializedSessions: number; name: string }>;

/** A synthetic mail peer whose every call records how many sessions it had initialized by then. */
async function startMailEndpoint(tail: string): Promise<{ dispatches: Dispatch[]; endpoint: MutableMcpEndpoint }> {
  const dispatches: Dispatch[] = [];
  const thread = oversizedThread(tail);
  let endpoint: MutableMcpEndpoint | null = null;
  const idSchema = { additionalProperties: false, properties: { id: { maxLength: 64, type: "string" } }, required: ["id"],
    type: "object" as const };
  const callTool = (name: string): CallToolResult => {
    dispatches.push({ initializedSessions: endpoint?.counts.initialize ?? -1, name });
    if (name === BIG_TOOL) return { content: [{ text: thread, type: "text" }] };
    if (name === SMALL_TOOL) return { content: [{ text: "Synthetic message: the status note is unchanged.", type: "text" }] };
    return { content: [{ text: "Unknown synthetic tool.", type: "text" }], isError: true };
  };
  endpoint = await startMutableMcpEndpoint([
    { annotations: { readOnlyHint: true }, description: "Read one synthetic mail thread with every message in full.",
      inputSchema: idSchema, name: BIG_TOOL },
    { annotations: { readOnlyHint: true }, description: "Read one synthetic mail message.", inputSchema: idSchema, name: SMALL_TOOL }
  ], { callTool });
  return { dispatches, endpoint };
}

async function publishServer(page: Page, endpoint: MutableMcpEndpoint, name: string, userId: string): Promise<string> {
  const created = await page.request.post("/api/admin/mcp", { data: {
    activate: false,
    description: "Synthetic mail server for oversized call isolation",
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 20_000, startupTimeoutMs: 10_000 }, slots: [],
      source: { allowPrivateNetwork: true, kind: "remote", url: endpoint.url }, transport: "streamable_http" },
    name,
    sharedValues: {}
  } });
  expect(created.status()).toBe(201);
  const server = (await created.json() as { server: AdminMcpServer }).server;
  const checked = await page.request.post(`/api/admin/mcp/${server.id}/test`, { data: {
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true
  } });
  expect(checked.status()).toBe(200);
  expect((await page.request.put(`/api/admin/mcp/${server.id}/grants`, { data: {
    canUse: true, personalSlotKeys: [], userId
  } })).ok()).toBe(true);
  expect((await page.request.patch(`/api/me/mcp/${server.id}`, { data: { enabled: true } })).ok()).toBe(true);
  return server.id;
}

/**
 * A new chat on the Fake QSA model (a paid spec on the same stand may have made a real
 * model the default) that lists its MCP tools up front (Load all), which the scripted
 * call needs, with Workspace off.
 */
async function newChat(page: Page) {
  await page.goto("/");
  await selectFakeModel(page);
  const mcpMode = page.getByRole("button", { name: "Change MCP mode" });
  await expect(mcpMode).toBeVisible({ timeout: 30_000 });
  await mcpMode.click();
  await page.getByRole("menu", { name: "MCP tools" }).getByRole("menuitemradio", { name: /^Load all/u }).click();
  await expect(mcpMode).toHaveAccessibleDescription(/^MCP: Load all/u);
}

async function send(page: Page, text: string, answer: string) {
  const message = page.getByRole("textbox", { exact: true, name: "Message" });
  await message.fill(text);
  await message.press("Enter");
  await expect(lastAnswer(page)).toContainText(answer, { timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
}

type PersistedResult = Readonly<{
  content?: Array<{ text?: unknown }>;
  rawPreview?: { deliveredBytes?: unknown; originalBytes?: unknown; truncated?: unknown };
  status?: unknown;
}>;
const texts = (result: unknown) => ((result ?? {}) as PersistedResult).content
  ?.flatMap((part) => typeof part.text === "string" ? [part.text] : []) ?? [];

test("an over-bound MCP response arrives cut with a marker, and the server's session keeps answering", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const tail = `TAIL-${randomUUID().slice(0, 8)}-NOT-DELIVERED`;
  const { dispatches, endpoint } = await startMailEndpoint(tail);
  const chatIds = new Set<string>();
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    serverId = await publishServer(page, endpoint, `Oversized mail ${randomUUID().slice(0, 8)}`, userId);
    await newChat(page);

    await send(page, `Read thread t-1 [AIQSA_MCP_E2E:${BIG_TOOL}:t-1]`, "MCP call finished: done.");
    const chatId = await activeChatId(page);
    chatIds.add(chatId);
    await send(page, `Read message m-1 [AIQSA_MCP_E2E:${SMALL_TOOL}:m-1]`, "MCP call finished: done.");

    const runs = await db().modelRun.findMany({ orderBy: { createdAt: "asc" }, where: { chatId },
      select: { errorPayload: true, id: true, status: true,
        toolCalls: { select: { result: true, state: true, toolName: true }, where: { mcpRunBindingId: { not: null } } } } });
    expect(runs.map((run) => run.status)).toEqual(["complete", "complete"]);
    const [oversized] = runs[0]!.toolCalls;
    const [following] = runs[1]!.toolCalls;
    expect(runs[0]!.toolCalls).toHaveLength(1);
    expect(runs[1]!.toolCalls).toHaveLength(1);
    expect(oversized!.toolName).toContain(BIG_TOOL);
    expect(oversized!.state, "the over-bound call settled as an ordinary completed call").toBe("complete");
    const cut = oversized!.result as PersistedResult | null;
    expect(cut?.status, "its result is complete, not an error").toBe("complete");
    expect(cut?.rawPreview?.truncated, "the result carries the truncation flag").toBe(true);
    expect(cut?.rawPreview?.originalBytes, "the original size is over the transport bound").toBeGreaterThan(2 * configuredLimit);
    expect(cut?.rawPreview?.deliveredBytes, "the delivered size fits the limit").toBeLessThanOrEqual(configuredLimit);
    expect(texts(cut).at(-1)?.startsWith(MARKER_PREFIX), "the delivered result ends with the truncation marker").toBe(true);
    expect(JSON.stringify(cut).includes(tail), "the cut tail was not delivered").toBe(false);
    expect(following!.toolName).toContain(SMALL_TOOL);
    expect((following!.result as PersistedResult | null)?.status, "the next call on the same server succeeded").toBe("complete");
    const serialized = JSON.stringify(runs.map((run) => ({ calls: run.toolCalls.map((call) => call.result), error: run.errorPayload })));
    expect(CASCADE_CODES.filter((code) => serialized.includes(code)), "no call or session failure in either run").toEqual([]);

    // Each call was sent once; the following one reused the session the oversized one ran on.
    expect(dispatches.map((entry) => entry.name)).toEqual([BIG_TOOL, SMALL_TOOL]);
    expect(dispatches[1]!.initializedSessions, "no session was initialized again after the oversized call")
      .toBe(dispatches[0]!.initializedSessions);
    expect(endpoint.openSessions(), "the session was not closed").toBeGreaterThan(0);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    for (const chatId of chatIds) await deleteOwnedChatPermanently(page.request, chatId).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/me/mcp-consents/${serverId}`).catch(() => undefined);
    if (serverId) await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
    await endpoint.close();
  }
});
