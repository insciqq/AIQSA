import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { LOCAL_MCP_MEMBER } from "../../prisma/local-seed-fixtures";
import { syntheticPng } from "../support/rasterFixtures";
import { prepareWorkspaceFakeContext } from "./support/workspaceFixture";
import { loginWithPassword, selectFakeModel, setWorkspaceEnabled, startNewChat } from "./support/workspace";

/**
 * A valid static PNG named `.jpeg` is admitted under its decoded format on the
 * direct composer path (Workspace off and on) and the multipart session path.
 * Every image here is synthetic; no user file is copied into the fixture.
 */
const prisma = new PrismaClient();
const png = syntheticPng();
const pngChecksum = createHash("sha256").update(png).digest("hex");
let originalPolicy: { enabled: boolean } | null = null;
let restoreFakeContext: (() => Promise<void>) | null = null;

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async () => {
  restoreFakeContext = await prepareWorkspaceFakeContext(prisma);
  originalPolicy = await prisma.workspacePolicy.findUniqueOrThrow({ select: { enabled: true }, where: { id: "installation" } });
  await prisma.workspacePolicy.update({ where: { id: "installation" }, data: { enabled: true } });
});

test.afterAll(async () => {
  try {
    if (originalPolicy) await prisma.workspacePolicy.update({ where: { id: "installation" }, data: originalPolicy });
    await restoreFakeContext?.();
  } finally { await prisma.$disconnect(); }
});

async function openComposer(page: Page, workspace: boolean): Promise<void> {
  await loginWithPassword(page, LOCAL_MCP_MEMBER);
  // Compact viewports keep chat navigation in a closed drawer; open it the way
  // a phone user does before choosing New chat.
  if (!(await page.getByRole("complementary", { name: "Chat navigation" }).isVisible())) {
    await page.getByRole("button", { name: "Open sidebar", exact: true }).click();
  }
  await startNewChat(page);
  await selectFakeModel(page);
  await setWorkspaceEnabled(page, workspace);
  // The toggle step closes the Workspace layer with Escape wherever focus went,
  // so later assertions and screenshots see the composer notices.
  await expect(page.getByRole("menu", { name: "Workspace", exact: true })).toBeHidden();
}

/** Every sampled point of the element hits the element itself, not a layer above it. */
async function expectUnobscured(locator: Locator): Promise<void> {
  await expect(locator).toBeInViewport({ ratio: 1 });
  await expect.poll(() => locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const y = box.top + box.height / 2;
    return [box.left + 2, box.left + box.width / 2, box.right - 2].every((x) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === element || element.contains(hit));
    });
  }), { message: "the notice must not be covered by another layer" }).toBe(true);
}

function chip(page: Page, fileName: string) {
  return page.getByRole("region", { name: "Attachments" }).getByRole("listitem").filter({ hasText: fileName });
}

/** Attaches through the composer and returns the direct-upload response body. */
async function attachDirect(page: Page, file: { buffer: Buffer; mimeType: string; name: string }) {
  const requests: string[] = [];
  const track = (request: { url(): string; method(): string }) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/uploads") && request.method() === "POST") requests.push(path);
  };
  page.on("request", track);
  try {
    const response = page.waitForResponse((candidate) =>
      new URL(candidate.url()).pathname === "/api/uploads" && candidate.request().method() === "POST");
    await page.getByLabel("Attach files").setInputFiles(file);
    const settled = await response;
    expect(requests).toEqual(["/api/uploads"]);
    return { status: settled.status(), body: await settled.json() as { attachment?: { id: string; fileName: string; mimeType: string } } };
  } finally { page.off("request", track); }
}

async function expectDownload(page: Page, attachmentId: string): Promise<void> {
  const download = await page.request.get(`/api/attachments/${attachmentId}/content`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toBe("image/png");
  expect(download.headers()["content-disposition"]).toContain("synthetic.png");
  expect(createHash("sha256").update(await download.body()).digest("hex")).toBe(pngChecksum);
}

for (const mimeType of ["image/jpeg", "image/png"]) {
  test(`composer with Workspace off admits synthetic.jpeg (${mimeType}) as synthetic.png`, async ({ page }) => {
    await openComposer(page, false);
    const { status, body } = await attachDirect(page, { buffer: png, mimeType, name: "synthetic.jpeg" });
    expect(status).toBe(200);
    expect(body.attachment).toMatchObject({ fileName: "synthetic.png", mimeType: "image/png" });
    await expect(chip(page, "synthetic.png")).toHaveAttribute("data-attachment-status", "ready", { timeout: 30_000 });
    // The browser neither rejected the file nor switched Workspace on for it.
    await expect(page.getByRole("button", { name: /^Workspace details\. Off\./u })).toBeVisible();
    await expectDownload(page, body.attachment!.id);
    const stored = await prisma.attachment.findUniqueOrThrow({ where: { id: body.attachment!.id },
      select: { checksum: true, fileName: true, kind: true, mimeType: true } });
    expect(stored).toEqual({ checksum: pngChecksum, fileName: "synthetic.png", kind: "image", mimeType: "image/png" });
  });
}

test("composer with Workspace on keeps an ordinary-size raster pair on the direct path", async ({ page }) => {
  await openComposer(page, true);
  const { status, body } = await attachDirect(page, { buffer: png, mimeType: "image/png", name: "synthetic.jpeg" });
  expect(status).toBe(200);
  expect(body.attachment).toMatchObject({ fileName: "synthetic.png", mimeType: "image/png" });
  await expect(chip(page, "synthetic.png")).toHaveAttribute("data-attachment-status", "ready", { timeout: 30_000 });
  await expectDownload(page, body.attachment!.id);
});

test("multipart sessions settle a PNG declared as .jpeg under the decoded name", async ({ page, baseURL }) => {
  await loginWithPassword(page, LOCAL_MCP_MEMBER);
  const headers = { origin: new URL(baseURL!).origin };
  const created = await page.request.post("/api/uploads/sessions", { headers, data: {
    byteSize: png.byteLength, fileName: "synthetic.jpeg", mimeType: "image/jpeg", projectId: null, idempotencyKey: randomUUID()
  } });
  expect(created.status()).toBe(201);
  const session = await created.json() as { id: string };
  const part = await page.request.put(`/api/uploads/sessions/${session.id}/parts/1`, { data: png, headers: {
    ...headers, "content-type": "application/octet-stream", "x-upload-sha256": pngChecksum
  } });
  expect(part.ok()).toBe(true);
  expect((await page.request.post(`/api/uploads/sessions/${session.id}/complete`, { headers })).ok()).toBe(true);
  let settled: { state: string; errorCode: string | null; attachment: { id: string; fileName: string; mimeType: string; kind: string } | null } | null = null;
  await expect.poll(async () => {
    settled = await (await page.request.get(`/api/uploads/sessions/${session.id}`)).json();
    return settled!.state;
  }, { timeout: 60_000 }).toBe("completed");
  expect(settled!.attachment).toMatchObject({ fileName: "synthetic.png", kind: "file", mimeType: "image/png" });
  const row = await prisma.attachmentUpload.findUniqueOrThrow({ where: { id: session.id }, select: { fileName: true, mimeType: true } });
  expect(row).toEqual({ fileName: "synthetic.jpeg", mimeType: "image/jpeg" });
  await expectDownload(page, settled!.attachment!.id);
});

for (const viewport of [{ width: 1440, height: 900, name: "desktop" }, { width: 390, height: 844, name: "phone" }]) {
  test(`a truncated PNG named .jpeg shows the image_invalid notice (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openComposer(page, false);
    const { status, body } = await attachDirect(page, { buffer: png.subarray(0, 40), mimeType: "image/jpeg", name: "synthetic.jpeg" });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "image_invalid" });
    const notice = page.getByText(
      "synthetic.jpeg: This image could not be verified. Check that it opens correctly, or choose another file.",
      { exact: true }
    );
    await expect(notice).toBeVisible();
    await expect(page.getByRole("menu", { name: "Workspace", exact: true })).toBeHidden();
    await expectUnobscured(notice);
    await expect(page.getByRole("region", { name: "Attachments" }).getByRole("listitem")).toHaveCount(0);
    // Saved as files: Vision review needs them even when the test passes.
    await page.screenshot({ path: testInfo.outputPath(`image-invalid-${viewport.name}-${viewport.width}x${viewport.height}.png`) });
  });
}
