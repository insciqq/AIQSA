import type { Locator, Page, TestInfo } from "@playwright/test";

/**
 * Screenshots of one state in both themes at the standard sizes, written to
 * the test output directory for a human or model review. Captures are
 * evidence, not assertions: page overflow is measured and reported, and the
 * calling spec decides what to assert, per size, with the layout assertions.
 * The viewport, theme and window scroll found on entry are restored.
 */

export const CAPTURE_THEMES = ["light", "dark"] as const;

export type CaptureTheme = (typeof CAPTURE_THEMES)[number];

export type CaptureSize = Readonly<{ height: number; width: number }>;

export const CAPTURE_SIZES: readonly CaptureSize[] = [
  { height: 900, width: 1440 },
  { height: 768, width: 1024 },
  { height: 1024, width: 768 },
  { height: 844, width: 390 },
  { height: 390, width: 844 }
];

export type CaptureStep = Readonly<{ size: CaptureSize; theme: CaptureTheme }>;

export type CaptureShot = CaptureStep & Readonly<{
  /** Horizontal page overflow in CSS pixels; 0 when the page fits. */
  overflow: Readonly<{ body: number; document: number }>;
  path: string;
}>;

export type CaptureOptions = Readonly<{
  /** Scrolled into view at every size before the caller's checks and the image. */
  anchor?: Locator;
  /** The caller's per-size assertions, run after settling and before the image. */
  atEachSize?: (step: CaptureStep) => Promise<void>;
  fullPage?: boolean;
  /** Extra wait after layout settles, for transitions the reduced-motion setting does not stop. */
  settleMs?: number;
  sizes?: readonly CaptureSize[];
  themes?: readonly CaptureTheme[];
}>;

type ThemeState = Readonly<{ colorScheme: string | null; theme: string | null }>;

function fileStem(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "capture";
}

async function readTheme(page: Page): Promise<ThemeState> {
  return page.evaluate(() => ({
    colorScheme: document.documentElement.getAttribute("data-color-scheme"),
    theme: document.documentElement.getAttribute("data-theme")
  }));
}

async function writeTheme(page: Page, state: ThemeState): Promise<void> {
  await page.evaluate(({ colorScheme, theme }) => {
    const root = document.documentElement;
    for (const [attribute, value] of [["data-theme", theme], ["data-color-scheme", colorScheme]] as const) {
      if (value === null) root.removeAttribute(attribute);
      else root.setAttribute(attribute, value);
    }
  }, state);
}

async function settle(page: Page, settleMs: number): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

async function measureOverflow(page: Page): Promise<CaptureShot["overflow"]> {
  return page.evaluate(() => ({
    body: Math.max(0, document.body.scrollWidth - document.body.clientWidth),
    document: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
  }));
}

/**
 * Runs `body` once per theme with the page switched to it, at its current
 * size and state (an open menu stays open), for specs with their own sizes and
 * file names; the theme found on entry is restored.
 */
export async function forEachCaptureTheme(
  page: Page,
  body: (theme: CaptureTheme) => Promise<void>,
  themes: readonly CaptureTheme[] = CAPTURE_THEMES
): Promise<void> {
  const originalTheme = await readTheme(page);
  try {
    for (const theme of themes) {
      await writeTheme(page, { colorScheme: theme, theme });
      await settle(page, 100);
      await body(theme);
    }
  } finally {
    await writeTheme(page, originalTheme).catch(() => undefined);
    await settle(page, 0).catch(() => undefined);
  }
}

/**
 * Captures `name` as `<name>-<theme>-<width>x<height>.png` for every theme
 * and size. Any overflow is also added to the test's annotations.
 */
export async function captureState(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: CaptureOptions = {}
): Promise<CaptureShot[]> {
  const stem = fileStem(name);
  const originalViewport = page.viewportSize();
  const originalTheme = await readTheme(page);
  const originalScroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const shots: CaptureShot[] = [];
  const restore = async () => {
    await writeTheme(page, originalTheme);
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.evaluate(({ x, y }) => window.scrollTo(x, y), originalScroll);
    await settle(page, 0);
  };
  try {
    for (const theme of options.themes ?? CAPTURE_THEMES) {
      await writeTheme(page, { colorScheme: theme, theme });
      for (const size of options.sizes ?? CAPTURE_SIZES) {
        await page.setViewportSize({ height: size.height, width: size.width });
        await settle(page, options.settleMs ?? 250);
        if (options.anchor) await options.anchor.scrollIntoViewIfNeeded();
        await options.atEachSize?.({ size, theme });
        const path = testInfo.outputPath(`${stem}-${theme}-${size.width}x${size.height}.png`);
        const overflow = await measureOverflow(page);
        await page.screenshot({ animations: "disabled", fullPage: options.fullPage ?? false, path });
        shots.push({ overflow, path, size, theme });
      }
    }
  } catch (error) {
    // The caller's failure is the finding; a restore on a broken page must not replace it.
    await restore().catch(() => undefined);
    throw error;
  }
  await restore();
  const overflowing = shots.filter((shot) => shot.overflow.body > 0 || shot.overflow.document > 0);
  if (overflowing.length > 0) {
    testInfo.annotations.push({
      description: overflowing
        .map((shot) => `${stem} ${shot.theme} ${shot.size.width}x${shot.size.height}: body +${shot.overflow.body}, document +${shot.overflow.document}`)
        .join(" | "),
      type: "capture-overflow"
    });
  }
  return shots;
}
