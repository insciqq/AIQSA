import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page, type Response, type TestInfo } from "@playwright/test";
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

type DiagramGeometry = {
  drawing: { bottom: number; left: number; right: number; top: number } | null;
  svg: { bottom: number; left: number; right: number; top: number };
};

/**
 * Attaches the rendered diagram's geometry and styles (synthetic content
 * only) and returns the extent of its visible drawing against its own box.
 */
async function diagnoseDiagram(scroller: Locator, name: string, testInfo: TestInfo): Promise<DiagramGeometry> {
  const report = await scroller.evaluate((host) => {
    const svg = host.querySelector(":scope > svg") as SVGSVGElement;
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
    };
    const bbox = (element: SVGGraphicsElement | null) => {
      if (!element) return null;
      const box = element.getBBox();
      return { height: box.height, width: box.width, x: box.x, y: box.y };
    };
    const style = (element: Element | null) => {
      if (!element) return null;
      const computed = getComputedStyle(element);
      return Object.fromEntries(["display", "fontFamily", "fontSize", "letterSpacing", "lineHeight", "transform", "translate", "wordSpacing"]
        .map((property) => [property, computed.getPropertyValue(property.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`))]));
    };
    const graphics = [...svg.querySelectorAll("rect, path, polygon, circle, ellipse, line, polyline, text")]
      .filter((element) => !element.closest("defs, marker, clipPath, mask, pattern, symbol"))
      .map(rect)
      .filter((box) => box.right - box.left > 0 && box.bottom - box.top > 0);
    const drawing = graphics.length ? {
      bottom: Math.max(...graphics.map((box) => box.bottom)),
      left: Math.min(...graphics.map((box) => box.left)),
      right: Math.max(...graphics.map((box) => box.right)),
      top: Math.min(...graphics.map((box) => box.top))
    } : null;
    return {
      bodyFont: getComputedStyle(document.body).fontFamily,
      drawing,
      fontsStatus: document.fonts?.status ?? null,
      host: { rect: rect(host), scrollWidth: host.scrollWidth, clientWidth: host.clientWidth, style: style(host) },
      measurementLeftovers: document.querySelectorAll("[data-aiqsa-mermaid-measure]").length,
      outerHTML: svg.outerHTML.slice(0, 200_000),
      rootGroupBBox: bbox(svg.querySelector(":scope > g")),
      sameIdCount: document.querySelectorAll(`[id="${svg.id}"]`).length,
      svg: rect(svg),
      svgAttributes: { height: svg.getAttribute("height"), viewBox: svg.getAttribute("viewBox"), width: svg.getAttribute("width") },
      svgBBox: bbox(svg),
      svgStyle: style(svg),
      textStyle: style(svg.querySelector(".node text, text")),
      rectStyle: style(svg.querySelector(".node rect, rect"))
    };
  });
  await testInfo.attach(`mermaid-geometry-${name}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  return { drawing: report.drawing, svg: report.svg };
}

/** Every visible part of the drawing lies inside the diagram's box, with only the fit padding around it. */
function expectDrawingInsideBox({ drawing, svg }: DiagramGeometry) {
  expect(drawing).not.toBeNull();
  expect(drawing!.left).toBeGreaterThanOrEqual(svg.left - 1);
  expect(drawing!.top).toBeGreaterThanOrEqual(svg.top - 1);
  expect(drawing!.right).toBeLessThanOrEqual(svg.right + 1);
  expect(drawing!.bottom).toBeLessThanOrEqual(svg.bottom + 1);
  expect(drawing!.left - svg.left).toBeLessThanOrEqual(24);
  expect(drawing!.top - svg.top).toBeLessThanOrEqual(24);
  expect(svg.right - drawing!.right).toBeLessThanOrEqual(24);
  expect(svg.bottom - drawing!.bottom).toBeLessThanOrEqual(24);
}

const DIAGRAM_NAMES = ["flowchart", "sequence", "class", "invalid", "hostile"] as const;

async function expectDiagrams(page: Page, testInfo: TestInfo) {
  const blocks = page.getByTestId("mermaid-block");
  await expect(blocks).toHaveCount(5);
  await expect(page.locator('[data-mermaid-state="rendered"]')).toHaveCount(4, { timeout: 20_000 });
  await page.evaluate(() => document.fonts?.ready);
  for (const index of [0, 1, 2, 4]) {
    const scroller = blocks.nth(index).getByTestId("mermaid-diagram-scroll");
    await expect(scroller.locator(":scope > svg")).toBeVisible();
    expectDrawingInsideBox(await diagnoseDiagram(scroller, DIAGRAM_NAMES[index]!, testInfo));
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
  expect(await hostileBlock.evaluate((element) => [...element.querySelectorAll("[data-testid=\"mermaid-diagram-scroll\"] > svg *")]
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
      await expectDiagrams(page, testInfo);
      expect(await observation.mermaidChunks()).not.toEqual([]);

      const first = page.getByTestId("mermaid-block").first();
      await first.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`mermaid-chat-${viewport.name}-${viewport.theme}.png`) });
      await first.getByRole("button", { name: "Code", exact: true }).click();
      await expect(first.getByRole("region", { name: "Scrollable code block" })).toContainText("Draft[Draft answer]");
      await expect(first.getByTestId("mermaid-diagram-scroll")).toHaveCount(0);
      await first.getByRole("button", { name: "Diagram", exact: true }).click();
      await expect(first.getByTestId("mermaid-diagram-scroll").locator(":scope > svg")).toBeVisible();
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
      expectDrawingInsideBox(await diagnoseDiagram(first.getByTestId("mermaid-diagram-scroll"), `flowchart-${other}`, testInfo));
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
  await expect(answer.locator('[data-mermaid-state="rendered"] [data-testid="mermaid-diagram-scroll"] > svg')).toBeVisible({ timeout: 20_000 });
  const finalAnswer = "Here is the flow.\n\n```mermaid\nflowchart LR\n  Draft[Draft answer] --> Review{Diagram valid?}\n```\n\nStill writing.";
  await installMatrixCatalogFixture(page, { chats: [chatDetail(finalAnswer)], folders: [] });
  await stream.emit(page, "done", { runId, status: "complete" });
  await stream.close(page);
  await expect(answer.locator('[data-mermaid-state="rendered"] [data-testid="mermaid-diagram-scroll"] > svg')).toBeVisible();
  expectDrawingInsideBox(await diagnoseDiagram(answer.getByTestId("mermaid-diagram-scroll"), "streamed", testInfo));
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
        await expectDiagrams(page, testInfo);
        await page.getByTestId("mermaid-block").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`mermaid-share-${variant.theme}-${variant.width}.png`) });
        await expectCleanPolicy(page, observation);
      } finally {
        await prisma.sharedChatSnapshot.delete({ where: { id: share.id } });
      }
    });
  }
});
