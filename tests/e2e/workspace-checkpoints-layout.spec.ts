import { createServer, request as forwardRequest } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { expect, test as base, type Download, type Page } from "@playwright/test";
import type { ThreadGeneratedFile, ThreadWorkspaceActivityEntry } from "../../lib/contracts/workspace";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectCenterUnobscured, expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Presentation fixtures only: no provider, guest, storage settlement or real PSD validation.
// The synthetic download bodies prove exact browser selection, not backend durability.
const chatId = "checkpoint-layout-chat";
const runId = "checkpoint-layout-run";
const answerId = "checkpoint-layout-answer";
const questionId = "checkpoint-layout-question";
const timestamp = "2026-09-24T09:00:00.000Z";
const failureMessage = "Workspace stopped execution, but could not durably confirm cleanup. The session remains fenced.";
const workspace = { available: true, enabled: true, internetEnabled: false, sessionState: "ready" };
const drafts: ThreadGeneratedFile[] = ["one", "two"].map((version, index) => ({
  attachmentId: `checkpoint-layout-${version}`, byteSize: 18,
  fileName: "composition.psd", mimeType: "application/octet-stream", relativePath: "composition.psd",
  checkpoint: { id: `checkpoint-${version}`, createdAt: `2026-09-24T09:0${index}:00.000Z`,
    description: index ? "Adjusted composition" : `Original composition · ${"LongDescription".repeat(12)}` }
}));
const bodies = ["synthetic-draft-1\n", "synthetic-draft-2\n"];
// Chromium downloads bypass route interception. Serve the two synthetic bodies
// over HTTP while forwarding the unchanged application through this loopback fixture.
const test = base.extend<{ checkpointDownloads: string[] }>({
  checkpointDownloads: async ({ browserName: _browserName }, provide) => { await provide([]); },
  baseURL: async ({ baseURL, checkpointDownloads }, provide) => {
    const upstream = new URL(baseURL!);
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("loopback_fixture_required");
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", upstream);
      const index = drafts.findIndex(file => url.pathname === `/api/attachments/${file.attachmentId}/content`);
      if (index >= 0 && request.method === "GET") {
        checkpointDownloads.push(drafts[index]!.attachmentId);
        response.writeHead(200, { "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="composition.psd"' }).end(bodies[index]);
        return;
      }
      if (url.origin !== upstream.origin) { response.writeHead(400).end(); return; }
      const forwarded = forwardRequest(url, { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      });
      forwarded.on("error", () => response.destroy());
      response.once("close", () => forwarded.destroy());
      request.pipe(forwarded);
    });
    // Next development hydration also needs its WebSocket connection.
    const tunnels = new Set<Duplex>();
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", upstream);
      if (url.origin !== upstream.origin) { socket.destroy(); return; }
      const target = createConnection({ host: upstream.hostname, port: Number(upstream.port || 80) });
      for (const stream of [socket, target]) { tunnels.add(stream); stream.once("close", () => tunnels.delete(stream)); }
      socket.once("error", () => target.destroy()); target.once("error", () => socket.destroy());
      socket.once("close", () => target.destroy()); target.once("close", () => socket.destroy());
      target.once("connect", () => {
        const headers = request.rawHeaders.reduce<string[]>((rows, value, index, all) => index % 2 ? rows : [...rows, `${value}: ${all[index + 1]}`], []);
        target.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
        if (head.length) target.write(head);
        socket.pipe(target).pipe(socket);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await provide(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    finally { for (const stream of tunnels) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
const diagnostics: ThreadWorkspaceActivityEntry[] = [
  { id: "known-exit", kind: "command", phase: "failed", errorCode: "workspace_command_failed",
    command: { preview: "python inspect.py", exitCode: 17, stderrPreview: "Synthetic inspection failure" } },
  { id: "missing-metadata", kind: "command", phase: "failed", errorCode: "workspace_operation_failed",
    command: { preview: "python inspect_metadata.py" } },
  { id: "confirmed-stop", kind: "command", phase: "failed", errorCode: "workspace_execution_stopped",
    command: { preview: "python build_preview.py" } },
  { id: "settlement-failed", kind: "command", phase: "failed", errorCode: "workspace_execution_settlement_failed",
    command: { preview: "python export_preview.py" } }
];
const guidance = [
  "The command returned a nonzero exit code.",
  "without a confirmed specific cause",
  "execution was stopped, but its command exit outcome is unknown",
  "stopped execution, but could not durably confirm cleanup"
];

async function installChat(page: Page, status?: "error" | "cancelled") {
  await installMatrixCatalogFixture(page, { folders: [], chats: [{
    id: chatId, title: "Saved Workspace drafts", activeLeafMessageId: status ? answerId : null,
    createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
    folderId: null, pinned: false, workspace, messageCount: status ? 2 : 0,
    messages: status ? [
      { id: questionId, role: "user", status: "complete", parentMessageId: null,
        createdAt: timestamp, content: "Prepare the synthetic composition.", errorMessage: null,
        citationMessageId: null, modelId: null, modelRunId: null, provider: null },
      { id: answerId, role: "assistant", status, parentMessageId: questionId,
        createdAt: timestamp, content: "", errorMessage: status === "error" ? failureMessage : null,
        citationMessageId: null, modelId: "gpt-5.5", modelRunId: runId, provider: "openai",
        artifactSummary: { citations: [], reasoningText: [], sources: [], generatedFiles: drafts },
        workspaceActivity: { entries: diagnostics, outputStatus: { state: "failed", errorCode: "workspace_session_lost" } } }
    ] : []
  }] });
}

async function downloadedText(download: Download): Promise<string> {
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("composition.psd");
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark" },
  { width: 768, height: 1024, theme: "light" },
  { width: 1024, height: 768, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 844, height: 390, theme: "dark" }
] as const) {
  test.describe(`checkpoint presentation ${viewport.width}px`, () => {
    test.use({ isMobile: viewport.width !== 1440, hasTouch: viewport.width !== 1440 });
    for (const terminal of ["error", "cancelled"] as const) {
      test(`live drafts survive ${terminal} and reload with exact reuse`, async ({ page, context, checkpointDownloads: downloads }, testInfo) => {
        test.setTimeout(60_000);
        await page.setViewportSize(viewport);
        await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
        await page.addInitScript(id => localStorage.setItem("aiqsa.activeChatId", id), chatId);
        await installChat(page);
        await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
        await page.route(`**/api/chats/${chatId}/workspace`, route => route.fulfill({ json: { workspace } }));
        let runStatus: "streaming" | "error" | "cancelled" = "streaming";
        await page.route(`**/api/model-runs/${runId}`, route => route.fulfill({ json: { version: 1, run: { id: runId, status: runStatus } } }));
        const unexpected: string[] = [];
        const reuse: string[] = [];
        // Network backstop; owned initial admission is intercepted inside the browser below.
        await page.route("**/api/chats/*/messages", route => {
          if (route.request().method() !== "POST") return route.fallback();
          unexpected.push("message_post");
          return route.fulfill({ status: 409, json: { error: "unexpected_checkpoint_layout_run" } });
        });
        await page.route("**/api/model-runs/*/followups", route => {
          if (route.request().method() !== "POST") return route.fallback();
          unexpected.push("followup_post");
          return route.fulfill({ status: 409, json: { error: "unexpected_checkpoint_layout_run" } });
        });
        await page.route("**/api/messages/*/regenerate", route => {
          unexpected.push("regenerate_post");
          return route.fulfill({ status: 409, json: { error: "unexpected_checkpoint_layout_run" } });
        });
        await page.route("**/api/uploads/*/reuse", route => {
          const file = drafts.find(file => new URL(route.request().url()).pathname === `/api/uploads/${file.attachmentId}/reuse`);
          if (!file || route.request().method() !== "POST") return route.fulfill({ status: 404, body: "" });
          reuse.push(file.attachmentId);
          return route.fulfill({ json: { attachment: { id: `reused-${file.attachmentId}`, fileName: file.fileName,
            byteSize: file.byteSize, mimeType: file.mimeType, kind: "file", status: "ready" } } });
        });
        await page.route(`**/api/chats/${chatId}/workspace/exports`, route => route.fulfill({ json: {
          exports: [{ messageId: answerId, createdAt: timestamp, files: drafts }], nextCursor: null
        } }));
        const stream = createGatedRunStreamFixture({ key: "checkpoint-layout", abortMessage: "Synthetic Stop", notReadyError: "checkpoint_layout_not_ready" });
        await stream.install(page, chatId);
        // Use the current cancel DTO and permit exactly one synthetic admission per document.
        // All further dispatches fail locally; no retries can escape to a provider.
        const installDispatchGuard = () => page.evaluate(({ chatId, runId }) => {
          const original = window.fetch.bind(window);
          const counters = { sends: 0, cancels: 0, unexpected: 0 };
          Object.assign(window, { __checkpointLayoutCounters: counters });
          window.fetch = async (input, init) => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
            const method = init?.method ?? (input instanceof Request ? input.method : "GET");
            if (method === "POST" && /^\/api\/chats\/[^/]+\/messages$/u.test(url.pathname)) {
              counters.sends++;
              if (url.pathname !== `/api/chats/${chatId}/messages` || counters.sends !== 1) {
                counters.unexpected++;
                return Response.json({ error: "unexpected_checkpoint_layout_run" }, { status: 409 });
              }
            }
            if (method === "POST" && url.pathname === `/api/model-runs/${runId}/cancel`) {
              counters.cancels++;
              return Response.json({ run: { id: runId, status: "cancelled" } });
            }
            return original(input, init);
          };
        }, { chatId, runId });
        await signInWithLocalToken(page);
        // Install after navigation: multiple addInitScript callbacks have no ordering guarantee.
        await installDispatchGuard();
        const composer = page.getByRole("textbox", { name: "Message" });
        await composer.fill("Prepare the synthetic composition.");
        await composer.press("Enter");
        await stream.waitForRequestCount(page, 1);
        await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
        await stream.emit(page, "message_start", { assistantMessageId: answerId, userMessageId: questionId });
        await composer.fill("Keep my next request unchanged.");
        const answer = page.locator('article[data-role="assistant"]').last();
        const files = answer.getByRole("region", { name: "Generated files" });
        for (const file of drafts) {
          await stream.emit(page, "artifact", { artifactType: "workspace_checkpoint", payload: { checkpoint: file.checkpoint, files: [file] } });
        }
        // Replayed settled event must not create a third card or follow a same-name version.
        await stream.emit(page, "artifact", { artifactType: "workspace_checkpoint", payload: { checkpoint: drafts[0]!.checkpoint, files: [drafts[0]] } });
        await expect(files.getByRole("listitem")).toHaveCount(2);
        await expect(files).toContainText("Saved draft");
        await expect(files).not.toContainText("Final export");
        await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toBeVisible();
        for (let index = 0; index < drafts.length; index++) {
          const link = files.getByRole("link", { name: "Download", exact: true }).nth(index);
          await expect(link).toHaveAttribute("href", `/api/attachments/${drafts[index]!.attachmentId}/content`);
          await link.focus();
          const download = page.waitForEvent("download");
          await page.keyboard.press("Enter");
          expect(await downloadedText(await download)).toBe(bodies[index]);
        }
        await expect(composer).toHaveValue("Keep my next request unchanged.");
        await expectNoHorizontalOverflow(page);
        await files.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("checkpoint-live.png") });

        for (const [index, entry] of diagnostics.entries()) {
          await stream.emit(page, "artifact", { artifactType: "workspace_activity", payload: { ...entry, sequence: index + 1 } });
        }
        const disclosure = answer.getByTestId("tool-activity-disclosure");
        await expect(disclosure).not.toHaveAttribute("open");
        await disclosure.locator(":scope > summary").focus();
        await page.keyboard.press("Enter");
        const commands = disclosure.locator(".v2-workspace-command");
        await expect(commands).toHaveCount(4);
        await expect(disclosure.locator(".v2-workspace-command[open]")).toHaveCount(0);
        for (let index = 0; index < guidance.length; index++) {
          const row = commands.nth(index);
          await row.locator(":scope > summary").focus();
          await page.keyboard.press("Enter");
          await expect(row.getByRole("note")).toContainText(guidance[index]!);
          if (index === 0) await expect(row).toContainText("Exit code 17");
          else await expect(row).not.toContainText("Exit code");
          await expectNoHorizontalOverflow(page);
          if (index === 3) {
            await row.scrollIntoViewIfNeeded();
            const jump = page.getByRole("button", { name: "Jump to latest message", exact: true });
            if (viewport.width === 390 || viewport.width === 1024) await expect(jump).toBeVisible();
            if (await jump.isVisible()) {
              const [jumpBox, copyBox] = await Promise.all([
                jump.boundingBox(), files.locator(".v2-generated-file-copy").first().boundingBox()
              ]);
              expect(jumpBox).not.toBeNull();
              expect(copyBox).not.toBeNull();
              // At this real cleanup scroll position the floating control can
              // share the draft's vertical band; its entire text lane stays clear.
              expect(copyBox!.x).toBeGreaterThanOrEqual(jumpBox!.x + jumpBox!.width + 1);
            }
            await page.screenshot({ path: testInfo.outputPath("checkpoint-cleanup-guidance.png") });
          }
          await row.locator(":scope > summary").focus();
          await page.keyboard.press("Enter");
        }
        runStatus = terminal;
        await installChat(page, terminal);
        if (terminal === "cancelled") {
          await page.getByRole("button", { name: "Stop answer", exact: true }).click();
        } else {
          await stream.emit(page, "error", { code: "workspace_execution_settlement_failed", message: failureMessage, runId });
          await stream.emit(page, "done", { status: "error", runId });
          await stream.close(page);
        }
        await expect(page.getByRole("button", { name: "Stop answer", exact: true })).toHaveCount(0);
        await expect(files.getByRole("listitem")).toHaveCount(2);
        await expect(composer).toHaveValue("Keep my next request unchanged.");
        expect(await page.evaluate(() => Reflect.get(window, "__checkpointLayoutCounters")))
          .toEqual({ sends: 1, cancels: terminal === "cancelled" ? 1 : 0, unexpected: 0 });
        await page.reload();
        await installDispatchGuard();
        await expect(files.getByRole("listitem")).toHaveCount(2);
        await expect(answer).toContainText(terminal === "cancelled" ? "Stopped" : "could not durably confirm cleanup");
        await expectNoHorizontalOverflow(page);
        await files.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("checkpoint-reloaded.png") });
        const oldDownload = page.waitForEvent("download");
        await files.getByRole("link", { name: "Download", exact: true }).first().click();
        expect(await downloadedText(await oldDownload)).toBe(bodies[0]);
        expect(downloads).toEqual([drafts[0]!.attachmentId, drafts[1]!.attachmentId, drafts[0]!.attachmentId]);

        for (const [index, file] of drafts.entries()) {
          await page.getByRole("button", { name: "Chat actions", exact: true }).click();
          await page.getByRole("menuitem", { name: "Export history", exact: true }).click();
          const history = page.getByRole("dialog", { name: "Export history", exact: true });
          await expect(history.getByRole("link", { name: "Download", exact: true })).toHaveCount(2);
          await expectWithinViewport(page, history);
          if (index === 0) {
            await expect(history.getByRole("button", { name: "Close export history" })).toBeFocused();
            await page.screenshot({ path: testInfo.outputPath("checkpoint-history.png") });
            await page.keyboard.press("Escape");
            await expect(history).toHaveCount(0);
            await page.getByRole("button", { name: "Chat actions", exact: true }).focus();
            await page.keyboard.press("Enter");
            await page.getByRole("menuitem", { name: "Export history", exact: true }).focus();
            await page.keyboard.press("Enter");
            await expect(history).toBeVisible();
          }
          const use = history.getByRole("button", { name: "Use file", exact: true }).nth(index);
          await use.focus();
          if (index === 1) {
            await expectWithinViewport(page, use);
            await expectCenterUnobscured(use);
            await page.screenshot({ path: testInfo.outputPath("checkpoint-history-scrolled.png") });
          }
          await page.keyboard.press("Enter");
          await expect(history).toHaveCount(0);
          await expect(page.getByRole("region", { name: "Attachments", exact: true }).getByRole("listitem")).toHaveCount(index + 1);
          expect(reuse[index]).toBe(file.attachmentId);
        }
        await expectNoHorizontalOverflow(page);
        expect(reuse).toEqual(drafts.map(file => file.attachmentId));
        expect(unexpected).toEqual([]);
        expect(await page.evaluate(() => Reflect.get(window, "__checkpointLayoutCounters")))
          .toEqual({ sends: 0, cancels: 0, unexpected: 0 });
      });
    }
  });
}
