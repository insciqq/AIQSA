/**
 * MCP wire-limit truncation on the fake provider with the DEFAULT response
 * limits: a `tools/call` whose body (about 20 MiB) is over the transport's
 * default wire bound (twice the default 8 MiB result limit, 16 MiB) but
 * within the per-call result ceiling (`MCP_CALL_RESULT_CEILING_BYTES`,
 * 64 MiB) is still read and arrives as an ordinary completed call, cut to
 * the result limit with the truncation marker and its tail undelivered,
 * instead of failing with `mcp_call_result_too_large`. The tool is
 * dispatched once, and a second small call in the same chat succeeds over
 * the same MCP session (no re-initialize). The scripted
 * `[AIQSA_MCP_E2E:<tool>:<id>]` turn makes exactly one call per run, so the
 * two calls are two turns of one chat. mcp-oversized-call-isolation.spec.ts
 * proves the same with a lowered limit.
 *
 * The stand's app must run with the default MCP response limits: the spec
 * skips when AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES in the Playwright process
 * environment is set to anything but the default (8388608, which the Compose
 * files pass explicitly), and a reused server (PLAYWRIGHT_REUSE_SERVER=1)
 * must run with the default too.
 *
 * The delivered result (about 8 MiB) is larger than a tool call row keeps,
 * so the row holds the excerpt the model read (head, note and the delivered
 * text's end, which is the marker) with the truncation sizes. Oracles are the
 * synthetic peer's dispatches and session counts and that persisted row,
 * never wording beyond the scripted fake answer. The 20 MiB thread is built
 * once and lives in the Playwright process only while the peer runs.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import {
  DEFAULT_MCP_RESPONSE_WIRE_LIMITS, MCP_CALL_RESULT_CEILING_BYTES, MCP_RESPONSE_WIRE_LIMIT_CEILINGS
} from "../../lib/server/mcp/responseLimits";
import { keepAccountMcpDefault } from "./support/chatDefaults";
import { deleteOwnedChatPermanently } from "./support/chatCleanup";
import { signInWithLocalToken } from "./support/localAuth";
import { startMutableMcpEndpoint, type MutableMcpEndpoint } from "./support/mutableMcpEndpoint";
import { activeChatId, disableMemoryRecall, lastAnswer, selectFakeModel } from "./support/workspace";

/** The Compose files pass the default explicitly, so only another value means a lowered (or raised) limit. */
const configuredLimit = process.env.AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES?.trim();
const defaultLimit = !configuredLimit || Number(configuredLimit) === DEFAULT_MCP_RESPONSE_WIRE_LIMITS.callToolResponseMaxBytes;
test.skip(!defaultLimit, "requires the default MCP result limit: AIQSA_MCP_CALL_TOOL_RESPONSE_MAX_BYTES unset or 8388608");

let prismaClient: PrismaClient | null = null;
/** Created on first use, so listing this file never loads database settings. */
const db = (): PrismaClient => prismaClient ??= new PrismaClient();
test.afterAll(async () => { await prismaClient?.$disconnect(); });

const BIG_TOOL = "read_thread";
const SMALL_TOOL = "read_message";
/** The default delivered result limit and the transport's wire bound for a tools/call body. */
const RESULT_LIMIT = DEFAULT_MCP_RESPONSE_WIRE_LIMITS.callToolResponseMaxBytes;
const WIRE_BOUND = Math.min(2 * RESULT_LIMIT, MCP_RESPONSE_WIRE_LIMIT_CEILINGS.callToolResponseMaxBytes);
const THREAD_BYTES = 20 * 1_024 * 1_024;
/** The client's marker opens with this stable English text (`lib/server/mcp/resultTruncation.ts`). */
const MARKER_PREFIX = "[Result truncated: the MCP tool returned ";
/** Codes the oversized call used to fail with, or cascade into on the next call. */
const CASCADE_CODES = ["mcp_call_result_too_large", "mcp_response_too_large", "mcp_session_closed", "mcp_session_evicted",
  "mcp_server_unavailable"];

/** About 20 MiB of plain-text thread (over the wire bound, under the ceiling), ending in a unique tail token. */
function oversizedThread(tail: string): string {
  const line = "Synthetic message: a routine status note about a fictional project, with nothing to act on.\n";
  return `${line.repeat(Math.ceil(THREAD_BYTES / Buffer.byteLength(line)))}${tail}\n`;
}

type Dispatch = Readonly<{ initializedSessions: number; name: string }>;

/** A synthetic mail peer whose every call records how many sessions it had initialized by then. */
async function startMailEndpoint(thread: string): Promise<{ dispatches: Dispatch[]; endpoint: MutableMcpEndpoint }> {
  const dispatches: Dispatch[] = [];
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
    description: "Synthetic mail server for wire-limit truncation",
    draft: { auth: { mode: "none" }, runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 10_000 }, slots: [],
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

test("an MCP body over the default wire limit arrives cut with a marker, and the server's session keeps answering", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" });
  const tail = `TAIL-${randomUUID().slice(0, 8)}-NOT-DELIVERED`;
  const thread = oversizedThread(tail);
  const threadBytes = Buffer.byteLength(thread);
  expect(threadBytes, "the synthetic thread is over the wire bound").toBeGreaterThan(WIRE_BOUND);
  expect(threadBytes, "and under the call result ceiling").toBeLessThan(MCP_CALL_RESULT_CEILING_BYTES);
  const { dispatches, endpoint } = await startMailEndpoint(thread);
  const chatIds = new Set<string>();
  let serverId: string | null = null;
  try {
    await signInWithLocalToken(page);
    await keepAccountMcpDefault(page);
    await disableMemoryRecall(page);
    const userId = ((await (await page.request.get("/api/me")).json()) as { user: { id: string } }).user.id;
    serverId = await publishServer(page, endpoint, `Wire-limit mail ${randomUUID().slice(0, 8)}`, userId);
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
    // The result's JSON snapshot: the thread plus its escaped newlines and the envelope.
    expect(cut?.rawPreview?.originalBytes, "the original size is the whole thread").toBeGreaterThanOrEqual(threadBytes);
    expect(cut?.rawPreview?.originalBytes, "within the call result ceiling").toBeLessThan(MCP_CALL_RESULT_CEILING_BYTES);
    expect(cut?.rawPreview?.deliveredBytes, "the delivered size fits the result limit").toBeLessThanOrEqual(RESULT_LIMIT);
    expect(cut?.rawPreview?.deliveredBytes, "and fills it").toBeGreaterThan(RESULT_LIMIT - 4_096);
    const delivered = texts(cut).join("\n");
    expect(delivered.includes(MARKER_PREFIX), "the delivered result carries the truncation marker").toBe(true);
    expect(delivered.trimEnd().endsWith("Repeating the same call returns the same truncated result.]"),
      "the delivered text ends with the marker").toBe(true);
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
