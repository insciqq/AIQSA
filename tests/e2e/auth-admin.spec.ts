import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { hashPassword } from "../../lib/server/auth/password";
import { closeRunSetup, composerRunSummary, openRunSetup } from "./shell/composer";

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

const adminSections = [
  { id: "providers", label: "Providers" },
  { id: "usage", label: "Usage" },
  { id: "users", label: "Users" },
  { id: "groups", label: "Groups" },
  { id: "model-access", label: "Model access" },
  { id: "invites", label: "Invites" },
  { id: "access-rules", label: "Access rules" },
  { id: "mcp", label: "MCP servers" },
  { id: "email", label: "Email delivery" },
  { id: "safety", label: "Safety" }
] as const;

type AdminSection = (typeof adminSections)[number];

const adminSectionGroup = {
  "access-rules": "Team",
  email: "Advanced",
  groups: "Team",
  invites: "Team",
  mcp: "Advanced",
  "model-access": "Team",
  providers: "Personal",
  safety: "Advanced",
  usage: "Personal",
  users: "Team"
} as const satisfies Record<AdminSection["id"], "Advanced" | "Personal" | "Team">;

async function openAdminSection(page: Page, section: AdminSection): Promise<void> {
  const current = page.getByTestId(`admin-section-${section.id}`);
  if (await current.isVisible().catch(() => false)) return;

  const allSections = page.getByRole("button", { name: "All sections" });
  if (await allSections.isVisible().catch(() => false)) {
    await allSections.click();
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
  }

  let tab = page.getByRole("tab", { exact: true, name: section.label });
  if ((await tab.count()) === 0) {
    const group = adminSectionGroup[section.id];
    if (group !== "Personal") {
      await page.getByRole("button", { exact: true, name: group }).click();
      tab = page.getByRole("tab", { exact: true, name: section.label });
    }
  }

  await tab.click();
  await expect(current).toBeVisible();
}

async function expectNoPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        body: document.body.scrollWidth <= document.body.clientWidth,
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth
      }))
    )
    .toEqual({ body: true, document: true });
}

async function expectTouchTarget(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(43);
  expect(box!.height).toBeGreaterThanOrEqual(43);
}

async function createPasswordUser(input: {
  displayName: string;
  email: string;
  password: string;
}) {
  return prisma.user.create({
    data: {
      authIdentities: {
        create: {
          emailVerifiedAt: new Date("2026-06-14T00:00:00.000Z"),
          normalizedEmail: input.email,
          passwordHash: await hashPassword(input.password),
          provider: "password",
          providerAccountId: input.email
        }
      },
      displayName: input.displayName,
      email: input.email,
      status: "pending"
    }
  });
}

async function bootstrapAdmin(page: Page) {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin|\/login\?next=\/admin/);
  const response = await page.request.post("/api/auth/token", {
    data: {
      token: "aiqsa-test-token"
    }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
  await expect(page.getByTestId("admin-section-users")).toBeVisible();
}

async function loginWithPassword(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

function userRow(page: Page, email: string) {
  return page.getByTestId("admin-user-row").filter({ hasText: email });
}

function groupRow(section: Locator, name: string) {
  return section.getByTestId("admin-group").filter({ hasText: name });
}

function inviteRow(section: Locator, email: string) {
  return section.getByTestId("admin-invite-row").filter({ hasText: email });
}

function accessRuleRow(section: Locator, value: string) {
  return section.getByTestId("admin-access-rule-row").filter({ hasText: value });
}

async function confirmAdminDialog(page: Page, testId: string, buttonName: RegExp) {
  const dialog = page.getByTestId(testId);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: buttonName }).click();
}

async function browserFetchStatus(page: Page, path: string): Promise<number> {
  return page.evaluate((url) => fetch(url).then((response) => response.status), path);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test("admin API rejects a direct self-disable attempt", async ({ page }) => {
  await bootstrapAdmin(page);

  const response = await page.request.post("/api/admin/action", {
    data: {
      action: "disable_user",
      userId: DEFAULT_BOOTSTRAP_USER_ID
    }
  });

  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: "self_disable_forbidden" });
  await expect(
    prisma.user.findUniqueOrThrow({
      select: { status: true },
      where: { id: DEFAULT_BOOTSTRAP_USER_ID }
    })
  ).resolves.toEqual({ status: "active" });
});

test("admin creates and deletes an installation-owned MCP draft", async ({ page }) => {
  const serverName = `mem0-browser-${randomUUID().slice(0, 8)}`;

  try {
    await bootstrapAdmin(page);
    await openAdminSection(page, adminSections[7]);
    const section = page.getByTestId("admin-section-mcp");
    await expect(section).toBeVisible();

    await section.getByRole("button", { name: "New server" }).click();
    await expect(section.getByRole("heading", { name: "Add an MCP server" })).toBeVisible();
    await section.getByRole("button", { name: "Configure manually" }).click();
    await section.getByLabel("Display name").fill(serverName);
    await section.getByLabel("MCP endpoint URL").fill("https://mcp.example.com/mcp");
    await section.getByLabel("Mode").selectOption("oauth");
    await section.getByLabel("Allowed authorization server origins").fill("https://auth.example.com");
    await section.getByRole("button", { name: "Create draft" }).click();

    await expect(section.getByRole("heading", { name: serverName })).toBeVisible();
    await expect(section.getByText("Activation trusts this server as one unit.", { exact: false })).toBeVisible();
    await section.getByRole("button", { name: /Delete Irreversible removal/u }).click();
    await section.getByRole("button", { name: "Delete…" }).click();
    await section.getByRole("button", { name: "Delete server" }).click();
    await expect(section.getByText("MCP server deleted.")).toBeVisible();
    await expect(section.getByRole("heading", { name: serverName })).toHaveCount(0);
  } finally {
    await prisma.mcpServer.deleteMany({ where: { displayName: serverName } });
  }
});

test("admin manages approvals, rules, invites, session revocation, and disabling", async ({ browser, page }) => {
  test.setTimeout(90_000);
  const id = randomUUID();
  const domain = `admin-e2e-${id}.example.com`;
  const approvedEmail = `approved@${domain}`;
  const rejectedEmail = `rejected@${domain}`;
  const ruleEmail = `rule@${domain}`;
  const inviteEmail = `invite@${domain}`;
  const linkOnlyInviteEmail = `link-only@${domain}`;
  const approvedPassword = `approved-password-${id}`;
  const invitePassword = `invite-password-${id}`;
  const rejectedPassword = `rejected-password-${id}`;
  const group = await prisma.group.create({
    data: {
      name: `admin-e2e-${id}`
    }
  });
  let invitePage: Page | null = null;
  let userPage: Page | null = null;
  let rejectedPage: Page | null = null;

  await prisma.accessGrant.createMany({
    data: [
      {
        groupId: group.id,
        providerConnectionId: providerTemplateIds.openAiConnection
      },
      {
        groupId: group.id,
        providerModelId: providerTemplateIds.fakeModel
      },
      {
        groupId: group.id,
        searchStrategy: "openai-native-web-search"
      }
    ]
  });
  await createPasswordUser({
    displayName: "Approved E2E User",
    email: approvedEmail,
    password: approvedPassword
  });
  await createPasswordUser({
    displayName: "Rejected E2E User",
    email: rejectedEmail,
    password: rejectedPassword
  });

  try {
    await bootstrapAdmin(page);

    const approvedRow = userRow(page, approvedEmail);
    await expect(approvedRow.getByText("pending")).toBeVisible();
    await approvedRow.getByRole("button", { name: "Review" }).click();
    const approvedDetail = page.getByTestId("admin-user-detail");
    await approvedDetail.getByLabel(group.name).check();
    await approvedDetail.getByRole("button", { name: "Approve user" }).click();
    await expect(approvedRow.getByText("active")).toBeVisible();

    const rejectedRow = userRow(page, rejectedEmail);
    await expect(rejectedRow.getByText("pending")).toBeVisible();
    await rejectedRow.getByRole("button", { name: "Review" }).click();
    await page.getByTestId("admin-user-detail").getByRole("button", { name: "Reject user" }).click();
    await confirmAdminDialog(page, "admin-confirm-reject-user", /confirm reject user/i);
    await expect(rejectedRow.getByText("denied")).toBeVisible();

    await openAdminSection(page, adminSections[6]);
    const rules = page.getByTestId("admin-section-access-rules");
    await rules.getByRole("button", { name: "New rule" }).click();
    await rules.getByLabel("Value").fill(ruleEmail);
    await rules.getByLabel(group.name).check();
    await rules.getByRole("button", { name: "Save rule" }).click();
    await expect(rules.getByText(ruleEmail)).toBeVisible();

    await openAdminSection(page, adminSections[5]);
    const invites = page.getByTestId("admin-section-invites");
    await invites.getByRole("button", { name: "New invite" }).click();
    await invites.getByLabel("Email", { exact: true }).fill(inviteEmail);
    await invites.getByLabel(group.name).check();
    await expect(invites.getByRole("checkbox", { name: "Send invitation email" })).toBeChecked();
    await invites.getByRole("button", { name: "Create invite" }).click();
    const inviteLink = invites.getByLabel("Invite create-account link");
    await expect(inviteLink).toHaveValue(/\/login\?invite=/);
    await expect(page.getByText("Invite created and email sent.")).toBeVisible();
    await expect
      .poll(async () => (await listAuthEmails(page.request)).filter((message) => message.to === inviteEmail).length)
      .toBe(1);
    const [inviteMessage] = (await listAuthEmails(page.request)).filter((message) => message.to === inviteEmail);
    expect(inviteMessage).toMatchObject({
      subject: "You're invited to AIQSA",
      to: inviteEmail
    });
    expect(inviteMessage?.text).toContain(await inviteLink.inputValue());
    expect(inviteMessage?.text).not.toContain(group.name);
    await expect(invites.getByText(inviteEmail)).toBeVisible();

    const inviteContext = await browser.newContext();
    invitePage = await inviteContext.newPage();
    await invitePage.goto(await inviteLink.inputValue());
    await expect(invitePage.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
    await expect(invitePage.getByLabel("Email")).toHaveCount(0);
    await invitePage.getByLabel("Name").fill("Invited E2E User");
    await invitePage.getByLabel("Password", { exact: true }).fill(invitePassword);
    await invitePage.getByRole("button", { name: "Create account" }).click();
    await expect(invitePage.getByTestId("app-shell")).toBeVisible();
    await expect
      .poll(async () => (await listAuthEmails(page.request)).filter((message) => message.to === inviteEmail).length)
      .toBe(1);
    await expect(
      prisma.user.findUniqueOrThrow({
        include: {
          authIdentities: true,
          groups: true
        },
        where: {
          email: inviteEmail
        }
      })
    ).resolves.toMatchObject({
      authIdentities: [
        expect.objectContaining({
          emailVerifiedAt: expect.any(Date),
          provider: "password"
        })
      ],
      displayName: "Invited E2E User",
      groups: [expect.objectContaining({ groupId: group.id })],
      status: "active"
    });

    await invites.getByLabel("Email", { exact: true }).fill(linkOnlyInviteEmail);
    await invites.getByRole("checkbox", { name: "Send invitation email" }).uncheck();
    await invites.getByRole("button", { name: "Create invite" }).click();
    await expect(page.getByText("Invite created without email. Copy and share the link below.")).toBeVisible();
    await expect(invites.getByText("No invitation email was sent.")).toBeVisible();
    await expect(invites.getByLabel("Invite create-account link")).toHaveValue(/\/login\?invite=/);
    expect((await listAuthEmails(page.request)).filter((message) => message.to === linkOnlyInviteEmail)).toHaveLength(0);

    const userContext = await browser.newContext();
    userPage = await userContext.newPage();
    await loginWithPassword(userPage, approvedEmail, approvedPassword);
    await expect(userPage.getByTestId("app-shell")).toBeVisible();
    await userPage.getByRole("button", { name: "Account menu" }).click();
    await expect(userPage.getByRole("menu", { name: "Account" }).getByRole("menuitem", { name: "Control Center" })).toHaveCount(0);
    await userPage.keyboard.press("Escape");
    await expect.poll(() => browserFetchStatus(userPage!, "/api/admin")).toBe(403);
    await userPage.goto("/admin");
    await expect(userPage.getByTestId("admin-denied")).toBeVisible();
    await userPage.goto("/");
    await expect(userPage.getByTestId("app-shell")).toBeVisible();
    let runSetup = await openRunSetup(userPage);
    await runSetup.getByRole("button", { name: "Select model" }).click();
    await expect(userPage.getByTestId("model-picker")).toContainText("Fake QSA");
    await userPage.keyboard.press("Escape");
    await closeRunSetup(userPage);

    await openAdminSection(page, adminSections[4]);
    const modelAccess = page.getByTestId("admin-section-model-access");
    await modelAccess.getByTestId("admin-model-access-group-list").getByRole("button", { name: `Select ${group.name}` }).click();
    const groupCard = modelAccess.getByTestId("admin-model-access-group").filter({ hasText: group.name });
    await groupCard.getByLabel("Grant model Fake QSA / Fake QSA").click();
    await expect
      .poll(async () => {
        const grant = await prisma.accessGrant.findFirst({
          where: {
            enabled: true,
            groupId: group.id,
            providerModelId: providerTemplateIds.fakeModel
          }
        });

        return grant ? "present" : "absent";
      })
      .toBe("absent");

    const catalogRefresh = userPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/me/catalog";
    });
    await userPage.reload();
    expect((await catalogRefresh).ok()).toBe(true);
    await expect(userPage.getByTestId("app-shell")).toBeVisible();
    const runSummary = composerRunSummary(userPage);
    await expect(runSummary).not.toContainText("Fake QSA");
    if (await runSummary.isEnabled()) {
      runSetup = await openRunSetup(userPage);
      await runSetup.getByRole("button", { name: "Select model" }).click();
      await expect(userPage.getByTestId("model-picker")).not.toContainText("Fake QSA");
      await userPage.keyboard.press("Escape");
      await closeRunSetup(userPage);
    } else {
      await expect(runSummary).toContainText("No models available");
      await expect(userPage.getByText("This workspace has no models available yet.")).toBeVisible();
    }

    const createChat = await userPage.request.post("/api/chats", {
      data: {
        title: `Stale entitlement ${id}`
      }
    });
    expect(createChat.status()).toBe(201);
    const created = (await createChat.json()) as { chat: { id: string } };
    const staleRun = await userPage.request.post(`/api/chats/${created.chat.id}/messages`, {
      data: {
        modelId: providerTemplateIds.fakeModel,
        provider: providerTemplateIds.fakeConnection,
        searchStrategy: "search-disabled",
        text: "stale entitlement check"
      }
    });
    expect(staleRun.status()).toBe(403);
    await expect(staleRun.json()).resolves.toEqual({
      error: "model_not_available"
    });

    await openAdminSection(page, adminSections[2]);
    await approvedRow.getByRole("button", { name: "Details" }).click();
    await expect(page.getByTestId("admin-user-detail").getByText("Disable this user before deletion can be considered.")).toBeVisible();
    await page.getByTestId("admin-user-detail").getByRole("button", { name: "Revoke sessions" }).click();
    await confirmAdminDialog(page, "admin-confirm-revoke-user-sessions", /confirm revoke sessions/i);
    await expect.poll(() => browserFetchStatus(userPage!, "/api/me")).toBe(401);

    await loginWithPassword(userPage, approvedEmail, approvedPassword);
    await expect(userPage.getByTestId("app-shell")).toBeVisible();

    await page.getByTestId("admin-user-detail").getByRole("button", { name: "Disable user" }).click();
    await confirmAdminDialog(page, "admin-confirm-disable-user", /confirm disable user/i);
    await expect(approvedRow.getByText("disabled")).toBeVisible();
    await expect.poll(() => browserFetchStatus(userPage!, "/api/me")).toBe(401);
    await loginWithPassword(userPage, approvedEmail, approvedPassword);
    await expect(userPage.getByText("The credentials were not accepted. (unauthorized)")).toBeVisible();

    const rejectedContext = await browser.newContext();
    rejectedPage = await rejectedContext.newPage();
    await loginWithPassword(rejectedPage, rejectedEmail, rejectedPassword);
    await expect(rejectedPage.getByText("The credentials were not accepted. (unauthorized)")).toBeVisible();
  } finally {
    await invitePage?.context().close();
    await userPage?.context().close();
    await rejectedPage?.context().close();
    await prisma.authFlowToken.deleteMany({
      where: {
        normalizedEmail: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.authInvite.deleteMany({
      where: {
        normalizedEmail: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        OR: [
          {
            value: domain
          },
          {
            value: {
              endsWith: `@${domain}`
            }
          }
        ]
      }
    });
    await prisma.user.deleteMany({
      where: {
        email: {
          endsWith: `@${domain}`
        }
      }
    });
    await prisma.group.deleteMany({
      where: {
        id: group.id
      }
    });
  }
});

test("admin console keeps all redesigned sections operable end to end", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(5_000);

  const id = randomUUID();
  const shortId = id.slice(0, 8);
  const domain = `admin-polish-${id}.example.com`;
  const groupName = `ops-polish-${shortId}`;
  const renamedGroupName = `ops-review-${shortId}`;
  const inviteEmail = `invite@${domain}`;
  const staleUserEmail = `stale-delete@${domain}`;
  const emptyGroupName = `empty-delete-${shortId}`;
  let groupId: string | null = null;
  let emptyGroupId: string | null = null;

  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await prisma.user.create({
      data: {
        displayName: "Stale Delete E2E User",
        email: staleUserEmail,
        status: "pending"
      }
    });
    const emptyGroup = await prisma.group.create({
      data: {
        name: emptyGroupName
      }
    });
    emptyGroupId = emptyGroup.id;
    await bootstrapAdmin(page);

    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    const adminEntry = page.getByRole("menu", { name: "Account" }).getByRole("menuitem", {
      name: "Control Center"
    });
    await expect(adminEntry).toHaveAttribute("href", "/admin?section=providers");
    await adminEntry.click();
    await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
    await expect(page.getByTestId("admin-section-providers")).toBeVisible();

    for (const section of adminSections) {
      await openAdminSection(page, section);
      await expectNoPageOverflow(page);
    }

    await page.goto("/admin?section=providers");
    await openAdminSection(page, adminSections[1]);
    await openAdminSection(page, adminSections[3]);
    await page.goBack();
    await expect(page.getByTestId("admin-section-usage")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("admin-section-providers")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("admin-section-usage")).toBeVisible();

    for (const section of adminSections) {
      const path = section.id === "users" ? "/admin" : `/admin?section=${section.id}`;
      await page.goto(path);
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
      await page.reload();
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
    }

    await page.goto("/admin?section=not-a-real-section");
    await expect(page.getByTestId("admin-section-users")).toBeVisible();

    await page.goto("/admin?section=groups");
    await expect(page.getByTestId("admin-section-groups")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await expect(page.getByTestId("admin-section-groups")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");

    const groups = page.getByTestId("admin-section-groups");
    await groups.getByRole("button", { name: "New group" }).click();
    await groups.getByLabel("Group name").fill(groupName);
    await groups.getByRole("button", { name: "Create" }).click();
    await expect(groupRow(groups, groupName)).toBeVisible();
    groupId =
      (
        await prisma.group.findUnique({
          select: {
            id: true
          },
          where: {
            name: groupName
          }
        })
      )?.id ?? null;
    expect(groupId).not.toBeNull();

    await groups.getByLabel("Search groups").fill(groupName);
    const createdGroupRow = groupRow(groups, groupName);
    await expect(createdGroupRow).toBeVisible();
    await createdGroupRow.getByRole("button", { name: "Details" }).click();

    const groupDetail = page.getByTestId("admin-group-detail");
    await groupDetail.getByRole("button", { name: "Rename group" }).click();
    await groupDetail.getByLabel("Rename group").fill(renamedGroupName);
    await groupDetail.getByRole("button", { name: "Save" }).click();
    await groups.getByLabel("Search groups").fill(renamedGroupName);
    await expect(groupRow(groups, renamedGroupName)).toBeVisible();

    await openAdminSection(page, adminSections[4]);
    const modelAccess = page.getByTestId("admin-section-model-access");
    await modelAccess.getByLabel("Search model access groups").fill(renamedGroupName);
    await modelAccess.getByRole("button", { name: `Select ${renamedGroupName}` }).click();
    const modelGroup = modelAccess.getByTestId("admin-model-access-group").filter({ hasText: renamedGroupName });
    await modelGroup.getByLabel("Grant provider Fake QSA").click();
    await expect
      .poll(async () =>
        prisma.accessGrant.findFirst({
          where: {
            enabled: true,
            groupId: groupId!,
            providerConnectionId: providerTemplateIds.fakeConnection,
            providerModelId: null,
            searchStrategy: null
          }
        })
      )
      .not.toBeNull();

    await modelGroup.getByRole("button", { name: `Grant all Fake QSA models to ${renamedGroupName}` }).click();
    await expect
      .poll(() =>
        prisma.accessGrant.count({
          where: {
            enabled: true,
            groupId: groupId!,
            providerModelId: {
              not: null
            },
            providerModel: {
              connectionId: providerTemplateIds.fakeConnection
            }
          }
        })
      )
      .toBeGreaterThan(0);

    await modelGroup.getByRole("button", { name: "Grant search OpenAI web_search" }).click();
    await expect
      .poll(async () =>
        prisma.accessGrant.findFirst({
          where: {
            enabled: true,
            groupId: groupId!,
            providerConnectionId: null,
            providerModelId: null,
            searchStrategy: "openai-native-web-search"
          }
        })
      )
      .not.toBeNull();

    await modelGroup.getByRole("button", { name: `Clear Fake QSA models from ${renamedGroupName}` }).click();
    await expect
      .poll(() =>
        prisma.accessGrant.count({
          where: {
            enabled: true,
            groupId: groupId!,
            providerModelId: {
              not: null
            },
            providerModel: {
              connectionId: providerTemplateIds.fakeConnection
            }
          }
        })
      )
      .toBe(0);

    await openAdminSection(page, adminSections[6]);
    const rules = page.getByTestId("admin-section-access-rules");
    await rules.getByRole("button", { name: "New rule" }).click();
    await rules.getByLabel("Kind").selectOption("domain");
    await rules.getByLabel("Value").fill(` ${domain.toUpperCase()} `);
    await expect(rules.getByText(domain)).toBeVisible();
    await rules.getByLabel(renamedGroupName).check();
    await rules.getByRole("button", { name: "Save rule" }).click();
    await expect(rules.getByText(domain)).toBeVisible();
    await rules.getByLabel("Search access rules").fill(domain);
    await expect(rules.getByText(domain)).toBeVisible();

    await openAdminSection(page, adminSections[5]);
    const invites = page.getByTestId("admin-section-invites");
    await invites.getByRole("button", { name: "New invite" }).click();
    await invites.getByLabel("Email", { exact: true }).fill(inviteEmail);
    await invites.getByLabel(renamedGroupName).check();
    await invites.getByRole("button", { name: "Create invite" }).click();
    await expect(invites.getByLabel("Invite create-account link")).toHaveValue(/\/login\?invite=/);
    await invites.getByRole("button", { name: "Copy" }).click();
    await expect(invites.getByRole("button", { name: "Copied" })).toBeVisible();
    await invites.getByLabel("Search invites").fill(inviteEmail);
    await expect(invites.getByText(inviteEmail)).toBeVisible();
    const createdInviteRow = inviteRow(invites, inviteEmail);
    await createdInviteRow.getByRole("button", { name: "Details" }).click();
    await page.getByTestId("admin-invite-detail").getByRole("button", { name: "Revoke invite" }).click();
    await confirmAdminDialog(page, "admin-confirm-revoke-invite", /confirm revoke invite/i);
    await expect(createdInviteRow.getByText("revoked", { exact: true })).toBeVisible();
    await page.getByTestId("admin-invite-detail").getByRole("button", { name: "Delete invite" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-invite", /confirm delete invite/i);
    await expect(createdInviteRow).toHaveCount(0);

    await openAdminSection(page, adminSections[2]);
    const users = page.getByTestId("admin-section-users");
    await users.getByLabel("Search users").fill("operator@aiqsa.local");
    const selfRow = userRow(page, "operator@aiqsa.local");
    await expect(selfRow).toBeVisible();
    await selfRow.getByRole("button", { name: "Details" }).click();
    await expect(
      page.getByTestId("admin-user-detail").getByText(/Self-disable and self-delete are not exposed/)
    ).toBeVisible();
    await expect(selfRow.getByRole("button", { name: "Delete" })).toHaveCount(0);

    await users.getByLabel("Search users").fill(staleUserEmail);
    const staleUserRow = userRow(page, staleUserEmail);
    await expect(staleUserRow).toBeVisible();
    await staleUserRow.getByRole("button", { name: "Review" }).click();
    await page.getByTestId("admin-user-detail").getByRole("button", { name: "Delete stale user" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-user", /confirm delete user/i);
    await expect(staleUserRow).toHaveCount(0);

    await openAdminSection(page, adminSections[6]);
    const ruleSection = page.getByTestId("admin-section-access-rules");
    const ruleRow = accessRuleRow(ruleSection, domain);
    await expect(ruleRow).toBeVisible();
    await ruleRow.getByRole("button", { name: "Details" }).click();
    await page.getByTestId("admin-access-rule-detail").getByRole("button", { name: "Delete rule" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-access-rule", /confirm delete rule/i);
    await expect(ruleRow).toHaveCount(0);

    await openAdminSection(page, adminSections[3]);
    const groupsAfterDelete = page.getByTestId("admin-section-groups");
    await groupsAfterDelete.getByLabel("Search groups").fill(renamedGroupName);
    const renamedGroupRow = groupRow(groupsAfterDelete, renamedGroupName);
    await expect(renamedGroupRow).toBeVisible();
    await renamedGroupRow.getByRole("button", { name: "Details" }).click();
    const archivedGroupDetail = page.getByTestId("admin-group-detail");
    await expect(archivedGroupDetail.getByText(/Remove [0-9]+ active grants? before deleting this group\./)).toBeVisible();
    await groupsAfterDelete.getByLabel("Search groups").fill(emptyGroupName);
    const emptyGroupRow = groupRow(groupsAfterDelete, emptyGroupName);
    await expect(emptyGroupRow).toBeVisible();
    await emptyGroupRow.getByRole("button", { name: "Details" }).click();
    const emptyGroupDetail = page.getByTestId("admin-group-detail");
    await emptyGroupDetail.getByRole("button", { name: "Delete group" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-group", /confirm delete group/i);
    await expect(emptyGroupRow).toHaveCount(0);
    emptyGroupId = null;
    await groupsAfterDelete.getByLabel("Search groups").fill(renamedGroupName);
    await expect(renamedGroupRow).toBeVisible();
    await renamedGroupRow.getByRole("button", { name: "Details" }).click();
    await archivedGroupDetail.getByRole("button", { name: "Archive group" }).click();
    await confirmAdminDialog(page, "admin-confirm-archive-group", /confirm archive group/i);
    await expect(archivedGroupDetail.getByText(/Archived groups remain visible/)).toBeVisible();
    await groupsAfterDelete.getByRole("button", { name: "archived" }).click();
    await expect(groupRow(groupsAfterDelete, renamedGroupName)).toBeVisible();

    await openAdminSection(page, adminSections[4]);
    const archivedModelAccess = page.getByTestId("admin-section-model-access");
    await archivedModelAccess.getByLabel("Search model access groups").fill(renamedGroupName);
    await archivedModelAccess.getByRole("button", { name: `Select ${renamedGroupName}` }).click();
    await expect(
      archivedModelAccess.getByText("Archived groups do not apply grants. Grant editing is disabled for this group.")
    ).toBeVisible();
    await expect(archivedModelAccess.getByLabel("Grant provider Fake QSA")).toBeDisabled();

    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("admin-desktop.png")
    });
    await page.setViewportSize({
      height: 844,
      width: 390
    });
    await page.goto("/admin?section=users");
    await expect(page.getByTestId("admin-section-users")).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath("admin-compact.png")
    });

    await openAdminSection(page, adminSections[9]);
    await page.getByRole("button", { name: "Revoke all sessions" }).click();
    await confirmAdminDialog(page, "admin-confirm-revoke-all-sessions", /confirm revoke all sessions/i);
    await expect.poll(() => browserFetchStatus(page, "/api/me")).toBe(401);
  } finally {
    await prisma.authFlowToken.deleteMany({
      where: {
        normalizedEmail: inviteEmail
      }
    });
    await prisma.authInvite.deleteMany({
      where: {
        normalizedEmail: inviteEmail
      }
    });
    await prisma.authAccessRule.deleteMany({
      where: {
        value: domain
      }
    });
    await prisma.user.deleteMany({
      where: {
        email: staleUserEmail
      }
    });

    const fallbackGroups = await prisma.group.findMany({
      select: {
        id: true
      },
      where: {
        name: {
          in: [groupName, renamedGroupName, emptyGroupName]
        }
      }
    });
    const cleanupGroupIds = [
      ...new Set([groupId, emptyGroupId, ...fallbackGroups.map((group) => group.id)].filter(Boolean))
    ] as string[];

    if (cleanupGroupIds.length) {
      await prisma.accessGrant.deleteMany({
        where: {
          groupId: {
            in: cleanupGroupIds
          }
        }
      });
      await prisma.group.deleteMany({
        where: {
          id: {
            in: cleanupGroupIds
          }
        }
      });
    }
  }
});

test("admin console keeps every section touch-operable in the documented compact viewport", async ({
  baseURL,
  browser
}) => {
  test.setTimeout(60_000);
  expect(baseURL).toBeTruthy();
  const compactGroupName = `compact-touch-${randomUUID().slice(0, 8)}`;
  const compactGroup = await prisma.group.create({
    data: {
      name: compactGroupName
    }
  });
  const context = await browser.newContext({
    baseURL,
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    viewport: { height: 844, width: 390 }
  });
  const page = await context.newPage();

  try {
    await bootstrapAdmin(page);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          coarse: window.matchMedia("(pointer: coarse)").matches,
          hoverNone: window.matchMedia("(hover: none)").matches,
          width: window.innerWidth
        }))
      )
      .toEqual({ coarse: true, hoverNone: true, width: 390 });

    for (const section of adminSections) {
      await openAdminSection(page, section);
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => new URL(window.location.href).searchParams.get("section")))
        .toBe(section.id === "users" ? null : section.id);
      await expectNoPageOverflow(page);
    }

    await openAdminSection(page, adminSections[2]);
    const users = page.getByTestId("admin-section-users");
    await expectTouchTarget(users.getByLabel("Search users"));
    await expectTouchTarget(users.getByRole("button", { exact: true, name: "all" }));
    await expect(users.locator('[data-admin-renderer="replacement"]')).toBeVisible();
    await expect(users.locator('[data-admin-renderer="legacy-embedded"]')).toHaveCount(0);

    await users.getByLabel("Search users").fill("operator@aiqsa.local");
    const operatorRow = userRow(page, "operator@aiqsa.local");
    const detailsTrigger = operatorRow.getByRole("button", { name: "Details" });
    await detailsTrigger.scrollIntoViewIfNeeded();
    await expectTouchTarget(detailsTrigger);
    await detailsTrigger.click();
    const selectedDetail = page.getByTestId("admin-user-detail");
    await expect(selectedDetail).toContainText("Acting admin");
    await expectNoPageOverflow(page);
    const backToUsers = selectedDetail.getByRole("button", { name: "Back to users" });
    await expectTouchTarget(backToUsers);
    await backToUsers.click();
    await expect(users.getByLabel("Search users")).toHaveValue("operator@aiqsa.local");
    await expect(operatorRow).toBeVisible();

    await openAdminSection(page, adminSections[3]);
    const groups = page.getByTestId("admin-section-groups");
    await groups.getByLabel("Search groups").fill(compactGroupName);
    const newGroup = groups.getByRole("button", { exact: true, name: "New group" });
    await expectTouchTarget(newGroup);
    await newGroup.click();
    await expectTouchTarget(groups.getByLabel("Group name"));
    await expectTouchTarget(groups.getByRole("button", { exact: true, name: "Create" }));
    await expectNoPageOverflow(page);
    const backToGroupsFromCreate = groups.getByRole("button", { name: "Back to groups" });
    await expectTouchTarget(backToGroupsFromCreate);
    await backToGroupsFromCreate.click();
    await expect(groups.getByLabel("Search groups")).toHaveValue(compactGroupName);

    await openAdminSection(page, adminSections[4]);
    const modelAccess = page.getByTestId("admin-section-model-access");
    const modelGroupSearch = modelAccess.getByLabel("Search model access groups");
    await expectTouchTarget(modelGroupSearch);
    await modelGroupSearch.fill(compactGroupName);
    const modelGroupSelect = modelAccess.getByRole("button", { name: `Select ${compactGroupName}` });
    await expectTouchTarget(modelGroupSelect);
    await modelGroupSelect.scrollIntoViewIfNeeded();
    await modelGroupSelect.click();
    const modelAccessDetail = modelAccess.getByTestId("admin-model-access-group");
    await expect(modelAccessDetail).toBeVisible();
    await expectTouchTarget(modelAccess.getByRole("button", { name: /Grant provider / }).first());
    await expectNoPageOverflow(page);
    const backToModelGroups = modelAccessDetail.getByRole("button", { name: "Back to groups" });
    await expectTouchTarget(backToModelGroups);
    await backToModelGroups.click();
    await expect(modelGroupSearch).toHaveValue(compactGroupName);
    await expect(modelGroupSelect).toBeVisible();

    await openAdminSection(page, adminSections[5]);
    const invites = page.getByTestId("admin-section-invites");
    await invites.getByLabel("Search invites").fill(compactGroupName);
    const newInvite = invites.getByRole("button", { exact: true, name: "New invite" });
    await expectTouchTarget(newInvite);
    await newInvite.click();
    await expectTouchTarget(invites.getByLabel("Email", { exact: true }));
    await expectTouchTarget(invites.getByRole("button", { exact: true, name: "Create invite" }));
    await expectTouchTarget(invites.getByLabel(compactGroupName).locator(".."));
    await expectNoPageOverflow(page);
    const backToInvites = invites.getByRole("button", { name: "Back to invites" });
    await expectTouchTarget(backToInvites);
    await backToInvites.click();
    await expect(invites.getByLabel("Search invites")).toHaveValue(compactGroupName);

    await openAdminSection(page, adminSections[6]);
    const rules = page.getByTestId("admin-section-access-rules");
    await rules.getByLabel("Search access rules").fill(compactGroupName);
    const newRule = rules.getByRole("button", { exact: true, name: "New rule" });
    await expectTouchTarget(newRule);
    await newRule.click();
    await expectTouchTarget(rules.getByLabel("Kind"));
    await expectTouchTarget(rules.getByLabel("Value"));
    await expectTouchTarget(rules.getByRole("button", { exact: true, name: "Save rule" }));
    await expectTouchTarget(rules.getByLabel(compactGroupName).locator(".."));
    await expectNoPageOverflow(page);
    const backToRules = rules.getByRole("button", { name: "Back to access rules" });
    await expectTouchTarget(backToRules);
    await backToRules.click();
    await expect(rules.getByLabel("Search access rules")).toHaveValue(compactGroupName);

    await openAdminSection(page, adminSections[9]);
    const revokeAll = page.getByRole("button", { exact: true, name: "Revoke all sessions" });
    await expectTouchTarget(revokeAll);
    await revokeAll.click();
    const confirmation = page.getByTestId("admin-confirm-revoke-all-sessions");
    await expect(confirmation).toBeVisible();
    await expectTouchTarget(confirmation.getByRole("button", { exact: true, name: "Confirm revoke all sessions" }));
    await expectTouchTarget(confirmation.getByRole("button", { name: "Cancel" }));
    await expectNoPageOverflow(page);
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveCount(0);
  } finally {
    await context.close();
    await prisma.group.deleteMany({
      where: {
        id: compactGroup.id
      }
    });
  }
});

test("admin compact usage and empty access-rule states stay in the visible workflow", async ({
  baseURL,
  browser
}) => {
  expect(baseURL).toBeTruthy();
  const context = await browser.newContext({
    baseURL,
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true,
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    viewport: { height: 844, width: 390 }
  });
  const page = await context.newPage();

  try {
    await bootstrapAdmin(page);

    await openAdminSection(page, adminSections[1]);
    const usage = page.getByTestId("admin-section-usage");
    const summary = usage.getByRole("region", { name: "Usage summary" });
    await expect(summary).toBeVisible();
    await summary.scrollIntoViewIfNeeded();
    await expect(summary.getByText("Input tokens", { exact: true })).toBeInViewport();
    await expect(summary.getByText("Last usage", { exact: true })).toBeInViewport();
    await expect
      .poll(() =>
        summary.evaluate((element) => element.scrollWidth <= element.clientWidth)
      )
      .toBe(true);

    const usageNote = usage.getByText(/This view uses provider-reported usage rows/);
    await expect
      .poll(() =>
        usageNote.evaluate((element) => element.scrollWidth <= element.clientWidth)
      )
      .toBe(true);
    await expect(usage.getByTestId("admin-usage-groups-mobile")).toBeVisible();
    await expect(usage.getByTestId("admin-usage-users-mobile")).toBeVisible();
    await expect(usage.getByRole("table")).toHaveCount(0);
    await expect(usage.locator('[data-admin-renderer="replacement"]')).toBeVisible();
    await expectNoPageOverflow(page);

    await openAdminSection(page, adminSections[6]);
    const rules = page.getByTestId("admin-section-access-rules");
    await rules.getByLabel("Search access rules").fill("definitely-no-matching-access-rule");
    const emptyState = rules.getByRole("status");
    await expect(emptyState).toContainText(/No access rules/);
    await expect
      .poll(() =>
        emptyState.evaluate((element) => {
          const owner = element.parentElement;
          if (!owner) return false;
          const elementRect = element.getBoundingClientRect();
          const ownerRect = owner.getBoundingClientRect();
          return elementRect.left >= ownerRect.left && elementRect.right <= ownerRect.right;
        })
      )
      .toBe(true);
    await expectNoPageOverflow(page);
  } finally {
    await context.close();
  }
});

test("Control Center keeps the current workflow in the short-landscape viewport", async ({
  baseURL,
  browser
}) => {
  expect(baseURL).toBeTruthy();
  const context = await browser.newContext({
    baseURL,
    colorScheme: "dark",
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    viewport: { height: 390, width: 844 }
  });
  const page = await context.newPage();

  try {
    await bootstrapAdmin(page);

    const users = page.getByTestId("admin-section-users");
    await expect(users.getByRole("heading", { exact: true, name: "Users" })).toBeInViewport();
    await expect(users.getByLabel("Search users")).toBeInViewport();
    await expect(page.getByTestId("admin-section-index-pane")).toBeHidden();

    await page.getByRole("button", { name: "All sections" }).click();
    const navigation = page.getByRole("tablist", { name: "Control Center sections" });
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
    await expect(page.getByTestId("admin-active-task-pane")).toBeHidden();
    await expect(navigation).toBeVisible();
    await expect
      .poll(() => navigation.evaluate((element) => getComputedStyle(element).overflowY))
      .toBe("auto");
    await expect(page.getByRole("tab", { exact: true, name: "Providers" })).toBeInViewport();

    await page.goBack();
    await expect(users).toBeVisible();
    await expect(page.getByTestId("admin-section-index-pane")).toBeHidden();
    await page.goForward();
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(users).toBeVisible();

    await openAdminSection(page, adminSections[1]);
    const usage = page.getByTestId("admin-section-usage");
    await expect(usage.getByTestId("admin-usage-groups-mobile")).toBeVisible();
    await expect(usage.getByTestId("admin-usage-users-mobile")).toBeVisible();
    await expect(usage.getByRole("table")).toHaveCount(0);
    await expectNoPageOverflow(page);
  } finally {
    await context.close();
  }
});

test("Control Center uses the compact section-index task model at tablet width", async ({
  baseURL,
  browser
}) => {
  expect(baseURL).toBeTruthy();
  const context = await browser.newContext({
    baseURL,
    colorScheme: "light",
    hasTouch: true,
    locale: "en-US",
    reducedMotion: "reduce",
    timezoneId: "UTC",
    viewport: { height: 1024, width: 768 }
  });
  const page = await context.newPage();

  try {
    await bootstrapAdmin(page);
    await expect(page.getByTestId("admin-active-task-pane")).toBeVisible();
    await expect(page.getByTestId("admin-section-index-pane")).toBeHidden();
    await expect(page.getByRole("button", { name: "All sections" })).toBeVisible();

    await page.getByRole("button", { name: "All sections" }).click();
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
    await expect(page.getByTestId("admin-active-task-pane")).toBeHidden();
    await expect(page.getByRole("tab", { exact: true, name: "Providers" })).toBeVisible();
    await expect(page.getByRole("tab", { exact: true, name: "Usage" })).toBeVisible();

    await page.getByRole("tab", { exact: true, name: "Usage" }).click();
    const usage = page.getByTestId("admin-section-usage");
    await expect(usage).toBeVisible();
    await expect(usage.getByRole("region", { name: "Usage summary" })).toBeVisible();
    await expect(usage.getByTestId("admin-usage-groups-mobile")).toBeVisible();
    await expect(usage.getByTestId("admin-usage-users-mobile")).toBeVisible();
    await expect(usage.getByRole("table")).toHaveCount(0);
    await expectNoPageOverflow(page);
  } finally {
    await context.close();
  }
});
