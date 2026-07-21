import { expect, type Locator, type Page } from "@playwright/test";

export async function runAccountMenuAction(
  page: Page,
  name: "Command palette" | "Settings"
): Promise<Locator> {
  const trigger = page.getByRole("button", { name: "Account menu" });
  await trigger.click();
  await page.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name }).click();
  return trigger;
}

export async function expectComposerBeforeDetails(page: Page): Promise<void> {
  const composerBox = await page.getByTestId("composer-control-bar").boundingBox();
  const detailsBox = await page.getByTestId("details-pane").boundingBox();

  expect(composerBox).toBeTruthy();
  expect(detailsBox).toBeTruthy();
  expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(detailsBox!.x + 1);
}

export async function themeContrastMetrics(page: Page): Promise<{
  action: number;
  focus: number;
  text: number;
}> {
  return page.evaluate(() => {
    const parse = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (rgb: number[]) => {
      const linear = rgb.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const contrast = (first: number[], second: number[]) => {
      const firstLuminance = luminance(first);
      const secondLuminance = luminance(second);
      return (
        (Math.max(firstLuminance, secondLuminance) + 0.05) /
        (Math.min(firstLuminance, secondLuminance) + 0.05)
      );
    };
    const rootStyles = getComputedStyle(document.documentElement);
    const shell = document.querySelector<HTMLElement>('[data-testid="app-shell"]');
    if (!shell) return { action: 0, focus: 0, text: 0 };
    const shellStyles = getComputedStyle(shell);
    const canvas = parse(rootStyles.getPropertyValue("--surface-canvas"));
    const accent = parse(rootStyles.getPropertyValue("--accent-cyan"));
    const focus = accent.map((channel, index) => channel * 0.55 + canvas[index]! * 0.45);

    return {
      action: contrast(accent, canvas),
      focus: contrast(focus, canvas),
      text: contrast(parse(shellStyles.color), parse(shellStyles.backgroundColor))
    };
  });
}
