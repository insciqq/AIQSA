import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page, type Response } from "@playwright/test";
import type { ChatDetailWire, ChatMessageWire } from "../../lib/contracts/chats";
import type { PublicShareSnapshot } from "../../lib/domain/shareSnapshot";
import { runtimeSecurityHeaders } from "../../lib/server/security/headers";
import { hashShareToken } from "../../lib/server/shares/tokens";
import { LOCAL_OPERATOR_EMAIL } from "../../prisma/local-seed-auth";
import { matrixCatalog } from "./shell/catalog";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { createGatedRunStreamFixture } from "./support/gatedRunStream";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

/**
 * Closed ```mermaid fences render as sanitized inline SVG in chat and public
 * shares. The dev server only reports its own relaxed policy, so each page is
 * served with the exact production policy in report-only mode: violations are
 * observed without breaking the dev runtime, and those attributable to the
 * Mermaid chunks or to any resource load must be zero.
 */
const PRODUCTION_CSP = runtimeSecurityHeaders({
  AIQSA_APP_BASE_URL: "https://aiqsa.example.test",
  NODE_ENV: "production"
})["Content-Security-Policy"]!;

// Chromium's Local Network Access checks treat a document fulfilled by
// Playwright as coming from an unknown address space and then refuse its
// WebSocket to 127.0.0.1, so the dev server's HMR socket fails and the page
// never hydrates. Rewriting the header through CDP `Fetch.continueResponse`
// keeps the address space but Chromium ignores a CSP added there. This
// harness-only flag restores the dev socket; no product request depends on it.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] } });

// A message only Mermaid's entry module contains; it identifies the lazy chunk.
const MERMAID_SIGNATURE = "Maximum text size in diagram exceeded";

const timestamp = "2026-10-04T10:00:00.000Z";
const chatId = "mermaid-diagrams-chat";
const answerId = "mermaid-diagrams-answer";
const questionId = "mermaid-diagrams-question";

const flowchart = "flowchart LR\n  Draft[Draft answer] --> Review{Diagram valid?}\n  Review -->|Yes| Render[Render SVG]\n  Review -->|No| Fallback[Show code]\n";
const sequence = "sequenceDiagram\n  participant User\n  participant App\n  User->>App: Ask for a diagram\n  App-->>User: Inline SVG\n";
const classDiagram = "classDiagram\n  class MermaidBlock {\n    +String code\n    +toggle() void\n  }\n  MermaidBlock <|-- PublicShare\n";
const invalid = "flowchart TD\n  Broken -->\n";
const hostile = [
  "flowchart TD",
  '  A["<img src=x onerror=globalThis.__aiqsaHostile=1> label"] --> B["<script>globalThis.__aiqsaHostile=2</script>"]',
  '  click A href "https://example.invalid/track"',
  "  click B call alert()",
  ""
].join("\n");
const fence = (source: string) => `\`\`\`mermaid\n${source}\`\`\``;
const diagramAnswer = [
  "Here are three diagrams.",
  fence(flowchart),
  fence(sequence),
  fence(classDiagram),
  "An invalid one:",
  fence(invalid),
  "And a hostile one:",
  fence(hostile)
].join("\n\n");
const plainAnswer = "No diagrams here.\n\n```ts\nconst answer = 42;\n```";

type Observation = {
  externalRequests: string[];
  mermaidChunks(): Promise<string[]>;
  violations(): Promise<Array<{ blockedURI: string; directive: string; sourceFile: string }>>;
};

/**
 * Records policy violations, external requests and Mermaid chunk downloads.
 * With `productionPolicy`, the page document is re-served with the production
 * policy in report-only mode; otherwise the dev server's own report-only
 * policy applies and the page loads exactly as in other fixture specs.
 */
async function observe(page: Page, documentPath: string, { productionPolicy = false } = {}): Promise<Observation> {
  const externalRequests: string[] = [];
  const scriptChecks: Array<Promise<string | null>> = [];
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __aiqsaCspViolations: unknown[] }).__aiqsaCspViolations = store;
    document.addEventListener("securitypolicyviolation", (event) => {
      store.push({ blockedURI: event.blockedURI, directive: event.effectiveDirective, sourceFile: event.sourceFile });
    });
  });
  if (productionPolicy) {
    await page.route(`**${documentPath}`, async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch({ maxRedirects: 0 });
      const headers: Record<string, string> = { ...response.headers(), "content-security-policy-report-only": PRODUCTION_CSP };
      // The fulfilled body is already decoded and re-framed by Playwright.
      for (const name of ["content-security-policy", "content-encoding", "content-length", "transfer-encoding"]) delete headers[name];
      await route.fulfill({ headers, response });
    });
  }
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["http:", "https:"].includes(url.protocol)) return;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") externalRequests.push(url.origin);
  });
  page.on("response", (response: Response) => {
    if (response.request().resourceType() !== "script") return;
    scriptChecks.push(response.text().then((body) => (body.includes(MERMAID_SIGNATURE) ? response.url() : null), () => null));
  });
  return {
    externalRequests,
    async mermaidChunks() {
      return (await Promise.all(scriptChecks)).filter((url): url is string => url !== null);
    },
    async violations() {
      return page.evaluate(() => (window as unknown as {
        __aiqsaCspViolations: Array<{ blockedURI: string; directive: string; sourceFile: string }>;
      }).__aiqsaCspViolations);
    }
  };
}

async function expectCleanPolicy(page: Page, observation: Observation) {
  const chunks = await observation.mermaidChunks();
  const attributable = (await observation.violations()).filter((violation) =>
    !violation.directive.startsWith("script-src") || chunks.some((chunk) => violation.sourceFile.startsWith(chunk.split("?")[0]!))
  );
  expect(attributable).toEqual([]);
  expect(observation.externalRequests).toEqual([]);
  expect(await page.evaluate(() => (globalThis as { __aiqsaHostile?: unknown }).__aiqsaHostile)).toBeUndefined();
}

async function expectDiagrams(page: Page) {
  const blocks = page.getByTestId("mermaid-block");
  await expect(blocks).toHaveCount(5);
  await expect(page.locator('[data-mermaid-state="rendered"]')).toHaveCount(4, { timeout: 20_000 });
  for (const index of [0, 1, 2, 4]) {
    const scroller = blocks.nth(index).getByTestId("mermaid-diagram-scroll");
    await expect(scroller.locator("svg")).toBeVisible();
    // The diagram stays inside its own box; only that box may scroll.
    const contained = await scroller.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.left >= -1 && box.right <= window.innerWidth + 1;
    });
    expect(contained).toBe(true);
  }
  await expect(blocks.nth(3)).toHaveAttribute("data-mermaid-state", "failed");
  await expect(blocks.nth(3).getByTestId("mermaid-fallback-note")).toHaveText("Diagram could not be rendered.");
  await expect(blocks.nth(3).getByRole("region", { name: "Scrollable code block" })).toContainText("Broken -->");
  const hostileBlock = blocks.nth(4);
  await expect(hostileBlock.getByTestId("mermaid-diagram-scroll")).toContainText("label");
  expect(await hostileBlock.locator("a, script, img, image, iframe, foreignObject").count()).toBe(0);
  expect(await hostileBlock.evaluate((element) => [...element.querySelectorAll("svg *")]
    .some((node) => [...node.attributes].some((attribute) => attribute.name.startsWith("on"))))).toBe(false);
  await expectNoHorizontalOverflow(page);
}

function message(id: string, role: "assistant" | "user", content: string, parentMessageId: string | null): ChatMessageWire {
  return { id, role, content, parentMessageId, status: "complete", createdAt: timestamp,
    citationMessageId: null, errorMessage: null, modelId: null, modelRunId: null, provider: null };
}

function chatDetail(answer: string | null): ChatDetailWire {
  const messages = answer === null ? [] : [message(questionId, "user", "Draw the flow.", null), message(answerId, "assistant", answer, questionId)];
  return {
    assistant: null, id: chatId, title: "Mermaid diagrams", createdAt: timestamp, updatedAt: timestamp,
    activeLeafMessageId: answer === null ? null : answerId, defaultModelId: matrixCatalog.models[0]!.modelId,
    defaultProvider: matrixCatalog.models[0]!.provider, folderId: null, pinned: false, messageCount: messages.length,
    usageStats: null, contextStats: { approximateActiveBranchInputTokens: 100 },
    pageInfo: { activeLeafMessageId: answer === null ? null : answerId, beforeCursor: null, hasOlder: false, snapshotUpdatedAt: timestamp },
    workspace: { available: false, enabled: false, internetEnabled: false, sessionState: null },
    messages
  } as ChatDetailWire;
}

async function prepareChat(page: Page, answer: string | null) {
  await installMatrixCatalogFixture(page, { chats: [chatDetail(answer)], folders: [] });
  await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
  await page.route("**/api/me/chats/*/memory-mode", (route) => route.fulfill({ json: {
    allowedActions: ["EXCLUDE"], archived: false, mode: "NORMAL", temporaryRetentionDeadline: null
  } }));
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, theme: "light", touch: false, productionPolicy: true },
  { name: "tablet-portrait", width: 820, height: 1180, theme: "dark", touch: true, productionPolicy: false },
  { name: "phone-portrait", width: 390, height: 844, theme: "light", touch: true, productionPolicy: false },
  { name: "phone-landscape", width: 844, height: 390, theme: "dark", touch: true, productionPolicy: false }
] as const) {
  test.describe(`chat at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: viewport.touch });

    test(`renders three diagrams, falls back for invalid source and keeps hostile source inert in ${viewport.theme}`, async ({ context, page }, testInfo) => {
      test.setTimeout(90_000);
      await context.addCookies([{ name: "aiqsa.theme", value: viewport.theme, url: testInfo.project.use.baseURL! }]);
      await prepareChat(page, diagramAnswer);
      await page.route("**/api/chats/*/messages", (route) => route.request().method() === "POST"
        ? route.fulfill({ status: 409, json: { error: "unexpected_fixture_run" } }) : route.fallback());
      const observation = await observe(page, `/c/${chatId}`, { productionPolicy: viewport.productionPolicy });
      await signInWithLocalToken(page, `/c/${chatId}`);
      await expectDiagrams(page);
      expect(await observation.mermaidChunks()).not.toEqual([]);

      const first = page.getByTestId("mermaid-block").first();
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`mermaid-chat-${viewport.name}-${viewport.theme}.png`) });
      await first.getByRole("button", { name: "Code", exact: true }).click();
      await expect(first.getByRole("region", { name: "Scrollable code block" })).toContainText("Draft[Draft answer]");
      await expect(first.getByTestId("mermaid-diagram-scroll")).toHaveCount(0);
      await first.getByRole("button", { name: "Diagram", exact: true }).click();
      await expect(first.getByTestId("mermaid-diagram-scroll").locator("svg")).toBeVisible();
      const download = page.waitForEvent("download");
      await first.getByRole("button", { name: "Download SVG" }).click();
      expect((await download).suggestedFilename()).toBe("diagram.svg");

      // The diagrams follow a theme switch without a reload.
      const other = viewport.theme === "light" ? "dark" : "light";
      const before = await first.getByTestId("mermaid-diagram-scroll").innerHTML();
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
        document.documentElement.dataset.colorScheme = value;
      }, other);
      await expect.poll(() => first.getByTestId("mermaid-diagram-scroll").innerHTML()).not.toBe(before);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`mermaid-chat-${viewport.name}-${other}.png`) });
      await expectCleanPolicy(page, observation);
    });
  });
}

test("a page without diagrams never downloads the Mermaid chunk", async ({ page }) => {
  await prepareChat(page, plainAnswer);
  const observation = await observe(page, `/c/${chatId}`);
  await signInWithLocalToken(page, `/c/${chatId}`);
  await expect(page.getByRole("region", { name: "Scrollable code block" })).toContainText("const answer = 42;");
  await page.waitForLoadState("networkidle");
  expect(await observation.mermaidChunks()).toEqual([]);
  await expect(page.getByTestId("mermaid-block")).toHaveCount(0);
});

test("a streamed fence stays text until it closes, then renders without a reload", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const runId = "mermaid-diagrams-run";
  await page.setViewportSize({ width: 1024, height: 768 });
  await prepareChat(page, null);
  await page.route(`**/api/model-runs/${runId}`, (route) => route.fulfill({ json: { version: 1, run: { id: runId, status: "streaming" } } }));
  const stream = createGatedRunStreamFixture({ key: "mermaid-diagrams", abortMessage: "Synthetic stream stopped", notReadyError: "mermaid_stream_not_ready" });
  await stream.install(page, chatId);
  const observation = await observe(page, `/c/${chatId}`);
  await signInWithLocalToken(page, `/c/${chatId}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible();
  await composer.fill("Draw the flow.");
  await composer.press("Enter");
  await stream.waitForRequestCount(page, 1);
  await stream.emit(page, "run_start", { provider: "openai", modelId: "gpt-5.5", runId, status: "streaming" });
  await stream.emit(page, "message_start", { assistantMessageId: answerId, userMessageId: questionId });
  await stream.emit(page, "token", { delta: "Here is the flow.\n\n```mermaid\nflowchart LR\n  Draft[Draft answer] --> Review" });
  const answer = page.locator('article[data-role="assistant"]').last();
  await expect(answer).toContainText("```mermaid");
  await expect(answer.getByTestId("mermaid-block")).toHaveCount(0);
  expect(await observation.mermaidChunks()).toEqual([]);

  await stream.emit(page, "token", { delta: "{Diagram valid?}\n```\n\nStill writing." });
  await expect(answer.locator('[data-mermaid-state="rendered"] svg')).toBeVisible({ timeout: 20_000 });
  const finalAnswer = "Here is the flow.\n\n```mermaid\nflowchart LR\n  Draft[Draft answer] --> Review{Diagram valid?}\n```\n\nStill writing.";
  await installMatrixCatalogFixture(page, { chats: [chatDetail(finalAnswer)], folders: [] });
  await stream.emit(page, "done", { runId, status: "complete" });
  await stream.close(page);
  await expect(answer.locator('[data-mermaid-state="rendered"] svg')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mermaid-streamed.png") });
  await expectCleanPolicy(page, observation);
});

test.describe("public share", () => {
  test.describe.configure({ mode: "serial" });
  const prisma = new PrismaClient();

  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  for (const variant of [
    { theme: "light", width: 1440, height: 900, productionPolicy: true },
    { theme: "dark", width: 390, height: 844, productionPolicy: false }
  ] as const) {
    test(`renders the same diagrams in a ${variant.theme} public share at ${variant.width}px`, async ({ baseURL, page }, testInfo) => {
      test.setTimeout(90_000);
      const owner = await prisma.user.findUnique({ select: { id: true }, where: { email: LOCAL_OPERATOR_EMAIL } });
      expect(owner).toBeTruthy();
      const token = `mermaid-share-${randomUUID()}`;
      const snapshot = {
        messages: [
          { content: { blocks: [{ text: "Draw the flow.", type: "text" }] }, role: "user" },
          { content: { blocks: [{ text: diagramAnswer, type: "text" }] }, role: "assistant" }
        ],
        title: "Shared diagrams",
        version: 1
      } satisfies PublicShareSnapshot;
      const share = await prisma.sharedChatSnapshot.create({
        data: {
          ownerUserId: owner!.id,
          slugHash: hashShareToken(token),
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          title: snapshot.title
        },
        select: { id: true }
      });
      try {
        await page.setViewportSize({ width: variant.width, height: variant.height });
        await page.context().addCookies([{ name: "aiqsa.theme", url: baseURL!, value: variant.theme }]);
        const observation = await observe(page, `/s/${token}`, { productionPolicy: variant.productionPolicy });
        const response = await page.goto(`/s/${token}`);
        expect(response?.status()).toBe(200);
        await expectDiagrams(page);
        await page.getByTestId("mermaid-block").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`mermaid-share-${variant.theme}-${variant.width}.png`) });
        await expectCleanPolicy(page, observation);
      } finally {
        await prisma.sharedChatSnapshot.delete({ where: { id: share.id } });
      }
    });
  }
});
