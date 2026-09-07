import { expect, test, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type {
  AdminEmailConfiguration,
  AdminEmailDraftInput,
  AdminEmailState
} from "../../lib/contracts/email";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000001";
const vocabulary = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b/iu;

function emptyEmailState(): AdminEmailState {
  return {
    active: {
      activatedAt: null,
      activatedByUserId: null,
      configuration: null,
      enabled: false,
      passwordConfigured: false,
      version: 0
    },
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    draft: { configuration: null, passwordConfigured: false, test: null, version: 0 },
    health: {
      activeVersion: null,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    }
  };
}

function workingEmailState(configuration: AdminEmailConfiguration): AdminEmailState {
  return {
    ...emptyEmailState(),
    active: {
      activatedAt: "2026-07-23T16:02:00.000Z",
      activatedByUserId: ADMIN_USER_ID,
      configuration,
      enabled: true,
      passwordConfigured: true,
      version: 3
    },
    draft: { configuration, passwordConfigured: true, test: null, version: 5 },
    health: {
      activeVersion: 3,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    }
  };
}

function emptyAdminDashboard(): AdminDashboard {
  return {
    accessRules: [],
    catalog: { models: [], providers: [], searchStrategies: [] },
    groups: [],
    invites: [],
    navigation: {
      advancedConfigured: false,
      attention: {
        activeUsersWithoutModelAccess: 0,
        openInvites: 0,
        pendingUsers: 0
      },
      teamConfigured: false
    },
    usage: {
      byGroup: [],
      byUser: [],
      totals: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        lastUsedAt: null,
        outputTokens: 0,
        reasoningTokens: 0,
        runCount: 0,
        totalTokens: 0
      }
    },
    users: []
  };
}

async function mockDashboard(page: Page): Promise<void> {
  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
}

async function openEmail(page: Page) {
  await signInWithLocalToken(page);
  await page.goto("/admin?section=email");
  const section = page.getByTestId("admin-email-section");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Email");
  await expect(section.getByRole("form", { name: "Email settings" })).toBeVisible();
  return section;
}

async function signInOrdinaryUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

test("admin sets up email with one Test & Save and manages delivery from the topbar menu", async ({ page }) => {
  let email = emptyEmailState();
  const posts: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];

  await mockDashboard(page);
  await page.route("**/api/admin/email", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { email } });
      return;
    }

    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "POST" && body.action === "test_and_activate") {
      posts.push(body);
      const draft = body.draft as AdminEmailDraftInput;
      const nextDraftVersion = email.draft.version + 1;
      const nextActiveVersion = email.active.version + 1;
      const passwordConfigured = draft.passwordAction.kind !== "clear";
      email = {
        ...email,
        active: {
          activatedAt: "2026-07-23T16:02:00.000Z",
          activatedByUserId: ADMIN_USER_ID,
          configuration: draft.configuration,
          enabled: true,
          passwordConfigured,
          version: nextActiveVersion
        },
        configurationUpdatedAt: "2026-07-23T16:02:00.000Z",
        configurationUpdatedByUserId: ADMIN_USER_ID,
        draft: {
          configuration: draft.configuration,
          passwordConfigured,
          test: { attemptedAt: "2026-07-23T16:01:00.000Z", code: "accepted", tested: true, version: nextDraftVersion },
          version: nextDraftVersion
        },
        health: { ...emptyEmailState().health, activeVersion: nextActiveVersion }
      };
      await route.fulfill({
        contentType: "application/json",
        json: { email, test: { code: "accepted", tested: true } }
      });
      return;
    }

    if (request.method() === "POST" && (body.action === "disable" || body.action === "enable")) {
      posts.push(body);
      email = {
        ...email,
        active: { ...email.active, enabled: body.action === "enable", version: email.active.version + 1 }
      };
      await route.fulfill({ contentType: "application/json", json: { email } });
      return;
    }

    if (request.method() === "DELETE") {
      deletes.push(body);
      email = {
        ...emptyEmailState(),
        active: { ...emptyEmailState().active, version: email.active.version + 1 },
        draft: { ...emptyEmailState().draft, version: email.draft.version + 1 }
      };
      await route.fulfill({ contentType: "application/json", json: { email } });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_admin_email_e2e_request" },
      status: 400
    });
  });

  const section = await openEmail(page);
  const form = section.getByRole("form", { name: "Email settings" });
  await expect(section.getByTestId("email-delivery-status")).toHaveText("Not configured");
  await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await expect(section.getByRole("tab")).toHaveCount(0);
  await expect(form.getByLabel("Send a test to")).not.toHaveValue("");
  await expect(form).toContainText("A test message goes to that address first.");
  await expect(section).not.toContainText(vocabulary);
  await expectNoHorizontalOverflow(page);

  const secret = "playwright-write-only-smtp-password";
  await form.getByLabel("Host").fill("smtp.example.test");
  await form.getByLabel("From address").fill("noreply@example.test");
  await form.getByLabel("Username").fill("mailer@example.test");
  await form.getByLabel("Password").fill(secret);
  await form.getByLabel("Send a test to").fill("operator@example.test");
  await form.getByRole("button", { name: "Test & Save" }).click();

  await expect(page.getByTestId("admin-feedback"))
    .toContainText("Test message sent to operator@example.test. Email delivery is active.");
  expect(posts).toEqual([{
    action: "test_and_activate",
    draft: {
      configuration: {
        allowInternalNetwork: false,
        authentication: { mode: "password", username: "mailer@example.test" },
        from: { address: "noreply@example.test", displayName: "AIQSA" },
        host: "smtp.example.test",
        port: 587,
        transport: "starttls_required"
      },
      expectedDraftVersion: 0,
      passwordAction: { kind: "replace", password: secret }
    },
    expectedActiveVersion: 0,
    testRecipient: "operator@example.test"
  }]);
  await expect(section.getByTestId("email-delivery-status")).toHaveText("Working");
  await expect(section.getByTestId("email-delivery-summary"))
    .toHaveText("Delivering from noreply@example.test via smtp.example.test:587 (STARTTLS).");
  await expect(form.getByLabel("Password")).toHaveValue("");
  await expect(form).toContainText("Leave blank to keep the stored password.");
  await expect(section).not.toContainText(secret);
  await expect(section).not.toContainText(vocabulary);
  expect(JSON.stringify(email)).not.toContain(secret);
  expect(JSON.stringify(email)).not.toContain("operator@example.test");

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Disable" }).click();
  await expect(page.getByTestId("admin-feedback")).toContainText("Email delivery turned off.");
  await expect(section.getByTestId("email-delivery-status")).toHaveText("Disabled");
  expect(posts[1]).toEqual({ action: "disable", expectedActiveVersion: 1 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  for (const viewport of [
    { height: 768, width: 1024 },
    { height: 500, width: 1280 },
    { height: 900, width: 1440 },
    { height: 1024, width: 768 },
    { height: 844, width: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(form.getByRole("button", { name: "Test & Save" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ height: 900, width: 1440 });

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Clear configuration" }).click();
  const confirmation = page.getByTestId("admin-confirm-clear-email");
  await expect(confirmation.getByRole("heading", { name: "Clear email configuration?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  expect(deletes).toHaveLength(0);

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Clear configuration" }).click();
  await confirmation.getByRole("button", { name: /confirm clear configuration/i }).click();
  await expect(page.getByTestId("admin-feedback")).toContainText("Email configuration cleared.");
  expect(deletes).toEqual([{ confirm: true, expectedActiveVersion: 2, expectedDraftVersion: 1 }]);
  await expect(section.getByTestId("email-delivery-status")).toHaveText("Not configured");
  await expect(form.getByLabel("Host")).toHaveValue("");
  await expect(page.getByRole("button", { name: "More actions" })).toHaveCount(0);
});

test("a rejected test message keeps the current delivery and shows the cause in the form", async ({ page }) => {
  const configuration: AdminEmailConfiguration = {
    allowInternalNetwork: false,
    authentication: { mode: "password", username: "mailer@example.test" },
    from: { address: "noreply@example.test", displayName: "AIQSA" },
    host: "smtp.example.test",
    port: 587,
    transport: "starttls_required"
  };
  let email = workingEmailState(configuration);
  const posts: Array<Record<string, unknown>> = [];

  await mockDashboard(page);
  await page.route("**/api/admin/email", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { email } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "POST" && body.action === "test_and_activate") {
      posts.push(body);
      const draft = body.draft as AdminEmailDraftInput;
      email = {
        ...email,
        draft: {
          configuration: draft.configuration,
          passwordConfigured: true,
          test: {
            attemptedAt: "2026-07-23T16:05:00.000Z",
            code: "smtp_authentication_failed",
            tested: false,
            version: email.draft.version + 1
          },
          version: email.draft.version + 1
        }
      };
      await route.fulfill({
        contentType: "application/json",
        json: { email, error: "email_test_failed", test: { code: "smtp_authentication_failed", tested: false } },
        status: 422
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_admin_email_e2e_request" },
      status: 400
    });
  });

  const section = await openEmail(page);
  const form = section.getByRole("form", { name: "Email settings" });
  await expect(section.getByTestId("email-delivery-status")).toHaveText("Working");
  await form.getByLabel("Host").fill("smtp-next.example.test");
  await form.getByLabel("Password").fill("playwright-new-password");
  await form.getByLabel("Send a test to").fill("operator@example.test");
  await form.getByRole("button", { name: "Test & Save" }).click();

  await expect(form.getByRole("alert")).toHaveText("The mail server rejected the username or password.");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    draft: { configuration: { host: "smtp-next.example.test" }, expectedDraftVersion: 5 },
    expectedActiveVersion: 3
  });
  await expect(section.getByTestId("email-delivery-status")).toHaveText("Working");
  await expect(section.getByTestId("email-delivery-summary")).toContainText("via smtp.example.test:587");
  await expect(section.getByTestId("email-delivery-detail"))
    .toContainText("Last test failed: The mail server rejected the username or password.");
  await expect(form.getByLabel("Host")).toHaveValue("smtp-next.example.test");
  await expect(page.getByTestId("admin-feedback")).toHaveCount(0);
  await expect(section).not.toContainText("playwright-new-password");
  await expect(section).not.toContainText(vocabulary);
  expect(email.active.configuration?.host).toBe("smtp.example.test");
});

test("guards a dirty Control Center form across section navigation and native reload", async ({ page }) => {
  const email = emptyEmailState();
  await mockDashboard(page);
  await page.route("**/api/admin/email", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({
        contentType: "application/json",
        json: { error: "unexpected_dirty_navigation_email_request" },
        status: 400
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { email } });
  });

  const section = await openEmail(page);
  const host = section.getByLabel("Host");
  const dirtyHost = "dirty-navigation.smtp.example.test";
  await host.fill(dirtyHost);
  const originalUrl = page.url();

  const usageLink = page.getByRole("link", { exact: true, name: "Usage" });
  await usageLink.click();
  const discard = page.getByTestId("admin-discard-unsaved-confirmation");
  await expect(discard.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
  await expect(page).toHaveURL(originalUrl);
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(host).toHaveValue(dirtyHost);
  await expect(section).toBeVisible();

  const nativeDialogPromise = page.waitForEvent("dialog");
  const reloadPromise = page.reload({ timeout: 1_000, waitUntil: "domcontentloaded" }).catch(() => null);
  const nativeDialog = await nativeDialogPromise;
  expect(nativeDialog.type()).toBe("beforeunload");
  await nativeDialog.dismiss();
  await reloadPromise;
  await expect(page).toHaveURL(originalUrl);
  await expect(host).toHaveValue(dirtyHost);

  await usageLink.click();
  await expect(discard.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
  await discard.getByRole("button", { name: /confirm discard changes/i }).click();
  await expect(page.getByTestId("admin-section-usage")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\?section=usage$/);
});

test("ordinary user receives real active-admin denial for email configuration", async ({ page }) => {
  await signInOrdinaryUser(page);

  const read = await page.request.get("/api/admin/email");
  expect(read.status()).toBe(403);
  await expect(read.json()).resolves.toEqual({ error: "forbidden" });

  const mutation = await page.request.post("/api/admin/email", {
    data: {
      action: "test_and_activate",
      draft: {
        configuration: {
          allowInternalNetwork: false,
          authentication: { mode: "none" },
          from: { address: "noreply@example.test", displayName: null },
          host: "smtp.example.test",
          port: 465,
          transport: "implicit_tls"
        } satisfies AdminEmailConfiguration,
        expectedDraftVersion: 0,
        passwordAction: { confirm: true, kind: "clear" }
      } satisfies AdminEmailDraftInput,
      expectedActiveVersion: 0,
      testRecipient: "operator@example.test"
    }
  });
  expect(mutation.status()).toBe(403);
  await expect(mutation.json()).resolves.toEqual({ error: "forbidden" });

  await page.goto("/admin");
  await expect(page.getByTestId("admin-denied")).toContainText("Admin access required");
});
