import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type {
  AdminEmailConfiguration,
  AdminEmailSaveRequest,
  AdminEmailState
} from "../../lib/contracts/email";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe
} from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

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

async function openEmailDelivery(page: Page) {
  const section = page.getByTestId("admin-section-email");
  if (await section.isVisible().catch(() => false)) {
    return section;
  }

  const allSections = page.getByRole("button", { name: "All sections" });
  if (await allSections.isVisible().catch(() => false)) {
    await allSections.click();
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
  }

  let emailTab = page.getByRole("tab", { exact: true, name: "Email delivery" });
  if ((await emailTab.count()) === 0) {
    await page.getByRole("button", { exact: true, name: "Advanced" }).click();
    emailTab = page.getByRole("tab", { exact: true, name: "Email delivery" });
  }

  await emailTab.click();
  await expect(section).toBeVisible();
  return section;
}

async function signInOrdinaryUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

async function expectReadableDetail(page: Page, detail: Locator) {
  const box = await detail.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.width).toBeGreaterThanOrEqual(640);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

test("admin saves, tests, and activates a write-only SMTP draft without network SMTP", async ({ page }) => {
  let email = emptyEmailState();
  const saveBodies: AdminEmailSaveRequest[] = [];
  const testBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });

  await page.route("**/api/admin/email", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { email } });
      return;
    }

    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "PUT") {
      const save = body as AdminEmailSaveRequest;
      saveBodies.push(save);
      email = {
        ...email,
        configurationUpdatedAt: "2026-07-23T16:00:00.000Z",
        configurationUpdatedByUserId: "00000000-0000-4000-8000-000000000001",
        draft: {
          configuration: save.configuration,
          passwordConfigured: save.passwordAction.kind !== "clear",
          test: null,
          version: email.draft.version + 1
        }
      };
      await route.fulfill({ contentType: "application/json", json: { email } });
      return;
    }

    if (request.method() === "POST" && body.action === "test") {
      testBodies.push(body);
      email = {
        ...email,
        draft: {
          ...email.draft,
          test: {
            attemptedAt: "2026-07-23T16:01:00.000Z",
            code: "accepted",
            tested: true,
            version: email.draft.version
          }
        }
      };
      await route.fulfill({
        contentType: "application/json",
        json: { email, test: { code: "accepted", tested: true } }
      });
      return;
    }

    if (request.method() === "POST" && body.action === "activate") {
      const nextVersion = email.active.version + 1;
      email = {
        ...email,
        active: {
          activatedAt: "2026-07-23T16:02:00.000Z",
          activatedByUserId: "00000000-0000-4000-8000-000000000001",
          configuration: email.draft.configuration,
          enabled: true,
          passwordConfigured: email.draft.passwordConfigured,
          version: nextVersion
        },
        health: {
          activeVersion: nextVersion,
          degraded: false,
          lastAcceptedAt: null,
          lastAttemptAt: null,
          lastFailureAt: null,
          lastFailureCode: null
        }
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

  await signInWithLocalToken(page);
  await page.goto("/admin");
  const section = await openEmailDelivery(page);
  await expectNoHorizontalOverflow(page);
  await expect(section.getByRole("heading", { name: "Email tasks" })).toBeVisible();
  await section.getByRole("button", { name: /Draft configuration/u }).click();
  await expect(section.getByRole("heading", { name: "Draft configuration" })).toBeVisible();

  const secret = "playwright-write-only-smtp-password";
  await section.getByLabel("SMTP host").fill("smtp.example.test");
  await section.getByLabel("From address").fill("noreply@example.test");
  await section.getByLabel("Username").fill("mailer@example.test");
  await section.getByLabel("New password").fill(secret);
  await section.getByRole("button", { name: "Save draft" }).click();

  await expect(section.getByText("Email draft saved. Test it before activation.")).toBeVisible();
  expect(saveBodies).toHaveLength(1);
  expect(saveBodies[0]).toMatchObject({
    configuration: {
      authentication: { mode: "password", username: "mailer@example.test" },
      from: { address: "noreply@example.test", displayName: "AIQSA" },
      host: "smtp.example.test",
      port: 587,
      transport: "starttls_required"
    },
    expectedDraftVersion: 0,
    passwordAction: { kind: "replace", password: secret }
  });
  await expect(section.getByRole("heading", { name: "Test & activate" })).toBeVisible();
  await expect(section).not.toContainText(secret);
  expect(JSON.stringify(email)).not.toContain(secret);

  await section.getByRole("button", { name: /Draft configuration/u }).click();
  await expect(section.getByLabel("Password action")).toHaveValue("preserve");
  await expect(section.getByLabel("New password")).toHaveCount(0);
  await section.getByRole("button", { name: /Test & activate/u }).click();

  await section.getByLabel("Test recipient").fill("operator@example.test");
  await section.getByRole("button", { name: "Test draft" }).click();
  await expect(section.getByText(/accepted the test message/i)).toBeVisible();
  expect(testBodies).toEqual([{
    action: "test",
    expectedDraftVersion: 1,
    recipient: "operator@example.test"
  }]);
  expect(JSON.stringify(email)).not.toContain("operator@example.test");

  await section.getByTestId("email-task-detail").getByRole("button", { name: "Activate", exact: true }).click();
  await expect(section.getByText("The tested email draft is now active.")).toBeVisible();
  await expect(section.getByRole("heading", { name: "Runtime & health" })).toBeVisible();
  await expect(section.locator('[data-resource-availability="enabled"]').first()).toHaveText("Enabled");
  await expect(section.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  expect(email.active).toMatchObject({ enabled: true, passwordConfigured: true, version: 1 });

  for (const viewport of [
    { height: 768, width: 1024 },
    { height: 500, width: 1280 },
    { height: 900, width: 1440 }
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    await expectReadableDetail(page, section.getByTestId("email-task-detail"));
  }

  await page.setViewportSize({ height: 900, width: 768 });
  await expectNoHorizontalOverflow(page);
  const backToTasks = section.getByRole("button", { name: "Back to email tasks" });
  await backToTasks.click();
  await expect(section.getByTestId("email-task-index")).toBeVisible();

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  const runtimeTask = section.getByRole("button", { name: /Runtime & health/u });
  await expectTouchSafe(runtimeTask);
  await runtimeTask.click();
  await expect(section.getByTestId("email-task-detail")).toBeVisible();

  await page.setViewportSize({ height: 390, width: 844 });
  await expectNoHorizontalOverflow(page);
  await backToTasks.scrollIntoViewIfNeeded();
  await backToTasks.click();
  await expect(section.getByTestId("email-task-index")).toBeVisible();
});

test("guards a dirty Control Center form across section navigation and native reload", async ({ page }) => {
  const email = emptyEmailState();
  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
  });
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

  await signInWithLocalToken(page);
  await page.goto("/admin");
  const section = await openEmailDelivery(page);
  await section.getByRole("button", { name: /Draft configuration/u }).click();
  const host = section.getByLabel("SMTP host");
  const dirtyHost = "dirty-navigation.smtp.example.test";
  await host.fill(dirtyHost);
  const originalUrl = page.url();

  const usageTab = page.getByRole("tab", { exact: true, name: "Usage" });
  await usageTab.click();
  const discard = page.getByTestId("admin-discard-unsaved-confirmation");
  await expect(discard.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
  await expect(page).toHaveURL(originalUrl);
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(host).toHaveValue(dirtyHost);
  await expect(section).toBeVisible();
  await expect(usageTab).toBeFocused();

  const nativeDialogPromise = page.waitForEvent("dialog");
  const reloadPromise = page.reload({ timeout: 1_000, waitUntil: "domcontentloaded" }).catch(() => null);
  const nativeDialog = await nativeDialogPromise;
  expect(nativeDialog.type()).toBe("beforeunload");
  await nativeDialog.dismiss();
  await reloadPromise;
  await expect(page).toHaveURL(originalUrl);
  await expect(host).toHaveValue(dirtyHost);

  await usageTab.click();
  await expect(discard.getByRole("heading", { name: "Discard unsaved changes?" })).toBeVisible();
  await discard.getByRole("button", { name: "Confirm discard changes" }).click();
  await expect(page.getByTestId("admin-section-usage")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\?section=usage$/);
});

test("ordinary user receives real active-admin denial for email configuration", async ({ page }) => {
  await signInOrdinaryUser(page);

  const read = await page.request.get("/api/admin/email");
  expect(read.status()).toBe(403);
  await expect(read.json()).resolves.toEqual({ error: "forbidden" });

  const mutation = await page.request.put("/api/admin/email", {
    data: {
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
    }
  });
  expect(mutation.status()).toBe(403);
  await expect(mutation.json()).resolves.toEqual({ error: "forbidden" });

  await page.goto("/admin");
  await expect(page.getByTestId("admin-denied")).toContainText("Admin access required");
});
