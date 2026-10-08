/**
 * Opt-in adaptive check of artifacts made from files, without a model, on the
 * disposable stand of the paid file-to-artifact spec. Never a default lane: it
 * runs only with AIQSA_AFC_ADAPTIVE_E2E=DISPOSABLE. AIQSA_AFC_BROWSER picks the
 * engine: chromium (default), webkit or firefox. The `large-html` case also
 * needs the operator's private large page (AIQSA_AFC_LARGE_HTML, or the single
 * `.html` file in AIQSA_AFC_PRIVATE_DIR);
 * it is read in place and uploaded to the stand only, never copied, and the
 * case is skipped when the file is absent.
 *
 * Each file is uploaded through the composer's upload API and made an
 * artifact by reference through the owner's artifact API (an unsent upload is
 * referenceable only without a source chat, so the artifacts have none); the
 * site ZIP is unpacked by the server. Each artifact then opens in the private
 * viewer page (`/artifacts/<id>/versions/<id>`, the "Open in new tab" view) on
 * desktop 1440×900, tablet 820×1180 and 1180×820, and phone 390×844 and
 * 844×390, the tablet and phone profiles with touch and a mobile user agent;
 * with WebKit the phone profiles are Playwright's iPhone 13 (portrait and
 * landscape), and Firefox, which has no mobile emulation, runs the sizes
 * without touch. Viewport screenshots (never element shots, which drop
 * Chromium's touch emulation) go to the test output directory for review.
 * With Chromium the phone portrait load of `large-html` also records the time
 * to the first drawn frame and the peak JS heap (CDP), and the renderers' peak
 * resident memory when the browser runs on this Linux host. The summary holds
 * booleans, counts, sizes and durations only. Artifacts are removed
 * afterwards; unsent uploads have no delete route and stay with the stand.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type CDPSession,
  type Locator,
  type Page,
  type TestInfo
} from "@playwright/test";
import { multiPageSiteZip, selfContainedHtml } from "./support/artifactFileFixtures";
import {
  ARTIFACT_FRAME,
  artifactErrorBanner,
  artifactFrame,
  clipCapture,
  createArtifactFromUploads,
  firstNonUniform,
  firstReachableButton,
  frameBox,
  largestCanvasBox,
  luminanceStdDev,
  NON_UNIFORM_STDDEV,
  privateLargeHtmlPath,
  removeArtifact,
  uploadAttachment
} from "./support/artifactFilesStand";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

type Engine = "chromium" | "firefox" | "webkit";
const requestedEngine = process.env.AIQSA_AFC_BROWSER?.trim().toLowerCase();
const engine: Engine = requestedEngine === "webkit" || requestedEngine === "firefox" ? requestedEngine : "chromium";

test.skip(process.env.AIQSA_AFC_ADAPTIVE_E2E !== "DISPOSABLE", "requires AIQSA_AFC_ADAPTIVE_E2E=DISPOSABLE on a disposable stand");
test.use({ browserName: engine });
test.describe.configure({ mode: "serial" });

const MIB = 1024 * 1024;

type Profile = Readonly<{ name: string; touch: boolean; options: BrowserContextOptions }>;
type Created = Readonly<{ artifactId: string; versionId: string }>;
type Facts = Record<string, unknown>;

/** A Playwright device profile as context options; the engine stays the file's. */
function deviceOptions(name: string): BrowserContextOptions {
  const { defaultBrowserType, ...options } = devices[name]!;
  void defaultBrowserType;
  return options;
}

function profiles(): Profile[] {
  const touch = engine !== "firefox";
  const sized = (name: string, width: number, height: number, scale: number, device: string): Profile => ({
    name, touch, options: { viewport: { width, height },
      ...(touch ? { deviceScaleFactor: scale, hasTouch: true, isMobile: true, userAgent: devices[device]!.userAgent } : {}) }
  });
  const tablet = engine === "webkit" ? "iPad Pro 11" : "Galaxy Tab S9";
  return [
    { name: "desktop-1440x900", touch: false, options: { viewport: { width: 1440, height: 900 } } },
    sized("tablet-portrait-820x1180", 820, 1180, 2, tablet),
    sized("tablet-landscape-1180x820", 1180, 820, 2, tablet),
    ...(engine === "webkit"
      ? [{ name: "phone-portrait-iphone-13", touch: true, options: deviceOptions("iPhone 13") },
        { name: "phone-landscape-iphone-13", touch: true, options: deviceOptions("iPhone 13 landscape") }]
      : [sized("phone-portrait-390x844", 390, 844, 3, "Pixel 7"), sized("phone-landscape-844x390", 844, 390, 3, "Pixel 7")])
  ];
}

function failureCode(error: unknown): string {
  return error instanceof Error && /^afc_[a-z0-9_]+$/u.test(error.message) ? error.message : "assertion_or_timeout";
}

/**
 * Creates one artifact with a signed-in API context, runs `body`, and always
 * prints the sanitized summary and removes the artifact.
 */
async function withArtifact(browser: Browser, baseURL: string, testInfo: TestInfo, file: string,
  create: (request: APIRequestContext) => Promise<Created>, body: (artifact: Created, summary: Facts) => Promise<void>): Promise<void> {
  const summary: Facts = { engine, file };
  const setup = await browser.newContext({ baseURL });
  let artifact: Created | null = null;
  try {
    await authenticateWithLocalToken(setup.request);
    artifact = await create(setup.request);
    await body(artifact, summary);
    summary.passed = true;
  } catch (error) {
    Object.assign(summary, { passed: false, failure: failureCode(error) });
    throw error;
  } finally {
    await testInfo.attach(`${engine}-${file}-summary.json`, { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
    console.log(`artifact_files_adaptive_summary ${JSON.stringify(summary)}`);
    if (artifact) await removeArtifact(setup.request, artifact.artifactId).catch(() => undefined);
    await setup.close();
  }
}

/**
 * Runs `check` once per profile in a fresh signed-in context and records its
 * facts in the summary as it goes, so a failure shows the profile it stopped at.
 */
async function onEachProfile(browser: Browser, baseURL: string, summary: Facts,
  check: (page: Page, profile: Profile, context: BrowserContext) => Promise<Facts>): Promise<void> {
  const results: Facts[] = [];
  summary.profiles = results;
  for (const profile of profiles()) {
    const context = await browser.newContext({ baseURL, ...profile.options });
    const result: Facts = { profile: profile.name, done: false };
    results.push(result);
    try {
      await authenticateWithLocalToken(context.request);
      Object.assign(result, await check(await context.newPage(), profile, context), { done: true });
    } finally {
      await context.close();
    }
  }
}

/** Opens the private viewer page; returns when the artifact frame attached. */
async function openViewer(page: Page, artifact: Created): Promise<number> {
  await page.goto(`/artifacts/${artifact.artifactId}/versions/${artifact.versionId}`, { timeout: 180_000 });
  const frame = page.locator(ARTIFACT_FRAME);
  await frame.waitFor({ state: "attached", timeout: 300_000 });
  const attachedAt = Date.now();
  await expect(frame, "the artifact frame is visible").toBeVisible({ timeout: 60_000 });
  return attachedAt;
}

/** The page never scrolls sideways and the frame fits the viewport's width; its height is recorded. */
async function layoutFacts(page: Page): Promise<Facts> {
  await expectNoHorizontalOverflow(page);
  const box = await frameBox(page);
  const viewport = page.viewportSize()!;
  const fitsWidth = box.x >= -1 && box.x + box.width <= viewport.width + 1;
  expect(fitsWidth, "the artifact frame fits the viewport width").toBe(true);
  return { fitsWidth, fitsHeight: box.y >= -1 && box.y + box.height <= viewport.height + 1,
    frame: { width: Math.round(box.width), height: Math.round(box.height) } };
}

async function expectNoArtifactError(page: Page, settleMs: number): Promise<void> {
  await page.waitForTimeout(settleMs);
  await expect(artifactErrorBanner(page), "the viewer shows no artifact error").toHaveCount(0);
}

const shotPath = (testInfo: TestInfo, file: string, profile: Profile, state: string) =>
  testInfo.outputPath(`${engine}-${file}-${profile.name}-${state}.png`);

/** A tap on touch profiles, a click otherwise. */
async function activate(target: Locator, profile: Profile): Promise<void> {
  if (profile.touch) await target.tap({ timeout: 15_000 });
  else await target.click({ timeout: 15_000 });
}

/** Leaves fullscreen or pointer lock a frame button may have entered, and declines an external-link prompt. */
async function settleAfterButton(page: Page): Promise<void> {
  await page.waitForTimeout(1_500);
  const linkDialog = page.getByRole("dialog", { name: "Open external link?" });
  if (await linkDialog.isVisible().catch(() => false)) await linkDialog.getByRole("button", { name: "Cancel" }).click();
  await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined).catch(() => undefined);
  await artifactFrame(page).locator("body").evaluate(() => {
    if (document.pointerLockElement) document.exitPointerLock();
    return document.fullscreenElement ? document.exitFullscreen() : undefined;
  }).catch(() => undefined);
}

const tag = () => randomUUID().slice(0, 8);

test("prism: a self-contained page runs its blob worker and canvas and fits every profile", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(20 * 60_000);
  const fixture = selfContainedHtml();
  await withArtifact(browser, baseURL!, testInfo, "prism", async (request) => {
    const upload = await uploadAttachment(request, { fileName: fixture.fileName, mimeType: fixture.mimeType, bytes: fixture.bytes });
    return createArtifactFromUploads(request, { title: `Prism check ${tag()}`, entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: fixture.mimeType, assetRef: upload.id }] });
  }, async (artifact, summary) => {
    await onEachProfile(browser, baseURL!, summary, async (page, profile) => {
      await openViewer(page, artifact);
      const frame = artifactFrame(page);
      await expect(frame.getByRole("heading", { name: fixture.expected.heading }), "the heading is visible").toBeVisible({ timeout: 60_000 });
      await expect(frame.locator(fixture.expected.workerResultSelector), "the blob: worker answers")
        .toHaveText(fixture.expected.workerResult, { timeout: 30_000 });
      const sky = frame.locator("#sky");
      await sky.scrollIntoViewIfNeeded();
      const box = await largestCanvasBox(page);
      const drawn = box !== null && luminanceStdDev(await clipCapture(page, box)) > NON_UNIFORM_STDDEV;
      expect(drawn, "the canvas is drawn").toBe(true);
      const layout = await layoutFacts(page);
      await expectNoArtifactError(page, 1_000);
      await page.screenshot({ path: shotPath(testInfo, "prism", profile, "open") });
      // The page has no button; a tap on its canvas must not break it.
      if (profile.touch) {
        await sky.tap({ timeout: 15_000 });
        await expectNoArtifactError(page, 500);
      }
      return { ...layout, worker: true, canvasDrawn: drawn, tapped: profile.touch };
    });
  });
});

test("site: a website ZIP opens its entry page, reads local files and follows links on every profile", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(25 * 60_000);
  const fixture = multiPageSiteZip();
  await withArtifact(browser, baseURL!, testInfo, "site", async (request) => {
    const upload = await uploadAttachment(request, { fileName: fixture.fileName, mimeType: fixture.mimeType, bytes: fixture.bytes },
      { workspace: true });
    return createArtifactFromUploads(request, { title: `Harborlight adaptive ${tag()}`, entrypoint: fixture.expected.entry,
      files: [{ path: fixture.fileName, mimeType: fixture.mimeType, assetRef: upload.id, unpack: true }] });
  }, async (artifact, summary) => {
    await onEachProfile(browser, baseURL!, summary, async (page, profile) => {
      await openViewer(page, artifact);
      const frame = artifactFrame(page);
      const heading = frame.locator("h1");
      await expect(heading, "the entry page opens").toHaveText(fixture.expected.headings["index.html"], { timeout: 60_000 });
      await expect(frame.locator("#data-value"), "fetch('data.json') reads the local file").toHaveText(fixture.expected.dataValue, { timeout: 30_000 });
      await expect(frame.locator("#img-width"), "img.src from a script loads the local image").toHaveText(String(fixture.expected.imageWidth), { timeout: 30_000 });
      const layout = await layoutFacts(page);
      await expectNoArtifactError(page, 500);
      await page.screenshot({ path: shotPath(testInfo, "site", profile, "home") });
      await activate(frame.locator("#about-link"), profile);
      await expect(heading, "the link opens the about page").toHaveText(fixture.expected.headings["about.html"], { timeout: 60_000 });
      await page.screenshot({ path: shotPath(testInfo, "site", profile, "about") });
      await activate(frame.locator("#home-link"), profile);
      await expect(heading, "the about page links back home").toHaveText(fixture.expected.headings["index.html"], { timeout: 60_000 });
      await expectNoArtifactError(page, 500);
      return { ...layout, localData: true, navigation: true, input: profile.touch ? "tap" : "click" };
    });
  });
});

type LoadSampler = Readonly<{ stop(): Promise<Facts> }>;

async function heapUsed(session: CDPSession): Promise<number | null> {
  const { metrics } = await session.send("Performance.getMetrics");
  return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? null;
}

/**
 * Peak resident memory of the browser's renderer processes (Linux VmHWM),
 * when the browser runs on this host; null otherwise.
 */
async function rendererPeakRss(browser: Browser): Promise<number | null> {
  if (process.platform !== "linux") return null;
  let session: CDPSession | null = null;
  try {
    session = await browser.newBrowserCDPSession();
    const info = await session.send("SystemInfo.getProcessInfo");
    let peak = 0;
    for (const entry of info.processInfo) {
      if (entry.type !== "renderer" || !Number.isSafeInteger(entry.id)) continue;
      const status = readFileSync(`/proc/${String(entry.id)}/status`, "utf8");
      const kib = Number(/^VmHWM:\s+(\d+)\s+kB/mu.exec(status)?.[1]);
      if (Number.isFinite(kib)) peak = Math.max(peak, kib * 1024);
    }
    return peak || null;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

/**
 * Samples the JS heap of the page and, when the artifact frame runs in its
 * own process, of the frame, every half second until stopped (Chromium only).
 */
async function sampleLoad(browser: Browser, context: BrowserContext, page: Page): Promise<LoadSampler> {
  const pageSession = await context.newCDPSession(page);
  await pageSession.send("Performance.enable");
  let frameSession: CDPSession | null = null;
  const tried = new Set<unknown>();
  let pagePeak = 0;
  let framePeak = 0;
  let running = true;
  const sample = async () => {
    pagePeak = Math.max(pagePeak, await heapUsed(pageSession).catch(() => null) ?? 0);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame() && candidate.url() === "about:srcdoc");
    if (!frameSession && frame && !tried.has(frame)) {
      tried.add(frame);
      // Only an out-of-process frame has a session of its own.
      frameSession = await context.newCDPSession(frame).catch(() => null);
      await frameSession?.send("Performance.enable").catch(() => undefined);
    }
    if (frameSession) framePeak = Math.max(framePeak, await heapUsed(frameSession).catch(() => null) ?? 0);
  };
  const loop = (async () => {
    while (running) {
      await sample().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  const mib = (bytes: number) => bytes ? Number((bytes / MIB).toFixed(1)) : null;
  return {
    async stop() {
      running = false;
      await loop;
      const rss = await rendererPeakRss(browser);
      await pageSession.detach().catch(() => undefined);
      await (frameSession as CDPSession | null)?.detach().catch(() => undefined);
      return { jsHeapUsedPeakMiB: mib(pagePeak), frameJsHeapUsedPeakMiB: mib(framePeak), outOfProcessFrame: frameSession !== null,
        rendererPeakRssMiB: rss ? mib(rss) : null };
    }
  };
}

test("large-html: the operator's scene draws, fits and takes a tap on every profile; phone load metrics in Chromium", async ({ browser, baseURL }, testInfo) => {
  const path = privateLargeHtmlPath();
  test.skip(!path, "requires the operator's private large page (AIQSA_AFC_LARGE_HTML or AIQSA_AFC_PRIVATE_DIR)");
  test.setTimeout(60 * 60_000);
  await withArtifact(browser, baseURL!, testInfo, "large-html", async (request) => {
    const upload = await uploadAttachment(request, { fileName: basename(path!), mimeType: "text/html", bytes: readFileSync(path!) });
    return createArtifactFromUploads(request, { title: `Large scene check ${tag()}`, entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", assetRef: upload.id }] });
  }, async (artifact, summary) => {
    await onEachProfile(browser, baseURL!, summary, async (page, profile, context) => {
      const measured = engine === "chromium" && profile.name.startsWith("phone-portrait");
      const sampler = measured ? await sampleLoad(browser, context, page) : null;
      const openedAt = Date.now();
      const attachedAt = await openViewer(page, artifact);
      const drawn = await firstNonUniform(page, () => largestCanvasBox(page), attachedAt, 240_000);
      // The heap keeps growing while the scene settles; sample a little longer before reading the peak.
      if (sampler) await page.waitForTimeout(5_000);
      const metrics = await sampler?.stop();
      expect(drawn !== null, "the scene draws within four minutes of the frame attaching").toBe(true);
      const layout = await layoutFacts(page);
      await expectNoArtifactError(page, 2_000);
      await page.screenshot({ path: shotPath(testInfo, "large-html", profile, "scene") });
      let button = false;
      if (profile.touch) {
        const target = await firstReachableButton(page);
        button = target !== null;
        if (target) {
          await target.tap({ timeout: 15_000 });
          await settleAfterButton(page);
          await expectNoArtifactError(page, 500);
          await page.screenshot({ path: shotPath(testInfo, "large-html", profile, "after-tap") });
        }
      }
      return { ...layout, frameAttachMs: attachedAt - openedAt, firstNonUniformMs: drawn!.ms, tappedButton: button,
        ...(metrics ? { metrics } : {}) };
    });
  });
});
