/**
 * The user of scenario T's acts `edit` and `start` (`scripts/smoke-subagents-paid.ts`), driven by Playwright through the real chat page while a real
 * research plan's window is open: it waits for the card, optionally changes a step, and presses the button. Nothing typed comes from a model and
 * nothing read from the page leaves here: the evidence holds counts and booleans. The browser is closed on every path, including the harness's abort.
 */
import { chromium } from "@playwright/test";
import { browserChannel, sessionCookies } from "./browser-scenarios-handoff";
import type { InteractionEvidence, ScenarioInteraction } from "./browser-scenarios-support";

/** The card follows scoping, which may take its three minutes and a model's slow first response. */
const CARD_WAIT_MS = 8 * 60_000;
/** After the press the plan stands at once, or after one more model call when it was changed. */
const CARD_GONE_WAIT_MS = 4 * 60_000;
const STEP_ADDITION = " (только независимые источники и точные модели)";

export function planInBrowser(act: "edit" | "start"): ScenarioInteraction {
  return async ({ baseUrl, chatId, cookie, signal }): Promise<InteractionEvidence> => {
    const evidence = { cardGone: false, cardShown: false, clockShown: false, edited: false, pressed: false };
    if (signal.aborted) return evidence;
    const channel = browserChannel();
    const browser = await chromium.launch({ headless: true, ...channel ? { channel } : {} });
    const close = () => { void browser.close().catch(() => undefined); };
    signal.addEventListener("abort", close, { once: true });
    try {
      const context = await browser.newContext({ baseURL: baseUrl, viewport: { height: 900, width: 1440 } });
      await context.addCookies(sessionCookies(cookie, baseUrl));
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await page.goto(`/c/${encodeURIComponent(chatId)}`, { waitUntil: "domcontentloaded" });
      const card = page.getByTestId("research-plan-card").last();
      await card.waitFor({ state: "visible", timeout: CARD_WAIT_MS });
      evidence.cardShown = true;
      evidence.clockShown = await card.getByTestId("research-plan-clock").isVisible();
      if (act === "edit") {
        await card.getByRole("button", { exact: true, name: "Edit" }).click();
        const step = card.getByLabel("Step 1", { exact: true });
        await step.fill(`${await step.inputValue()}${STEP_ADDITION}`);
        evidence.edited = true;
      }
      await card.getByRole("button", { exact: true, name: "Начать поиск" }).click();
      evidence.pressed = true;
      await card.waitFor({ state: "hidden", timeout: CARD_GONE_WAIT_MS });
      evidence.cardGone = true;
      return evidence;
    } finally {
      signal.removeEventListener("abort", close);
      await browser.close().catch(() => undefined);
    }
  };
}
