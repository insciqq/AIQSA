import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { LOCAL_OPERATOR_EMAIL, LOCAL_OPERATOR_PASSWORD } from "../../prisma/local-seed-auth";

test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();

type TestEmail = {
  subject: string;
  text: string;
  to: string;
};

async function listAuthEmails(request: APIRequestContext): Promise<TestEmail[]> {
  const response = await request.get("/api/test/auth-mails");
  expect(response.ok()).toBe(true);

  return ((await response.json()) as { emails: TestEmail[] }).emails;
}

function verificationPath(email: TestEmail): string {
  const match = /https?:\/\/[^\s]+\/login\?verify=([^\s]+)/.exec(email.text);
  expect(match?.[1]).toBeTruthy();

  return `/login?verify=${match![1]}`;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        body: document.body.scrollWidth <= document.body.clientWidth,
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
      }))
    )
    .toEqual({ body: true, document: true });
}

async function expectWithinViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const [box, viewport] = await Promise.all([locator.boundingBox(), page.viewportSize()]);
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("signs in through the visible form with the stable seeded local operator credential", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_OPERATOR_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_OPERATOR_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
});

test("keeps auth forms keyboard-safe and mobile-friendly without exposing recovery login", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/login");

  await expect(page.getByText("AIQSA", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password", { exact: true });
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(email).toHaveAttribute("inputmode", "email");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(page.getByLabel("Access token")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Bootstrap token" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Continue with Yandex" })).toHaveCount(0);

  await page.getByRole("button", { name: "Sign in" }).click();
  const validationAlert = page.getByRole("alert").filter({ hasText: "credentials_required" });
  await expect(validationAlert).toContainText("credentials_required");

  await email.fill("keyboard.user@example.com");
  await email.press("Tab");
  await expect(password).toBeFocused();
  await password.fill("keyboard-password");
  await password.press("Tab");
  const showPassword = page.getByRole("button", { name: "Show password" });
  await expect(showPassword).toBeFocused();
  await showPassword.press("Enter");
  await expect(password).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide password" })).toBeFocused();
  await expect(password).toHaveValue("keyboard-password");
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "Request access" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Request access" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByLabel("Name")).toHaveAttribute("autocomplete", "name");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Request access" })).toBeInViewport();
  await expectNoHorizontalOverflow(page);

  await page.goto("/login?invite=browser-evidence-invite-token");
  await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveAttribute("autocomplete", "name");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create account" })).toBeInViewport();
  await expect(page.getByText("browser-evidence-invite-token")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.goto("/login");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeInViewport();
  await expectNoHorizontalOverflow(page);

  await page.goto("/login?reset=browser-evidence-reset-token");
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByRole("button", { name: "Update password" })).toBeInViewport();
  await expectNoHorizontalOverflow(page);

  await page.goto("/login?verify=browser-evidence-verification-token");
  await expect(page.getByRole("heading", { level: 1, name: "Choose your password" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByRole("button", { name: "Set password and verify" })).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test("renders a safe OAuth callback outcome without exposing provider details", async ({ page }) => {
  await page.goto("/login?oauth=not_allowed&provider=yandex&next=https://evil.example/steal");

  await expect(page.getByRole("alert")).toHaveText(
    "This Yandex account is not allowed to access AIQSA. (oauth_not_allowed)"
  );
  await expect(page.getByText("evil.example")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("keeps request and invite registration actions inside a 1280x720 auth panel", async ({ page }) => {
  await page.setViewportSize({ height: 720, width: 1280 });

  await page.goto("/login");
  await page.getByRole("button", { name: "Request access" }).click();
  const requestPanel = page.locator('section[aria-labelledby="auth-screen-title"]');
  await expect(page.getByRole("heading", { level: 1, name: "Request access" })).toBeVisible();
  await expectWithinViewport(page, requestPanel);
  await expectWithinViewport(page, page.getByRole("button", { name: "Request access" }));
  await expectWithinViewport(page, page.getByRole("button", { name: "Back to sign in" }));
  await expectNoHorizontalOverflow(page);

  await page.goto("/login?invite=browser-evidence-invite-token");
  const invitePanel = page.locator('section[aria-labelledby="auth-screen-title"]');
  await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
  await expectWithinViewport(page, invitePanel);
  await expectWithinViewport(page, page.getByRole("button", { name: "Create account" }));
  await expectWithinViewport(page, page.getByRole("button", { name: "Back to sign in" }));
  await expect(page.getByText("browser-evidence-invite-token")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("registers, verifies, logs in, and sees an isolated workspace", async ({ page }) => {
  const id = randomUUID();
  const email = `e2e-registration-${id}@example.com`;
  const password = `registration-password-${id}`;
  const group = await prisma.group.create({
    data: {
      name: `e2e-registration-${id}`
    }
  });

  await prisma.accessGrant.createMany({
    data: [
      {
        groupId: group.id,
        provider: "openai",
        modelId: "gpt-5.5"
      },
      {
        groupId: group.id,
        searchStrategy: "openai-native-web-search"
      }
    ]
  });
  await prisma.authAccessRule.create({
    data: {
      defaultGroups: {
        create: {
          groupId: group.id
        }
      },
      kind: "email",
      value: email
    }
  });

  try {
    await page.request.delete("/api/test/auth-mails");
    await page.goto("/login");
    await page.getByRole("button", { name: "Request access" }).click();
    await page.getByLabel("Name").fill("E2E Registration");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Request access" }).click();

    await expect(
      page.getByText("Request received. If verification is needed, use the email link before signing in.")
    ).toBeVisible();
    await expect
      .poll(async () => (await listAuthEmails(page.request)).filter((message) => message.to === email).length)
      .toBe(1);

    const [emailMessage] = (await listAuthEmails(page.request)).filter((message) => message.to === email);
    await page.goto(verificationPath(emailMessage!));
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Set password and verify" }).click();
    await expect(
      page.getByText("Email verified and password set. Your account is active. Sign in to continue.")
    ).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]verify=/);

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByTestId("app-shell")).toBeVisible();
    const workspace = (await (await page.request.get("/api/chats")).json()) as { chats: unknown[] };
    expect(workspace.chats).toHaveLength(0);
    await expect(page.getByTestId("current-chat-title")).toHaveText("New chat");
    await expect(page.getByTestId("thread")).not.toContainText("Compare native web search");
  } finally {
    await prisma.user.deleteMany({
      where: {
        email
      }
    });
    await prisma.authFlowToken.deleteMany({
      where: {
        normalizedEmail: email
      }
    });
    await prisma.authInvite.deleteMany({
      where: {
        normalizedEmail: email
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        value: email
      }
    });
    await prisma.group.deleteMany({
      where: {
        id: group.id
      }
    });
  }
});

test("rejects disallowed registration before email verification", async ({ page }) => {
  const id = randomUUID();
  const allowedDomain = `allowed-registration-${id}.example.com`;
  const deniedEmail = `blocked@allowed-registration-${id}o.example.com`;

  await prisma.authAccessRule.create({
    data: {
      kind: "domain",
      value: allowedDomain
    }
  });

  try {
    await page.request.delete("/api/test/auth-mails");
    await page.goto("/login");
    await page.getByRole("button", { name: "Request access" }).click();
    await page.getByLabel("Name").fill("Denied Registration");
    await page.getByLabel("Email").fill(deniedEmail);
    await page.getByRole("button", { name: "Request access" }).click();

    await expect(page.getByText("This email or domain is not allowed to request access. (registration_not_allowed)")).toBeVisible();
    await expect(page.getByText("Use the verification link we sent before signing in.")).toHaveCount(0);
    await expect.poll(async () => (await listAuthEmails(page.request)).filter((message) => message.to === deniedEmail).length).toBe(0);
    await expect(
      prisma.user.findUnique({
        where: {
          email: deniedEmail
        }
      })
    ).resolves.toBeNull();
  } finally {
    await prisma.authFlowToken.deleteMany({
      where: {
        normalizedEmail: deniedEmail
      }
    });
    await prisma.user.deleteMany({
      where: {
        email: deniedEmail
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        value: allowedDomain
      }
    });
  }
});
