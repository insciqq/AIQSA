import { expect, test, type Locator } from "@playwright/test";
import type { ThreadToolActivityCall } from "../../lib/contracts/chats";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// A settled answer with a plan, a Workspace command given inline Python and
// fourteen calls of one MCP tool: the steps read as a few even rows, the
// repeated calls fold into one, and nothing shows engine rounds.
const chatId = "answer-steps-layout-chat";
const runId = "answer-steps-layout-run";
const timestamp = "2026-10-24T10:00:00.000Z";
const inlinePython = `python -c "data={\\n'mp_page2':'''557a947a 09c4d75b 0748e500 bb601f50 e1b091d3'''}\\nprint(len(data))"`;

const listCommits = (index: number): ThreadToolActivityCall => {
  const round = index < 7 ? 4 : 5;
  return { details: { ordinal: index < 7 ? index : index - 7, roundIndex: round }, durationMs: 300 + index * 37, origin: "mcp",
    round, serverName: "GitLab", status: "complete", toolName: "list_commits" };
};

const section = (text: string) => ({ byteSize: Buffer.byteLength(text), text, truncated: false });

// A web-search answer: four searches between page reads, one of which failed
// on a long address. The per-engine count is said once, on the line.
const searchChatId = "answer-steps-search-chat";
const failedTarget = "github.com/example-org/sample-repository/blob/main/paper/conference_submission_2027_final.pdf";
const searched = (durationMs: number): ThreadToolActivityCall =>
  ({ durationMs, origin: "web_search", round: 1, status: "complete", toolName: "web_search" });
const read = (fetchTarget: string, durationMs: number): ThreadToolActivityCall =>
  ({ durationMs, fetchOutcome: "read", fetchTarget, origin: "web_fetch", round: 1, status: "complete", toolName: "fetch_url" });

async function height(locator: Locator): Promise<number> {
  return (await locator.boundingBox())!.height;
}

for (const viewport of [
  { width: 1440, height: 900, theme: "dark", touch: false },
  { width: 768, height: 1024, theme: "light", touch: true },
  { width: 390, height: 844, theme: "dark", touch: true }
] as const) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ hasTouch: viewport.touch, isMobile: viewport.touch });

    test(`answer steps fold repeated calls into even rows at ${viewport.width}px`, async ({ context, page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await installMatrixCatalogFixture(page, { folders: [], chats: [{
        id: chatId, title: "Answer steps layout", activeLeafMessageId: "steps-answer",
        createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
        folderId: null, pinned: false, messageCount: 1,
        messages: [{ id: "steps-answer", role: "assistant", status: "complete", parentMessageId: null,
          createdAt: timestamp, content: "The synthetic ranking is ready.", errorMessage: null,
          citationMessageId: null, modelId: "gpt-5.5", modelRunId: runId, provider: "openai", workDurationMs: 127_000,
          toolActivity: { calls: [
            { durationMs: 353, origin: "discovery", round: 1, status: "complete", toolName: "find_tools" },
            ...Array.from({ length: 14 }, (_, index) => listCommits(index))
          ] },
          workspaceActivity: { outputStatus: { state: "complete", revision: timestamp }, entries: [
            { id: "plan", kind: "plan", phase: "succeeded", items: [
              { completed: true, text: "Collect the commits of every repository for one period." },
              { completed: true, text: "Count the activity and rank the repositories." }
            ] },
            { durationMs: 1_100, id: "start", kind: "workspace_start", phase: "succeeded" },
            { command: { exitCode: 0, preview: inlinePython, stdoutPreview: "1" }, durationMs: 218, id: "python",
              kind: "command", phase: "succeeded" }
          ] }
        }]
      }] });
      await page.route(`**/api/model-runs/${runId}/mcp-calls/**`, (route) => route.fulfill({ json: {
        isError: false, unsupportedContentTypes: [],
        request: section(JSON.stringify({ first: 100, project: "synthetic" }, null, 2)), requestState: "available",
        response: section(JSON.stringify([{ id: "557a947a", title: "Synthetic commit" }], null, 2)), responseState: "available"
      } }));
      await signInWithLocalToken(page, `/c/${chatId}`);

      const disclosure = page.getByTestId("tool-activity-disclosure");
      await expect(disclosure).toBeVisible();
      if (await disclosure.getAttribute("open") === null) await disclosure.locator(":scope > summary").click();
      await expect(disclosure).toHaveAttribute("open");

      // The Workspace section starts with its first step, and inline code reads as its language.
      await expect(disclosure.locator(".v2-workspace-feed-heading")).toHaveCount(0);
      const python = disclosure.locator(".v2-workspace-command");
      await expect(python.locator(":scope > summary")).toContainText("Ran Python code");
      await expect(disclosure).not.toContainText(/round \d/u);

      // Fourteen calls of one tool are one row as tall as any other step.
      const group = disclosure.getByTestId("tool-call-group");
      const groupSummary = group.locator(":scope > summary");
      await expect(groupSummary).toContainText("Used GitLab: list commits ×14");
      const discoveryRow = disclosure.locator(".v2-answer-process-steps:not(.v2-answer-plan) > li").first();
      expect(await height(groupSummary)).toBeLessThanOrEqual(viewport.touch ? 46 : 28);
      if (viewport.touch) expect(await height(groupSummary)).toBeGreaterThanOrEqual(44);
      expect(await height(discoveryRow)).toBeLessThanOrEqual(28);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath("steps-folded.png") });

      // Its calls open under it; each MCP row keeps the same rhythm and opens its details.
      await groupSummary.click();
      const calls = group.getByTestId("mcp-call-row");
      await expect(calls).toHaveCount(14);
      await expect(calls.first()).toContainText("Call 1");
      const rowHeights = await Promise.all([0, 7, 13].map((index) => height(calls.nth(index))));
      for (const rowHeight of rowHeights) expect(rowHeight).toBeLessThanOrEqual(viewport.touch ? 46 : 28);
      await calls.first().getByRole("button", { name: /Call 1/u }).click();
      await expect(group.getByTestId("mcp-call-details").first()).toContainText("557a947a");
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath("steps-group-open.png"), fullPage: false });

      // The command card shows the whole command in a bounded block with Copy.
      await python.locator(":scope > summary").click();
      const commandText = python.locator("pre.v2-workspace-command-text");
      await expect(commandText).toContainText("$ python -c");
      await expect(python.getByRole("button", { name: "Copy command" })).toBeVisible();
      expect(await height(commandText)).toBeLessThanOrEqual(12 * 16 + 1);
      await expectNoHorizontalOverflow(page);
      await python.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("steps-command-open.png") });
    });

    test(`web search steps say the count once and keep a wrapped failure's mark on its first line at ${viewport.width}px`, async ({ context, page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await installMatrixCatalogFixture(page, { folders: [], chats: [{
        id: searchChatId, title: "Answer search steps", activeLeafMessageId: "search-answer",
        createdAt: timestamp, updatedAt: timestamp, defaultProvider: "openai", defaultModelId: "gpt-5.5",
        folderId: null, pinned: false, messageCount: 1,
        messages: [{ id: "search-answer", role: "assistant", status: "complete", parentMessageId: null,
          createdAt: timestamp, content: "The synthetic summary is ready.", errorMessage: null,
          citationMessageId: null, modelId: "gpt-5.5", modelRunId: "answer-steps-search-run", provider: "openai",
          toolActivity: { calls: [
            read("github.com/example-org/sample-repository", 1_500),
            searched(13_000),
            { durationMs: 427, fetchHttpStatus: 404, fetchOutcome: "fetch_http_status", fetchTarget: failedTarget,
              origin: "web_fetch", round: 1, status: "error", toolName: "fetch_url" },
            searched(23_000),
            read("github.com/example-org/sample-repository/blob/main/paper/latest.pdf", 1_800),
            searched(26_000),
            read("papers.example/2608.00001", 1_200),
            searched(27_000)
          ], searchEngines: [
            { engine: 1, name: "OpenAI (CodexLB) Search", requested: 4, settled: 4, complete: 4, error: 0, skipped: 0 }
          ] }
        }]
      }] });
      await signInWithLocalToken(page, `/c/${searchChatId}`);

      const disclosure = page.getByTestId("tool-activity-disclosure");
      await expect(disclosure.locator(":scope > summary")).toContainText("Web search · OpenAI (CodexLB) Search ×4 · Worked for");
      if (await disclosure.getAttribute("open") === null) await disclosure.locator(":scope > summary").click();
      await expect(disclosure).toHaveAttribute("open");
      await expect(disclosure.getByText(/Search ×4/u)).toHaveCount(1);
      await expect(disclosure).not.toContainText("counts successful calls");
      await expect(disclosure.getByText("Searched the web")).toHaveCount(4);

      const rows = disclosure.locator(".v2-answer-process-steps > li");
      const failed = rows.filter({ hasText: "Couldn't read" });
      await expect(failed).toContainText(`Couldn't read ${failedTarget}: the site returned 404`);
      await expect(failed).not.toContainText("Failed");
      // Whether the label wraps or not, the mark sits on the first line.
      const row = (await failed.boundingBox())!;
      const mark = (await failed.locator(".v2-answer-process-mark").boundingBox())!;
      const firstLine = (await failed.locator(".v2-answer-process-step-name").evaluate((name) => {
        const range = document.createRange();
        range.selectNodeContents(name);
        const box = range.getClientRects()[0]!;
        return { top: box.top, bottom: box.bottom };
      }));
      const markCentre = mark.y + mark.height / 2;
      expect(markCentre).toBeGreaterThanOrEqual(firstLine.top);
      expect(markCentre).toBeLessThanOrEqual(firstLine.bottom);
      expect(mark.y - row.y).toBeLessThanOrEqual(8);
      // A short step stays one even row; a long address may wrap at phone width.
      for (const index of [1, 3]) expect(await height(rows.nth(index))).toBeLessThanOrEqual(28);
      await expectNoHorizontalOverflow(page);
      await failed.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("search-steps.png") });
    });
  });
}
