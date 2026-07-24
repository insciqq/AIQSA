import { expect, test, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type {
  AdminEmailConfiguration,
  AdminEmailSaveRequest,
  AdminEmailState
} from "../../lib/contracts/email";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
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

async function signInOrdinaryUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
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
  await page.getByRole("tab", { name: "Email delivery" }).click();
  const section = page.getByTestId("admin-section-email");
  await expect(section.getByText("SMTP draft")).toBeVisible();

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
  await expect(section.getByLabel("Password action")).toHaveValue("preserve");
  await expect(section.getByLabel("New password")).toHaveCount(0);
  await expect(section).not.toContainText(secret);
  expect(JSON.stringify(email)).not.toContain(secret);

  await section.getByLabel("Test recipient").fill("operator@example.test");
  await section.getByRole("button", { name: "Test draft" }).click();
  await expect(section.getByText(/accepted the test message/i)).toBeVisible();
  expect(testBodies).toEqual([{
    action: "test",
    expectedDraftVersion: 1,
    recipient: "operator@example.test"
  }]);
  expect(JSON.stringify(email)).not.toContain("operator@example.test");

  await section.getByRole("button", { name: "Activate" }).click();
  await expect(section.getByText("The tested email draft is now active.")).toBeVisible();
  await expect(section.getByText("Active", { exact: true })).toBeVisible();
  expect(email.active).toMatchObject({ enabled: true, passwordConfigured: true, version: 1 });
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
