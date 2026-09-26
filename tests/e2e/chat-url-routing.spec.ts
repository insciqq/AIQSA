import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { parseChatRoutePath } from "../../lib/domain/chatRoute";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { SESSION_COOKIE_NAME } from "../../lib/server/auth/constants";
import { hashPassword } from "../../lib/server/auth/password";
import { provisionActiveUser } from "../../lib/server/auth/provisioning";
import { LOCAL_MCP_MEMBER, LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { chooseSearchStrategy } from "./shell/composer";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";
import { startOAuthMcpEndpoint } from "./support/oauthMcpEndpoint";
import { selectFakeModel, setWorkspaceEnabled } from "./support/workspace";

type Viewport = Readonly<{ width: number; height: number }>;
type Credentials = Readonly<{ email: string; password: string }>;
const desktop: Viewport = { width: 1440, height: 900 };
const phone: Viewport = { width: 390, height: 844 };

function exactPath(path: string): RegExp {
  return new RegExp(`^[^?#]*//[^/]+${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
}

async function useAppearance(page: Page, context: BrowserContext, baseURL: string, theme: "dark" | "light", size: Viewport = desktop) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: theme });
  await context.addCookies([{ name: "aiqsa.theme", value: theme, url: baseURL }]);
}

async function createChat(page: Page, title: string): Promise<string> {
  const response = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
  expect(response.status()).toBe(201);
  return (await response.json()).chat.id as string;
}

async function deleteChats(page: Page, chatIds: readonly (string | null | undefined)[]): Promise<void> {
  for (const chatId of chatIds) {
    if (chatId) await page.request.delete(`/api/chats/${chatId}`).catch(() => undefined);
  }
}

async function submitLogin(page: Page, user: Credentials): Promise<void> {
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signInWithPassword(page: Page, user: Credentials): Promise<void> {
  await page.goto("/login");
  await submitLogin(page, user);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
}

async function chooseChat(page: Page, title: string): Promise<void> {
  const navigation = page.getByRole("complementary", { name: "Chat navigation" });
  if (!(await navigation.isVisible())) await page.getByRole("button", { name: "Open sidebar" }).click();
  await navigation.getByRole("treeitem", { name: title, exact: true }).click();
}

async function prepareFakeSend(page: Page): Promise<void> {
  if (await page.getByRole("button", { name: /^Workspace details\./u }).isVisible()) await setWorkspaceEnabled(page, false);
  await selectFakeModel(page);
  if (await page.getByRole("button", { name: /^Choose web search/u }).isVisible()) await chooseSearchStrategy(page, "Off");
}

function admission(page: Page) {
  return page.waitForResponse((response) => response.request().method() === "POST" &&
    /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(response.url()).pathname));
}

test("the new chat takes its own address on first send without remounting, and / never restores a chat", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await useAppearance(page, context, baseURL!, "light");
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const existing = await createChat(page, `Routing history ${suffix}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  let sent: string | null = null;
  try {
    await page.goto(`/c/${existing}`);
    await expect(page.getByTestId("header-title")).toHaveText(`Routing history ${suffix}`);
    await page.goto("/");
    await expect(page).toHaveURL(exactPath("/"));
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await expect(page).toHaveTitle("New chat · AIQSA");
    expect(await page.evaluate(() => Object.keys(window.localStorage).some((key) => /activechat/iu.test(key)))).toBe(false);

    await page.getByTestId("app-shell").evaluate((node) => node.setAttribute("data-routing-probe", "mounted"));
    await prepareFakeSend(page);
    const prompt = `Routing first send ${suffix}`;
    await composer.fill(prompt);
    const admitted = admission(page);
    await composer.press("Enter");
    const response = await admitted;
    sent = new URL(response.url()).pathname.split("/")[3]!;
    expect(response.ok()).toBe(true);
    await expect(page).toHaveURL(exactPath(`/c/${sent}`));
    await expect(page.locator('[data-testid="app-shell"][data-routing-probe="mounted"]')).toHaveCount(1);
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(`Fake answer: ${prompt}`, { timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Stop answer" })).toHaveCount(0, { timeout: 45_000 });
    await composer.fill("Unsent draft after the address changed");
    await expect(page.locator('[data-testid="app-shell"][data-routing-probe="mounted"]')).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("routing-first-send-light-1440.png") });

    await page.reload();
    await expect(page).toHaveURL(exactPath(`/c/${sent}`));
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(`Fake answer: ${prompt}`);
  } finally {
    await deleteChats(page, [existing, sent]);
  }
});

test("chats keep their address through reload, sidebar history and an independent second tab", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await useAppearance(page, context, baseURL!, "dark");
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const alphaTitle = `Routing alpha ${suffix}`;
  const betaTitle = `Routing beta ${suffix}`;
  const alpha = await createChat(page, alphaTitle);
  const beta = await createChat(page, betaTitle);
  const header = page.getByTestId("header-title");
  let second: Page | undefined;
  try {
    await page.goto(`/c/${alpha}`);
    await expect(header).toHaveText(alphaTitle);
    await expect(page).toHaveTitle(`${alphaTitle} · AIQSA`);
    await page.reload();
    await expect(header).toHaveText(alphaTitle);
    await expect(page).toHaveTitle(`${alphaTitle} · AIQSA`);

    await chooseChat(page, betaTitle);
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));
    await expect(header).toHaveText(betaTitle);
    await page.goBack();
    await expect(page).toHaveURL(exactPath(`/c/${alpha}`));
    await expect(header).toHaveText(alphaTitle);
    await page.goForward();
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));
    await expect(header).toHaveText(betaTitle);

    await page.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page).toHaveURL(exactPath("/"));
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));
    await expect(header).toHaveText(betaTitle);
    await page.screenshot({ path: testInfo.outputPath("routing-history-dark-1440.png") });

    second = await context.newPage();
    await second.goto(`/c/${alpha}`);
    await expect(second.getByTestId("header-title")).toHaveText(alphaTitle);
    await second.getByRole("complementary", { name: "Chat navigation" })
      .getByRole("button", { name: "New chat", exact: true }).click();
    await expect(second).toHaveURL(exactPath("/"));
    await page.reload();
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));
    await expect(header).toHaveText(betaTitle);
    await second.reload();
    await expect(second.getByTestId("conversation-empty")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    await second?.close();
    await deleteChats(page, [alpha, beta]);
  }
});

test("a guarded Studio draft keeps the address on the shown chat until it is discarded", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await useAppearance(page, context, baseURL!, "light");
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const alphaTitle = `Routing guarded alpha ${suffix}`;
  const betaTitle = `Routing guarded beta ${suffix}`;
  const alpha = await createChat(page, alphaTitle);
  const beta = await createChat(page, betaTitle);
  try {
    await page.goto(`/c/${alpha}`);
    await expect(page.getByTestId("header-title")).toHaveText(alphaTitle);
    await chooseChat(page, betaTitle);
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));

    await runAccountMenuAction(page, "Assistants");
    const library = page.getByTestId("library-v2");
    await library.getByRole("button", { name: "New assistant", exact: true }).first().click();
    const name = library.getByLabel("Name Required", { exact: true });
    await name.fill("Unsaved routing assistant");
    const confirmation = page.getByTestId("discard-changes-confirmation");

    await page.goBack();
    await expect(confirmation).toBeVisible();
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));
    await page.screenshot({ path: testInfo.outputPath("routing-guarded-back-light-1440.png") });
    await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(name).toHaveValue("Unsaved routing assistant");
    await expect(page).toHaveURL(exactPath(`/c/${beta}`));

    await page.goBack();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: /Confirm discard/u }).click();
    await expect(page).toHaveURL(exactPath(`/c/${alpha}`));
    await expect(library).toHaveCount(0);
    await expect(page.getByTestId("header-title")).toHaveText(alphaTitle);
  } finally {
    await deleteChats(page, [alpha, beta]);
  }
});

test("unknown, foreign and malformed chat addresses share one notice and land on the new chat", async ({ page, context, browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await useAppearance(page, context, baseURL!, "dark", phone);
  const other = await browser.newContext({ baseURL });
  const otherPage = await other.newPage();
  let foreign: string | null = null;
  try {
    await signInWithPassword(otherPage, LOCAL_RESTRICTED_MEMBER);
    foreign = await createChat(otherPage, `Foreign routing chat ${randomUUID().slice(0, 8)}`);
    await signInWithLocalToken(page);
    const notice = page.getByTestId("shell-notice");
    for (const target of [`/c/${randomUUID()}`, `/c/${foreign}?message=${randomUUID()}`, `/c/${"x".repeat(300)}`]) {
      await page.goto(target);
      await expect(notice).toContainText("That chat is unavailable.");
      await expect(page).toHaveURL(exactPath("/"));
      await expect(page.getByTestId("conversation-empty")).toBeVisible();
      await expect(page).toHaveTitle("New chat · AIQSA");
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("routing-unavailable-dark-390.png") });
  } finally {
    await deleteChats(otherPage, [foreign]);
    await other.close();
  }
});

test("Project addresses open the Project, and a readable Project chat's own address moves there", async ({ page, context, browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  await useAppearance(page, context, baseURL!, "light");
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const projectName = `Routing Project ${suffix}`;
  const chatTitle = `Routing Project chat ${suffix}`;
  const created = await page.request.post("/api/projects", {
    data: { name: projectName, preferredModelId: providerTemplateIds.fakeModel }
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).project.id as string;
  const other = await browser.newContext({ baseURL });
  try {
    const chatResponse = await page.request.post(`/api/projects/${projectId}/chats`, { data: { title: chatTitle } });
    expect(chatResponse.status()).toBe(201);
    const chatId = (await chatResponse.json()).chat.id as string;
    const projectPanel = page.getByRole("complementary", { name: "Shared project context" });
    const notice = page.getByTestId("shell-notice");

    await page.goto(`/p/${projectId}/c/${chatId}`);
    await expect(projectPanel).toContainText(projectName, { timeout: 20_000 });
    await expect(page.getByTestId("header-title")).toHaveText(chatTitle);
    await page.reload();
    await expect(projectPanel).toContainText(projectName, { timeout: 20_000 });
    await expect(page.getByTestId("header-title")).toHaveText(chatTitle);
    await expect(page).toHaveURL(exactPath(`/p/${projectId}/c/${chatId}`));
    await page.screenshot({ path: testInfo.outputPath("routing-project-chat-light-1440.png") });

    await page.goto(`/p/${projectId}`);
    await expect(projectPanel).toContainText(projectName, { timeout: 20_000 });
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
    await expect(page).toHaveURL(exactPath(`/p/${projectId}`));

    // Resolving takes the personal list, one chat detail read and the Project's own reads.
    await page.goto(`/c/${chatId}`);
    await expect(page).toHaveURL(exactPath(`/p/${projectId}/c/${chatId}`), { timeout: 45_000 });
    await expect(projectPanel).toContainText(projectName);
    await expect(page.getByTestId("header-title")).toHaveText(chatTitle);
    await expect(notice).toHaveCount(0);

    await page.goto(`/?project=${projectId}&chat=${chatId}`);
    await expect(page).toHaveURL(exactPath(`/p/${projectId}/c/${chatId}`), { timeout: 20_000 });
    await expect(page.getByTestId("header-title")).toHaveText(chatTitle);

    await page.goto(`/p/${projectId}/c/${randomUUID()}`);
    await expect(notice).toContainText("That Project chat is unavailable.", { timeout: 20_000 });
    await expect(page).toHaveURL(exactPath(`/p/${projectId}`));
    await expect(projectPanel).toContainText(projectName);

    const outsider = await other.newPage();
    await signInWithPassword(outsider, LOCAL_RESTRICTED_MEMBER);
    await outsider.goto(`/c/${chatId}`);
    await expect(outsider.getByTestId("shell-notice")).toContainText("That chat is unavailable.", { timeout: 20_000 });
    await expect(outsider).toHaveURL(exactPath("/"));
    await outsider.goto(`/p/${projectId}/c/${chatId}`);
    await expect(outsider.getByTestId("shell-notice")).toContainText("That Project chat is unavailable.", { timeout: 20_000 });
    await expect(outsider).toHaveURL(exactPath("/"));
    await expect(outsider.getByRole("complementary", { name: "Shared project context" })).toHaveCount(0);
  } finally {
    await other.close();
    await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
  }
});

test("sign-in and an expired session return to the chat address with its draft", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL, colorScheme: "light", reducedMotion: "reduce", viewport: phone });
  await context.addCookies([{ name: "aiqsa.theme", value: "light", url: baseURL! }]);
  const page = await context.newPage();
  const title = `Routing sign-in ${randomUUID().slice(0, 8)}`;
  let chatId: string | null = null;
  try {
    await signInWithPassword(page, LOCAL_MCP_MEMBER);
    chatId = await createChat(page, title);
    await page.goto(`/c/${chatId}`);
    await expect(page).toHaveTitle(`${title} · AIQSA`);
    await prepareFakeSend(page);

    // The session ends server-side while the chat is open.
    await page.request.post("/api/auth/logout", { data: {} });
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep this question through sign-in");
    await composer.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fc%2F${chatId}&reason=`, "u"), { timeout: 30_000 });
    await submitLogin(page, LOCAL_MCP_MEMBER);
    await expect(page).toHaveURL(exactPath(`/c/${chatId}`), { timeout: 30_000 });
    await expect(page).toHaveTitle(`${title} · AIQSA`);
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep this question through sign-in");
    await page.screenshot({ path: testInfo.outputPath("routing-session-return-light-390.png") });

    await context.clearCookies();
    await page.goto(`/c/${chatId}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fc%2F${chatId}$`, "u"));
    await submitLogin(page, LOCAL_MCP_MEMBER);
    await expect(page).toHaveURL(exactPath(`/c/${chatId}`), { timeout: 30_000 });
    await expect(page).toHaveTitle(`${title} · AIQSA`);

    // A stale cookie reaches the page itself, which returns to its own address.
    await context.clearCookies();
    await context.addCookies([{ name: SESSION_COOKIE_NAME, value: "stale-routing-session", url: baseURL! }]);
    await page.goto(`/c/${chatId}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fc%2F${chatId}$`, "u"));
    await submitLogin(page, LOCAL_MCP_MEMBER);
    await expect(page).toHaveURL(exactPath(`/c/${chatId}`), { timeout: 30_000 });
    await expectNoHorizontalOverflow(page);
  } finally {
    await deleteChats(page, [chatId]);
    await context.close();
  }
});

test("Control Center returns to the chat it was opened from", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  await useAppearance(page, context, baseURL!, "dark");
  await signInWithLocalToken(page);
  const title = `Routing Control Center ${randomUUID().slice(0, 8)}`;
  const chatId = await createChat(page, title);
  try {
    await page.goto(`/c/${chatId}`);
    await expect(page.getByTestId("header-title")).toHaveText(title);
    const controlCenter = page.getByTestId("workspace-rail").getByRole("link", { name: "Control Center" });
    await expect(controlCenter).toHaveAttribute("href", `/admin?return=%2Fc%2F${chatId}`);
    await controlCenter.click();
    await expect(page.getByTestId("admin-shell")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("admin-nav-users").click();
    await expect(page).toHaveURL(/section=users/u);
    expect(new URL(page.url()).searchParams.get("return")).toBe(`/c/${chatId}`);
    await page.screenshot({ path: testInfo.outputPath("routing-control-center-dark-1440.png") });
    await page.getByTestId("admin-rail").getByRole("link", { name: "Chats" }).click();
    await expect(page).toHaveURL(exactPath(`/c/${chatId}`), { timeout: 30_000 });
    await expect(page.getByTestId("header-title")).toHaveText(title);

    await page.goto("/admin");
    await page.getByTestId("admin-rail").getByRole("link", { name: "Chats" }).click();
    await expect(page).toHaveURL(exactPath("/"), { timeout: 30_000 });
    await expect(page.getByTestId("conversation-empty")).toBeVisible();
  } finally {
    await deleteChats(page, [chatId]);
  }
});

test("a failed first send leaves the new chat's address, and a retry takes the chat's own", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await useAppearance(page, context, baseURL!, "light", phone);
  await signInWithLocalToken(page);
  await prepareFakeSend(page);
  let reject = true;
  await page.route("**/api/chats/*/messages", async (route) => {
    if (route.request().method() !== "POST" || !reject) {
      await route.fallback();
      return;
    }
    await route.fulfill({ status: 503, json: { error: "synthetic_admission_unavailable" } });
  });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const prompt = `Routing retried first send ${randomUUID().slice(0, 8)}`;
  let chatId: string | null = null;
  try {
    await composer.fill(prompt);
    const rejected = admission(page);
    await composer.press("Enter");
    expect((await rejected).status()).toBe(503);
    // The draft chat was never persisted: its address and draft return.
    await expect(page.locator(".v2-live-composer-error")).toBeVisible({ timeout: 30_000 });
    await expect(composer).toHaveValue(prompt);
    await expect(page).toHaveURL(exactPath("/"));
    await page.screenshot({ path: testInfo.outputPath("routing-failed-first-send-light-390.png") });

    reject = false;
    const admitted = admission(page);
    await composer.press("Enter");
    const response = await admitted;
    expect(response.ok()).toBe(true);
    chatId = new URL(response.url()).pathname.split("/")[3]!;
    await expect(page).toHaveURL(exactPath(`/c/${chatId}`));
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(`Fake answer: ${prompt}`, { timeout: 45_000 });
    await expectNoHorizontalOverflow(page);
  } finally {
    await deleteChats(page, [chatId]);
  }
});

test("a real navigation from the artifact page and later address changes share one mounted shell", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await useAppearance(page, context, baseURL!, "dark");
  await signInWithLocalToken(page);
  const suffix = randomUUID().slice(0, 8);
  const otherTitle = `Routing artifact neighbour ${suffix}`;
  const source = await createChat(page, `Routing artifact source ${suffix}`);
  const neighbour = await createChat(page, otherTitle);
  const created = await page.request.post("/api/artifacts", { data: { sourceChatId: source, operation: {
    intent: "create", kind: "html", title: `Routing artifact ${suffix}`, entrypoint: "index.html",
    files: [{ path: "index.html", mimeType: "text/html", text: "<!doctype html><title>Routing</title><h1>Routing artifact</h1>" }]
  } } });
  expect(created.status()).toBe(201);
  const version = (await created.json()).version;
  let editChat: string | null = null;
  try {
    await page.goto(`/artifacts/${version.artifactId}/versions/${version.id}`);
    await page.getByRole("button", { name: "Edit with AI", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove artifact edit" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => new URL(page.url()).search, { timeout: 15_000 }).toBe("");
    editChat = parseChatRoutePath(new URL(page.url()).pathname)?.chatId ?? null;
    expect(editChat).toBeTruthy();

    await page.getByTestId("app-shell").evaluate((node) => node.setAttribute("data-routing-probe", "mounted"));
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Keep this artifact note");
    await chooseChat(page, otherTitle);
    await expect(page).toHaveURL(exactPath(`/c/${neighbour}`));
    await page.goBack();
    await expect(page).toHaveURL(exactPath(`/c/${editChat}`));
    await expect(composer).toHaveValue("Keep this artifact note");
    await expect(page.locator('[data-testid="app-shell"][data-routing-probe="mounted"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("routing-artifact-edit-dark-1440.png") });
  } finally {
    await page.request.delete(`/api/artifacts/${version.artifactId}`).catch(() => undefined);
    await deleteChats(page, [source, neighbour, editChat === source ? null : editChat]);
  }
});

test.describe("MCP authorization", () => {
  const prisma = new PrismaClient();
  test.afterAll(() => prisma.$disconnect());
  test.beforeEach(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/stateful-test-target.ts"], { stdio: "pipe" }));

  test("returns connect, cancel and tampered starts to the validated chat address", async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    await useAppearance(page, context, baseURL!, "light");
    const endpoint = await startOAuthMcpEndpoint();
    const ownerId = randomUUID();
    const email = `routing-mcp-${ownerId}@example.test`;
    const password = `Synthetic-${randomUUID()}`;
    let serverId: string | undefined;
    let chatId: string | null = null;
    try {
      await prisma.user.create({ data: { id: ownerId, email, displayName: "Synthetic routing owner", role: "admin", status: "active",
        authIdentities: { create: { normalizedEmail: email, provider: "password", providerAccountId: email,
          passwordHash: await hashPassword(password), emailVerifiedAt: new Date() } } } });
      await prisma.$transaction((tx) => provisionActiveUser(tx, { userId: ownerId, groups: [] }));
      await prisma.accessGrant.create({ data: { userId: ownerId, providerModelId: providerTemplateIds.fakeModel } });
      await signInWithPassword(page, { email, password });
      const serverResponse = await page.request.post("/api/admin/mcp", { data: {
        name: "Synthetic routing tools", description: "Local OAuth integration for chat address returns", activate: false,
        sharedValues: { fixture_key: "synthetic-shared-value" }, draft: {
          auth: { mode: "oauth", scopes: ["mcp.read"], allowedAuthorizationServerOrigins: [endpoint.origin] },
          source: { kind: "remote", url: `${endpoint.origin}/mcp`, allowPrivateNetwork: true }, transport: "streamable_http",
          runtime: { startupTimeoutMs: 10_000, callTimeoutMs: 10_000 },
          slots: [{ slotKey: "fixture_key", label: "Personal fixture key", sensitive: true, valueType: "secret",
            target: { kind: "header", name: "X-Fixture-Key" }, policy: { kind: "shared", allowPersonalOverride: true } }]
        }
      } });
      expect(serverResponse.status()).toBe(201);
      serverId = (await serverResponse.json()).server.id as string;
      await page.goto(`/api/admin/mcp/${serverId}/oauth/validation/connect`);
      await page.getByRole("link", { name: "Approve test connection" }).click();
      await expect(page).toHaveURL(/\/admin\?/u);
      await expect.poll(async () => Boolean((await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).activeRevisionId),
        { timeout: 30_000 }).toBe(true);
      const grant = await page.request.put(`/api/admin/mcp/${serverId}/grants`, { data: { userId: ownerId, canUse: true, personalSlotKeys: ["fixture_key"] } });
      expect(grant.ok()).toBe(true);

      const title = `Routing MCP chat ${randomUUID().slice(0, 8)}`;
      chatId = await createChat(page, title);
      await page.goto(`/c/${chatId}`);
      await expect(page.getByTestId("header-title")).toHaveText(title);
      await runAccountMenuAction(page, "MCP servers");
      const library = page.getByTestId("library-v2");
      await library.getByRole("searchbox").fill("Synthetic routing");
      const row = library.getByRole("article", { name: "Synthetic routing tools", exact: true });
      const sheet = page.getByRole("dialog", { name: "Synthetic routing tools", exact: true });
      const outcome = library.locator(".v2-settings-banner");

      const connect = sheet.getByRole("link", { name: "Connect", exact: true });
      // The provider declines: its access_denied redirect carries the flow's own state.
      await row.getByRole("button", { name: "Open Synthetic routing tools" }).click();
      await expect(connect).toHaveAttribute("href", new RegExp(`return=%2Fc%2F${chatId}$`, "u"));
      await connect.click();
      await expect(page.getByRole("link", { name: "Approve test connection" })).toBeVisible({ timeout: 30_000 });
      const state = new URL(page.url()).searchParams.get("state");
      expect(state).toBeTruthy();
      await page.goto(`/api/me/mcp/${serverId}/oauth/callback?state=${encodeURIComponent(state!)}&error=access_denied`);
      await expect(page).toHaveURL(exactPath(`/c/${chatId}`), { timeout: 30_000 });
      await expect(outcome).toContainText("Authorization was cancelled.");

      await library.getByRole("searchbox").fill("Synthetic routing");
      await row.getByRole("button", { name: "Open Synthetic routing tools" }).click();
      await connect.click();
      await page.getByRole("link", { name: "Approve test connection" }).click();
      await expect(page).toHaveURL(exactPath(`/c/${chatId}`), { timeout: 30_000 });
      await expect(outcome).toContainText("External account connected and MCP enabled.");
      await expect(library.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("routing-mcp-connected-light-1440.png") });

      // A tampered return value falls back to the new chat.
      await page.goto(`/api/me/mcp/${serverId}/oauth/connect?return=${encodeURIComponent("https://evil.example/c/foreign")}`);
      await expect(page).toHaveURL(exactPath("/"), { timeout: 30_000 });
      await expect(outcome).toContainText("External account connected and MCP enabled.");
      expect(endpoint.counts.errors).toBe(0);
    } finally {
      await page.goto("about:blank");
      await deleteChats(page, [chatId]);
      if (serverId) {
        const clients = await prisma.mcpOAuthConnection.findMany({ where: { serverId }, select: { oauthClientId: true } });
        await page.request.delete(`/api/admin/mcp/${serverId}`).catch(() => undefined);
        await prisma.mcpRevision.deleteMany({ where: { serverId } });
        await prisma.mcpServer.deleteMany({ where: { id: serverId } });
        await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: clients.flatMap((client) => client.oauthClientId ? [client.oauthClientId] : []) } } });
      }
      await prisma.user.deleteMany({ where: { id: ownerId } });
      await endpoint.close();
    }
  });
});
