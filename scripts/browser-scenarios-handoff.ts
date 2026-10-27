/**
 * The user of scenario S5 (`scripts/browser-scenarios-support.ts`), driven by
 * Playwright through the real chat page while the run is live: it opens the
 * chat with the harness's session, waits for the live Browser panel's handoff
 * card, signs in to saucedemo.com by clicking and typing into the live frame
 * (`features/browser-live/BrowserLivePanelV2.tsx`) and presses Done.
 *
 * Before the real username it types the run's marker into the username field
 * and erases it, so the run's leak check can prove typed values stay out of
 * stored rows. Typed values are never printed, logged or returned: the
 * evidence holds counts, booleans and codes. The browser is closed on every
 * path, including the harness's abort.
 *
 * Needs a Chromium for Playwright on the harness host: Playwright's own
 * (`npx playwright install chromium`, or the Playwright image), or an
 * installed browser named by AIQSA_BROWSER_SCENARIOS_BROWSER_CHANNEL (for
 * example `chrome`).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Locator, type Page } from "@playwright/test";
import {
  BrowserScenarioError, SAUCEDEMO_LOGIN_VALUES, frameToClientPoint, saucedemoUsernameFramePoint,
  type ClientRect, type InteractionEvidence, type ScenarioInteraction
} from "./browser-scenarios-support";

/** A desktop window, as on the live panel's own desktop check. */
const VIEWPORT = Object.freeze({ height: 900, width: 1440 });
/**
 * The panel sends one input at a time and waits for each answer, and its queue
 * refuses a batch once 64 inputs wait ("Too much input at once"). Over a
 * remote link an answer takes about a tenth of a second, so the harness types
 * like a person, about six inputs a second (a character is one input, a named
 * key two: down and up), and lets the queue drain between fields. Measured on
 * the final run (2026-10-27): at 45 ms per key the queue overflowed and both
 * sign-in attempts lost keys.
 */
const KEY_DELAY_MS = 150;
const KEY_PRESS_PAUSE_MS = 300;
const DRAIN_PAUSE_MS = 2_000;
const SIGNED_IN_WAIT_MS = 25_000;
/** A second sign-in handoff gets one more try (the first may have missed); any other handoff gets Cancel. */
const SIGN_IN_HANDOFFS_MAX = 2;

const fail = (code: string): never => { throw new BrowserScenarioError(code); };

function sessionCookies(cookie: string, url: string) {
  const cookies = cookie.split(";").map((pair) => pair.trim()).flatMap((pair) => {
    const split = pair.indexOf("=");
    return split > 0 ? [{ name: pair.slice(0, split), url, value: pair.slice(split + 1) }] : [];
  });
  return cookies.length > 0 ? cookies : fail("interaction_session_missing");
}

function browserChannel(): string | undefined {
  const channel = process.env.AIQSA_BROWSER_SCENARIOS_BROWSER_CHANNEL?.trim();
  if (!channel) return undefined;
  return /^[a-z][a-z0-9-]{0,31}$/u.test(channel) ? channel : fail("browser_channel_invalid");
}

async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await sleep(KEY_PRESS_PAUSE_MS);
}

/** Types at a person's pace, then waits for the panel's queue to deliver it. */
async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: KEY_DELAY_MS });
  await sleep(DRAIN_PAUSE_MS);
}

/** Select all and erase; `characters` more Backspaces cover a page that ignores the shortcut. */
async function clearField(page: Page, characters = 0): Promise<void> {
  await press(page, "Control+A");
  await press(page, "Backspace");
  for (let index = 0; index < characters; index += 1) await press(page, "Backspace");
  await sleep(DRAIN_PAUSE_MS);
}

/** The frame's box once the thread stops moving it (it may still settle its scroll). */
async function stableBox(image: Locator): Promise<ClientRect> {
  let previous = await image.boundingBox();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(100);
    const current = await image.boundingBox();
    if (previous && current && Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y) < 0.5) return current;
    previous = current;
  }
  return previous ?? fail("frame_unmeasured");
}

/**
 * Focuses saucedemo's username field in the live page: a click on the field
 * where the sign-in page shows it, or a click on the page's empty corner and
 * Tab, which moves focus to the first field.
 */
async function focusUsername(page: Page, stage: Locator, image: Locator, strategy: "field" | "keyboard"): Promise<void> {
  await stage.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center" }));
  const box = await stableBox(image);
  const frame = await image.evaluate((element: HTMLImageElement) => ({ height: element.naturalHeight, width: element.naturalWidth }));
  const point = frameToClientPoint(strategy === "field" ? saucedemoUsernameFramePoint(frame) : { x: 5, y: 5 }, frame, box);
  // Nothing (the composer dock, the chat header) may cover the point the user clicks.
  const onFrame = await page.evaluate(({ x, y }) =>
    Boolean(document.elementFromPoint(x, y)?.closest("[data-testid='browser-live-stage']")), point);
  if (!onFrame) fail("frame_point_covered");
  await page.mouse.click(point.x, point.y);
  // The click focuses the frame, so the keyboard now types into the page.
  if (!await stage.evaluate((element) => element === document.activeElement)) fail("frame_not_focused");
  if (strategy === "keyboard") await press(page, "Tab");
}

/**
 * Optional local screenshots of the chat page for diagnosing the interaction
 * (AIQSA_BROWSER_SCENARIOS_SHOTS_DIR, an existing directory on the harness
 * host). They show the synthetic chat and the public demo page; they are
 * never uploaded or printed, and a failed capture is ignored.
 */
async function shot(page: Page, name: string): Promise<void> {
  const directory = process.env.AIQSA_BROWSER_SCENARIOS_SHOTS_DIR?.trim();
  if (!directory) return;
  await page.screenshot({ path: `${directory}/${Date.now()}-${name}.png` }).catch(() => undefined);
}

type Evidence = {
  controlAtSignIn: string | null;
  pageShown: boolean | null;
  cancelledHandoffs: number;
  doneHandoffs: number;
  handoffs: number;
  signInAttempts: number;
  signInHandoffs: number;
  signInStrategy: string | null;
  signedIn: boolean;
};

/** Signs in through the live frame; true once the page the agent shares is saucedemo's inventory. */
async function signIn(page: Page, marker: string, evidence: Evidence, signal: AbortSignal): Promise<boolean> {
  const [username, password] = SAUCEDEMO_LOGIN_VALUES;
  if (!username || !password) return fail("interaction_login_missing");
  const stage = page.getByTestId("browser-live-stage");
  const image = stage.locator("img");
  await image.waitFor({ state: "visible", timeout: 60_000 });
  // The agent hands over on the sign-in page; let its picture settle.
  evidence.pageShown = await page.locator(".v2-browser-live-url", { hasText: "saucedemo.com" }).waitFor({ timeout: 30_000 })
    .then(() => true, () => false);
  await sleep(1_500, undefined, { signal });
  for (const strategy of ["field", "keyboard"] as const) {
    evidence.signInAttempts += 1;
    // Typing reaches the page only while the panel hands control to the user.
    evidence.controlAtSignIn = await stage.getAttribute("data-control");
    await shot(page, `attempt-${evidence.signInAttempts}-before`);
    await focusUsername(page, stage, image, strategy);
    if (evidence.signInAttempts === 1) {
      // A value typed by mistake and erased again: the leak check looks for it in every stored row.
      await typeText(page, marker);
      await clearField(page, marker.length + 2);
    }
    await clearField(page);
    await typeText(page, username);
    await press(page, "Tab");
    await clearField(page);
    await typeText(page, password);
    await shot(page, `attempt-${evidence.signInAttempts}-typed`);
    await press(page, "Enter");
    const signedIn = await page.locator(".v2-browser-live-url", { hasText: "/inventory.html" })
      .waitFor({ timeout: SIGNED_IN_WAIT_MS }).then(() => true, () => false);
    await shot(page, `attempt-${evidence.signInAttempts}-after`);
    if (signedIn) {
      evidence.signedIn = true;
      evidence.signInStrategy = strategy;
      return true;
    }
  }
  return false;
}

/** The handoff opens the panel on its own; a panel the page shows collapsed while it needs the user is opened. */
async function openPanelThatNeedsUser(page: Page): Promise<void> {
  const bar = page.locator("[data-testid='browser-live'][data-needs-user] .v2-browser-live-bar[aria-expanded='false']");
  if (await bar.count() > 0) await bar.first().click({ timeout: 5_000 }).catch(() => undefined);
}

export const signInThroughHandoff: ScenarioInteraction = async ({ baseUrl, chatId, cookie, marker, signal }) => {
  const evidence: Evidence = { cancelledHandoffs: 0, controlAtSignIn: null, doneHandoffs: 0, handoffs: 0, pageShown: null,
    signInAttempts: 0, signInHandoffs: 0, signInStrategy: null, signedIn: false };
  const result = (): InteractionEvidence => ({ ...evidence });
  if (signal.aborted) return result();
  if (!/^[A-Za-z0-9]{16,64}$/u.test(marker)) fail("interaction_marker_invalid");
  const channel = browserChannel();
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const close = () => { void browser.close().catch(() => undefined); };
  signal.addEventListener("abort", close, { once: true });
  try {
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { ...VIEWPORT } });
    await context.addCookies(sessionCookies(cookie, baseUrl));
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`/c/${encodeURIComponent(chatId)}`, { waitUntil: "domcontentloaded" });
    if (!new URL(page.url()).pathname.startsWith("/c/")) fail("interaction_chat_not_opened");
    const card = page.getByTestId("browser-live-handoff");
    while (!signal.aborted) {
      if (!await card.isVisible().catch(() => false)) {
        await openPanelThatNeedsUser(page);
        await sleep(1_000, undefined, { signal });
        continue;
      }
      evidence.handoffs += 1;
      let answer: "Cancel" | "Done" = "Cancel";
      if (await card.getAttribute("data-reason") === "sign_in" && !evidence.signedIn && evidence.signInHandoffs < SIGN_IN_HANDOFFS_MAX) {
        evidence.signInHandoffs += 1;
        if (await signIn(page, marker, evidence, signal)) answer = "Done";
      }
      await card.getByRole("button", { exact: true, name: answer }).click();
      if (answer === "Done") evidence.doneHandoffs += 1;
      else evidence.cancelledHandoffs += 1;
      // The card leaves once the server ended the handoff (or the run ended with it).
      await card.waitFor({ state: "hidden", timeout: 60_000 }).catch(() => fail("handoff_answer_not_accepted"));
    }
  } catch (error) {
    // The run ended: closing the browser interrupted whatever was waiting.
    if (signal.aborted) return result();
    throw error instanceof BrowserScenarioError ? error : new BrowserScenarioError("interaction_failed");
  } finally {
    signal.removeEventListener("abort", close);
    await browser.close().catch(() => undefined);
  }
  return result();
};
