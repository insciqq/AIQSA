import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  PROXY_ADDRESS_FAILURE_CODES,
  PROXY_CONNECTION_FAILURE_CODES,
  PROXY_LIMITS,
  type ProxyCheckStatus,
  type ProxySharedWire,
  type ProxyWire
} from "../../lib/contracts/proxies";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { authenticateWithLocalToken } from "./support/localAuth";

/*
 * Needs only a signed-in administrator and a member on a fake-provider stand,
 * and no real proxy. A saved proxy has a public address that answers no proxy,
 * so a check fails for real; a passing check is mocked. The matrix mocks the
 * lists, which puts every failure wording on screen without any stored state.
 */

test.describe.configure({ mode: "serial" });

const VIEWPORTS = [
  { height: 900, name: "desktop", touch: false, width: 1440 },
  { height: 1112, name: "tablet-portrait", touch: true, width: 834 },
  { height: 834, name: "tablet-landscape", touch: true, width: 1112 },
  { height: 844, name: "phone-portrait", touch: true, width: 390 },
  { height: 390, name: "phone-landscape", touch: true, width: 844 }
] as const;
const THEMES = ["light", "dark"] as const;
const LISTS = ["administrator", "personal"] as const;
type ListName = (typeof LISTS)[number];
type ListMode = "empty" | "error" | "list" | "loading";

/** Public, answers no proxy. Documentation ranges are refused by the address rule, so they would not reach a check. */
const SILENT_HOST = "1.1.1.1";
const SILENT_PORT = 9;
const REAL_CHECK_FAILURE = /Could not connect to the proxy|did not answer in time|did not answer the way|could not be checked right now/u;

type Sessions = Readonly<Record<ListName, Awaited<ReturnType<BrowserContext["storageState"]>>>>;
let sessions: Sessions;

const API = {
  administrator: "/api/admin/proxies",
  personal: "/api/me/proxies"
} as const;

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const administrator = await browser.newContext({ baseURL: baseURL! });
  await authenticateWithLocalToken(administrator.request);
  const member = await browser.newContext({ baseURL: baseURL! });
  const page = await member.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  // Only the session is needed here: the first page after sign-in can take a dev server longer than any navigation wait.
  const signedIn = page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.ok(), { timeout: 120_000 });
  await page.getByRole("button", { name: "Sign in" }).click();
  await signedIn;
  sessions = { administrator: await administrator.storageState(), personal: await member.storageState() };
  await administrator.close();
  await member.close();
});

async function contextFor(browser: Browser, baseURL: string, list: ListName, theme: (typeof THEMES)[number], viewport: (typeof VIEWPORTS)[number]) {
  const context = await browser.newContext({ baseURL, colorScheme: theme, hasTouch: viewport.touch, storageState: sessions[list],
    viewport: { height: viewport.height, width: viewport.width } });
  await context.addCookies([{ name: "aiqsa.theme", url: baseURL, value: theme }]);
  return context;
}

async function openPersonal(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await runAccountMenuAction(page, "Settings");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Proxies", exact: true }).click();
  return page.getByTestId("proxy-list-personal");
}

async function openAdministrator(page: Page): Promise<Locator> {
  await page.goto("/admin?section=proxies");
  return page.getByTestId("proxy-list-administrator");
}

const openList = (page: Page, list: ListName) => list === "administrator" ? openAdministrator(page) : openPersonal(page);

/** Removes what a test created, by name, whatever state it stopped in. */
async function removeByName(context: BrowserContext, list: ListName, name: string) {
  const response = await context.request.get(API[list]);
  if (!response.ok()) return;
  const { proxies } = await response.json() as { proxies: ProxyWire[] };
  for (const proxy of proxies.filter((row) => row.name === name)) {
    await context.request.delete(`${API[list]}/${proxy.id}`, { data: { expectedVersion: proxy.version } });
  }
}

function fakeRows(list: ListName): ProxyWire[] {
  const statuses: (ProxyCheckStatus | null)[] = ["ok", ...PROXY_ADDRESS_FAILURE_CODES, ...PROXY_CONNECTION_FAILURE_CODES, null];
  const longHints = Array.from({ length: PROXY_LIMITS.hintsPerProxy }, (_, index) => `shop-with-a-rather-long-name-${index}.example.com`);
  return statuses.map((status, index) => ({
    active: index % 4 !== 3,
    country: index % 3 === 0 ? "KZ" : null,
    domainHints: index === 1 ? longHints : index % 2 ? [".kz", "ozon.ru"] : [],
    hasPassword: index % 2 === 0,
    host: index === 2 ? `${"very-long-label-".repeat(6)}example.com` : `proxy-${index}.example.com`,
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    lastCheck: status === null ? null : { checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: status === "ok" ? "203.0.113.7" : null, status },
    login: index % 2 === 0 ? "synthetic-login" : null,
    name: index === 0 ? "L".repeat(PROXY_LIMITS.nameMaxLength) : index === 1 ? "A proxy with a long name that wraps at the edge of its row" : `Proxy ${index}`,
    owner: list,
    port: 8080 + index,
    protocol: (["http", "https", "socks5"] as const)[index % 3]!,
    version: 1
  }));
}

function fakeShared(): ProxySharedWire[] {
  return Array.from({ length: 4 }, (_, index) => ({
    active: index !== 1,
    country: index === 0 ? "DE" : null,
    domainHints: index === 2 ? Array.from({ length: 20 }, (_, hint) => `partner-with-a-long-name-${hint}.example.org`) : [".de"],
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: index === 3 ? "S".repeat(PROXY_LIMITS.nameMaxLength) : `Office ${index}`,
    owner: "administrator" as const,
    protocol: "socks5" as const
  }));
}

async function mockLists(page: Page, list: ListName, mode: { current: ListMode }) {
  await page.route(`**${API[list]}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (mode.current === "loading") return new Promise<void>(() => undefined);
    if (mode.current === "error") return route.fulfill({ json: { error: "proxy_unavailable" }, status: 503 });
    const rows = mode.current === "empty" ? [] : fakeRows(list);
    return route.fulfill({ json: list === "administrator" ? { proxies: rows } : { proxies: rows, shared: mode.current === "empty" ? [] : fakeShared() } });
  });
  await page.route(`**${API[list]}/*`, (route) => route.request().method() === "PATCH"
    ? route.fulfill({ json: { error: "proxy_name_taken" }, status: 409 })
    : route.fallback());
}

async function expectContained(page: Page, panel: Locator) {
  await expectNoHorizontalOverflow(page);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

for (const list of LISTS) {
  for (const theme of THEMES) {
    test(`the ${list} list holds every state at every viewport (${theme})`, async ({ browser, baseURL }, testInfo) => {
      test.setTimeout(420_000);
      for (const viewport of VIEWPORTS) {
        const context = await contextFor(browser, baseURL!, list, theme, viewport);
        const page = await context.newPage();
        const shot = (state: string) => page.screenshot({ path: testInfo.outputPath(`${list}-${theme}-${viewport.name}-${state}.png`) });
        const mode: { current: ListMode } = { current: "loading" };
        await mockLists(page, list, mode);
        try {
          let panel = await openList(page, list);
          await expect(panel.getByText("Loading proxies…")).toBeVisible();
          await expectContained(page, panel);
          await shot("loading");

          mode.current = "error";
          panel = await openList(page, list);
          await expect(panel.getByRole("alert")).toContainText("could not be loaded");
          await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
          await expectContained(page, panel);
          await shot("error");

          mode.current = "empty";
          panel = await openList(page, list);
          await expect(panel.getByText(list === "administrator" ? "No proxies for everyone yet." : /No proxies yet/u)).toBeVisible();
          await expectContained(page, panel);
          await shot("empty");

          mode.current = "list";
          panel = await openList(page, list);
          const rows = panel.getByRole("list", { name: list === "administrator" ? "Proxies for everyone" : "Your proxies" }).getByRole("listitem");
          await expect(rows).toHaveCount(fakeRows(list).length);
          await expect(panel.getByText("Sites see 203.0.113.7.")).toBeVisible();
          await expectContained(page, panel);
          await shot("list");
          await rows.nth(8).scrollIntoViewIfNeeded();
          await expectContained(page, panel);
          await shot("list-failures");
          if (list === "personal") {
            const shared = panel.getByRole("list", { name: "Proxies from your administrators" });
            await shared.scrollIntoViewIfNeeded();
            await expect(shared.getByRole("heading", { name: "Office 0" })).toBeVisible();
            await expect(shared.getByRole("button")).toHaveCount(0);
            await shot("list-shared");
          }

          const editFirst = panel.getByRole("button", { name: /^Edit /u }).first();
          await editFirst.scrollIntoViewIfNeeded();
          await editFirst.click();
          const form = panel.getByRole("form");
          await expect(form.getByLabel("Name")).toBeFocused();
          await expect(form.getByText("A password is stored. Leave the field empty to keep it.")).toBeVisible();
          await expect(form.getByText(/Changing the address keeps the stored password/u)).toBeVisible();
          await expectContained(page, panel);
          await shot("form");

          await form.getByLabel("Name").fill("Taken name");
          const save = form.getByRole("button", { name: "Save proxy" });
          await save.scrollIntoViewIfNeeded();
          await save.click();
          await expect(form.getByRole("alert")).toContainText("Another proxy already has this name");
          await expect(form.getByRole("alert")).toBeFocused();
          await expect(form.getByRole("alert")).toBeInViewport();
          await expectContained(page, panel);
          await shot("form-error");
        } finally {
          await page.unrouteAll({ behavior: "ignoreErrors" });
          await context.close();
        }
      }
    });
  }
}

test("an administrator adds, checks, edits and deletes a proxy", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const context = await contextFor(browser, baseURL!, "administrator", "light", VIEWPORTS[0]);
  const page = await context.newPage();
  const name = `E2E proxy ${randomUUID().slice(0, 8)}`;
  const password = `synthetic-${randomUUID()}`;
  try {
    const panel = await openAdministrator(page);
    const add = panel.getByRole("button", { name: "Add proxy" });
    await expect(add).toBeEnabled();

    await add.click();
    const form = panel.getByRole("form");
    await expect(form.getByLabel("Name")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(add).toBeFocused();

    await add.click();
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Host").fill(SILENT_HOST);
    await form.getByLabel("Port").fill(String(SILENT_PORT));
    await form.getByLabel("Login (optional)").fill("synthetic-login");
    await form.getByLabel("Password (optional)").fill(password);
    await form.getByLabel("Domain hints (optional)").fill(".kz\nozon.ru");
    await form.getByRole("button", { name: "Save proxy" }).click();
    const heading = panel.getByRole("heading", { name, exact: true });
    await expect(heading).toBeFocused();
    const row = panel.getByRole("listitem").filter({ has: heading });
    await expect(row).toContainText("Password stored");
    await expect(row).toContainText("Hints: .kz, ozon.ru");
    expect(await page.content()).not.toContain(password);
    expect(await (await context.request.get(API.administrator)).text()).not.toContain(password);

    await add.click();
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Host").fill(SILENT_HOST);
    await form.getByLabel("Port").fill(String(SILENT_PORT));
    await form.getByRole("button", { name: "Save proxy" }).click();
    await expect(form.getByRole("alert")).toContainText("Another proxy already has this name");
    await form.getByRole("button", { name: "Cancel" }).click();
    await form.getByRole("button", { name: "Discard changes" }).click();
    await expect(form).toHaveCount(0);

    await row.getByRole("button", { name: `Check ${name}` }).click();
    await expect(row.getByText(REAL_CHECK_FAILURE)).toBeVisible({ timeout: 45_000 });
    await expect(row.getByRole("button", { name: `Check ${name}` })).toBeEnabled();

    await page.route(`**${API.administrator}/*/check`, async (route) => {
      const { proxies } = await (await context.request.get(API.administrator)).json() as { proxies: ProxyWire[] };
      const current = proxies.find((proxy) => proxy.name === name)!;
      const check = { checkedAt: "2026-11-01T10:00:00.000Z", exitAddress: "203.0.113.7", status: "ok" };
      await route.fulfill({ json: { check, proxy: { ...current, lastCheck: check } } });
    });
    await row.getByRole("button", { name: `Check ${name}` }).click();
    await expect(row.getByText("Sites see 203.0.113.7.")).toBeVisible();
    await page.unroute(`**${API.administrator}/*/check`);

    await row.getByRole("button", { name: `Edit ${name}` }).click();
    await expect(form.getByLabel("New password")).toHaveValue("");
    await expect(form.getByText(/Changing the address keeps the stored password/u)).toBeVisible();
    await form.getByLabel("Host").fill("1.0.0.1");
    const [patch] = await Promise.all([
      page.waitForRequest((request) => request.method() === "PATCH"),
      form.getByRole("button", { name: "Save proxy" }).click()
    ]);
    expect(patch.postDataJSON()).toEqual({ expectedVersion: expect.any(Number), host: "1.0.0.1" });
    await expect(heading).toBeFocused();
    await expect(row).toContainText("1.0.0.1");
    await expect(row).toContainText("Password stored");

    const { proxies } = await (await context.request.get(API.administrator)).json() as { proxies: ProxyWire[] };
    const current = proxies.find((proxy) => proxy.name === name)!;
    const renamed = `${name} moved`;
    const elsewhere = await context.request.patch(`${API.administrator}/${current.id}`, { data: { expectedVersion: current.version, name: renamed } });
    expect(elsewhere.ok()).toBe(true);
    await row.getByRole("switch", { name: `Use ${name}` }).click();
    const movedRow = panel.getByRole("listitem").filter({ has: panel.getByRole("heading", { name: renamed, exact: true }) });
    await expect(movedRow.getByRole("alert")).toContainText("changed somewhere else");
    await expect(movedRow.getByRole("switch", { name: `Use ${renamed}` })).toHaveAttribute("aria-checked", "true");

    await movedRow.getByRole("switch", { name: `Use ${renamed}` }).click();
    await expect(movedRow.getByRole("switch", { name: `Use ${renamed}` })).toHaveAttribute("aria-checked", "false");
    await expect(movedRow.getByRole("switch", { name: `Use ${renamed}` })).toBeFocused();

    await movedRow.getByRole("button", { name: `Delete ${renamed}` }).click();
    const confirmation = movedRow.getByRole("group", { name: `Delete ${renamed}` });
    await expect(confirmation).toContainText("Everyone's chats lose it at once.");
    await expect(confirmation.getByRole("button", { name: "Keep proxy" })).toBeFocused();
    await confirmation.getByRole("button", { name: "Delete proxy" }).click();
    await expect(panel.getByText("Proxy deleted.")).toBeVisible();
    await expect(add).toBeFocused();
    expect(await (await context.request.get(API.administrator)).text()).not.toContain(renamed);
  } finally {
    await removeByName(context, "administrator", name);
    await removeByName(context, "administrator", `${name} moved`);
    await context.close();
  }
});

test("a member sees an administrator proxy by name only, and manages their own", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const administrator = await contextFor(browser, baseURL!, "administrator", "dark", VIEWPORTS[0]);
  const member = await contextFor(browser, baseURL!, "personal", "dark", VIEWPORTS[3]);
  const page = await member.newPage();
  const sharedName = `E2E shared ${randomUUID().slice(0, 8)}`;
  const ownName = `E2E own ${randomUUID().slice(0, 8)}`;
  const login = `synthetic-${randomUUID().slice(0, 8)}`;
  try {
    const created = await administrator.request.post(API.administrator, { data: { domainHints: [".kz"], host: SILENT_HOST, login,
      name: sharedName, password: `synthetic-${randomUUID()}`, port: SILENT_PORT, protocol: "http" } });
    expect(created.status()).toBe(201);

    const wire = await (await member.request.get(API.personal)).text();
    expect(wire).toContain(sharedName);
    expect(wire).not.toContain(SILENT_HOST);
    expect(wire).not.toContain(login);
    expect((await member.request.get(API.administrator)).status()).toBe(403);

    const panel = await openPersonal(page);
    const shared = panel.getByRole("list", { name: "Proxies from your administrators" });
    const sharedRow = shared.getByRole("listitem").filter({ hasText: sharedName });
    await expect(sharedRow).toContainText("Hints: .kz");
    await expect(sharedRow.getByRole("button")).toHaveCount(0);
    await expect(sharedRow.getByRole("switch")).toHaveCount(0);
    await expect(panel).not.toContainText(SILENT_HOST);
    await expect(panel).not.toContainText(login);

    const settings = page.getByRole("dialog", { name: "Settings" });
    await panel.getByRole("button", { name: "Add proxy" }).click();
    const form = panel.getByRole("form");
    await form.getByLabel("Name").fill(ownName);
    await form.getByLabel("Host").fill("10.0.0.1");
    await form.getByLabel("Port").fill(String(SILENT_PORT));
    await form.getByRole("button", { name: "Save proxy" }).click();
    await expect(form.getByRole("alert")).toContainText("private or internal");

    await form.getByLabel("Host").press("Escape");
    await expect(form.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await expect(settings).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(form.getByLabel("Name")).toBeFocused();

    await form.getByLabel("Host").fill(SILENT_HOST);
    await form.getByRole("button", { name: "Save proxy" }).click();
    const ownHeading = panel.getByRole("heading", { name: ownName, exact: true });
    await expect(ownHeading).toBeFocused();
    await expect(panel.getByRole("button", { name: `Edit ${ownName}` })).toBeEnabled();

    await page.getByRole("button", { name: `Delete ${ownName}` }).click();
    await page.getByRole("button", { name: "Delete proxy" }).click();
    await expect(ownHeading).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  } finally {
    await removeByName(administrator, "administrator", sharedName);
    await removeByName(member, "personal", ownName);
    await administrator.close();
    await member.close();
  }
});
