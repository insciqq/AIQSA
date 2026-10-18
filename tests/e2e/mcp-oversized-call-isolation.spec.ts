/**
 * MCP oversized call isolation on the fake provider: a `tools/call` whose
 * own response exceeds the client's transport bound fails only that call,
 * with the model-facing hint to request less data, and the next call on the
 * same server succeeds over the same MCP session (no re-initialize, no
 * eviction). The scripted `[AIQSA_MCP_E2E:<tool>:<id>]` turn makes exactly
 * one call per run, so the two calls are two turns of one chat; the paid
 * spec (prod-1018-paid.spec.ts) proves the same within one run.
 *
 * The stand's app must run with AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES
 * lowered (32768 recommended, 4096..65536), set in the Playwright process
 * environment so Playwright's webServer passes it to `next dev`; a reused
 * server (PLAYWRIGHT_REUSE_SERVER=1) must already run with the same value.
 * The transport accepts twice that value, so the synthetic thread (four
 * times the value) is over the bound and the small message is not.
 *
 * Oracles are the synthetic peer's dispatches and session counts and the
 * persisted tool calls, never wording beyond the scripted fake answer.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { mcpOversizedResponseMessage, mcpToolFailureMessage } from "../../lib/contracts/mcpToolFailure";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { signInWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { activeChatId, disableMemoryRecall, lastAnswer, selectFakeModel, setWorkspaceEnabled } from "./support/workspace";

const configuredLimit = Number(process.env.AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES?.trim() || Number.NaN);
const limitLowered = Number.isSafeInteger(configuredLimit) && configuredLimit >= 4_096 && configuredLimit <= 65_536;
test.skip(!limitLowered, "requires AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES between 4096 and 65536 on the stand");

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const BIG_TOOL = "read_thread";
const SMALL_TOOL = "read_message";
/** The hint's fixed part after the size, which names the bound the response exceeded. */
const HINT_TAIL = (() => {
  const message = mcpOversizedResponseMessage();
  return message.slice(message.indexOf("Request less data"));
})();
/** Codes a call-local overflow used to cascade into on the next call. */
const CASCADE_CODES = ["mcp_session_closed", "mcp_session_evicted", "mcp_server_unavailable"];

/** Four times the delivered-result limit: over the transport bound (twice it), so the call fails unread. */
function oversizedThread(): string {
  const line = "Synthetic message: a routine status note about a fictional project, with nothing to act on.\n";
  return line.repeat(Math.ceil((configuredLimit * 4) / Buffer.byteLength(line)));
}

type Dispatch = Readonly<{ initializedSessions: number; name: string }>;

/** A synthetic mail peer whose every call records how many sessions it had initialized by then. */
async function startMailEndpoint(): Promise<{ dispatches: Dispatch[]; endpoint: MutableMcpEndpoint }> {
  const dispatches: Dispatch[] = [];
  const thread = oversizedThread();
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
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
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

type PersistedResult = Readonly<{ content?: Array<{ text?: unknown }>; status?: unknown }>;
const texts = (result: unknown) => ((result ?? {}) as PersistedResult).content
  ?.flatMap((part) => typeof part.text === "string" ? [part.text] : []) ?? [];

test("an over-bound MCP response fails only its call with a hint, and the server's session keeps answering", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const { dispatches, endpoint } = await startMailEndpoint();
  const chatIds = new Set<string>();
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    serverId = await publishServer(page, endpoint, `Oversized mail ${randomUUID().slice(0, 8)}`, userId);
    await newChat(page);

    await send(page, `Read thread t-1 [AIQSA_MCP_E2E:${BIG_TOOL}:t-1]`, "MCP call finished: error.");
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
    expect((oversized!.result as PersistedResult | null)?.status, "the over-bound call failed").toBe("error");
    const failureText = texts(oversized!.result).join("\n");
    expect(failureText).toContain(mcpToolFailureMessage("mcp_call_result_too_large"));
    expect(failureText, "the failure tells the model to request less data").toContain(HINT_TAIL);
    expect(failureText).toMatch(/its response was larger than \d+(?:\.\d)? (?:KiB|MiB|bytes)/u);
    expect(following!.toolName).toContain(SMALL_TOOL);
    expect((following!.result as PersistedResult | null)?.status, "the next call on the same server succeeded").toBe("complete");
    const serialized = JSON.stringify(runs.map((run) => ({ calls: run.toolCalls.map((call) => call.result), error: run.errorPayload })));
    expect(CASCADE_CODES.filter((code) => serialized.includes(code)), "no session failure followed the oversized call").toEqual([]);

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
