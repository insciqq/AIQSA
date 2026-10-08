import { expect, test, type Page } from "@playwright/test";
import type { ArtifactBundleFile } from "../../lib/server/artifacts/bundle";
import { injectArtifactArrivalFragment } from "../../components/artifacts/artifactNavigation";
import { productionViewerPolicies, renderArtifactPage, startRuntimeServer } from "./harness";

// A link to another page of the artifact can name an anchor: the viewer hands the
// fragment to the next page's bridge, which scrolls there once that page has loaded.

const files: ArtifactBundleFile[] = [
  { path: "index.html", mimeType: "text/html", text: '<!doctype html><title>Home</title><a href="docs/guide.html#part%20two">Guide</a>' },
  { path: "docs/guide.html", mimeType: "text/html", text: '<!doctype html><title>Guide</title><div style="height:3000px">Part one</div><h1 id="part two">Part two</h1><img alt="" src="../pixel.png">' },
  { path: "pixel.png", mimeType: "image/png", base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }
];

const artifactScroll = (page: Page) => page.frames().find(frame => frame !== page.mainFrame())!.evaluate(() => Math.round(window.scrollY));

test("a page opened from a link with a fragment scrolls to its anchor after load, and only then", async ({ page }) => {
  const server = await startRuntimeServer();
  try {
    const guide = renderArtifactPage(files, "docs/guide.html");
    await page.goto(server.hostPage(injectArtifactArrivalFragment(guide, "part%20two"), productionViewerPolicies()));
    await expect(page.frameLocator("#artifact").getByRole("heading", { name: "Part two" })).toBeInViewport();
    expect(await artifactScroll(page)).toBeGreaterThan(2000);

    await page.goto(server.hostPage(guide, productionViewerPolicies()));
    await expect(page.frameLocator("#artifact").getByText("Part one")).toBeInViewport();
    expect(await artifactScroll(page)).toBe(0);
    expect(server.hits).toEqual([]);
  } finally { await server.close(); }
});
