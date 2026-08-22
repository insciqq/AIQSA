import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { DEFAULT_BOOTSTRAP_USER_ID } from "../../lib/server/auth/config";
import { hashPassword } from "../../lib/server/auth/password";
import { composerRunSummary, openModelPicker } from "./shell/composer";

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
  { id: "search", label: "Search" },
  { id: "knowledge", label: "Knowledge" },
  { id: "memory", label: "Memory" },
  { id: "users", label: "Users" },
  { id: "access", label: "Access & groups" },
  { id: "invites", label: "Invites" },
  { id: "access-rules", label: "Access rules" },
  { id: "usage", label: "Usage" },
  { id: "mcp", label: "MCP servers" },
  { id: "email", label: "Email delivery" },
  { id: "safety", label: "Safety" }
] as const;

type AdminSection = (typeof adminSections)[number];

function adminSection(id: AdminSection["id"]): AdminSection {
  const section = adminSections.find((candidate) => candidate.id === id);
  if (!section) {
    throw new Error(`Unknown admin section: ${id}`);
  }
  return section;
}

async function openAdminSection(page: Page, section: AdminSection): Promise<void> {
  const current = page.getByTestId(`admin-section-${section.id}`);
  if (await current.isVisible().catch(() => false)) return;

  const allSections = page.getByRole("button", { name: "All sections" });
  if (await allSections.isVisible().catch(() => false)) {
    await allSections.click();
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
  }

  const tab = page.getByRole("tab", { exact: true, name: section.label });
  await tab.click();
  const discardConfirmation = page.getByTestId("admin-discard-unsaved-confirmation");
  if (await discardConfirmation.isVisible().catch(() => false)) {
    await discardConfirmation
      .getByRole("button", { name: /confirm discard changes/i })
      .click();
  }
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
  await expect(page.getByTestId("admin-section-providers")).toBeVisible();
}

async function loginWithPassword(page: Page, email: string, password: string) {
  try {
    await page.goto("/login");
  } catch (error) {
    // Revoking or disabling a live session can make the shell start its own
    // login redirect at the same time as this explicit navigation. Chromium
    // aborts one of those duplicate navigations, but the resulting page is
    // still valid and is verified immediately below.
    if (!(error instanceof Error) || !error.message.includes("net::ERR_ABORTED")) {
      throw error;
    }
  }
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

function userRow(page: Page, email: string) {
  return page.getByTestId("admin-user-row").filter({ hasText: email });
}

function groupRow(section: Locator, name: string) {
  return section.getByTestId("admin-access-group-row").filter({ hasText: name });
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
  try {
    return await page.evaluate(
      (url) => fetch(url).then((response) => response.status),
      path
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /execution context was destroyed|cannot find context with specified id/iu.test(error.message)
    ) {
      return -1;
    }
    throw error;
  }
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

test("admin edits group membership from the group detail without dropping unrelated access", async ({ page }) => {
  const id = randomUUID();
  const memberEmail = `group-member-${id}@example.com`;
  const targetGroupName = `membership-target-${id.slice(0, 8)}`;
  const preservedGroupName = `membership-preserved-${id.slice(0, 8)}`;
  const archivedGroupName = `membership-archived-${id.slice(0, 8)}`;
  const [targetGroup, preservedGroup, archivedGroup] = await prisma.$transaction([
    prisma.group.create({ data: { name: targetGroupName } }),
    prisma.group.create({ data: { name: preservedGroupName } }),
    prisma.group.create({
      data: {
        archivedAt: new Date("2026-07-26T00:00:00.000Z"),
        name: archivedGroupName
      }
    })
  ]);
  const member = await prisma.user.create({
    data: {
      displayName: "Group Membership E2E User",
      email: memberEmail,
      groups: {
        create: [
          { groupId: preservedGroup.id },
          { groupId: archivedGroup.id }
        ]
      },
      status: "active"
    }
  });

  try {
    await bootstrapAdmin(page);
    await openAdminSection(page, adminSection("access"));
    const access = page.getByTestId("admin-section-access");
    const search = access.getByLabel("Search access groups");

    await search.fill(targetGroupName);
    await groupRow(access, targetGroupName).click();
    const detail = access.getByTestId("admin-access-group-detail");
    await detail.getByRole("button", { name: "Members" }).click();
    const candidate = detail.getByLabel("Add member");
    await expect(candidate).toContainText(memberEmail);
    await candidate.selectOption(member.id);
    await detail.getByRole("button", { name: "Add member" }).click();

    await expect
      .poll(async () =>
        (
          await prisma.userGroup.findMany({
            orderBy: { groupId: "asc" },
            select: { groupId: true },
            where: { userId: member.id }
          })
        ).map((membership) => membership.groupId)
      )
      .toEqual([archivedGroup.id, preservedGroup.id, targetGroup.id].sort());
    await expect(detail.getByText(memberEmail, { exact: false })).toBeVisible();
    const removeMember = detail.getByRole("button", { name: "Remove" });
    await expect(removeMember).toHaveCount(1);
    await removeMember.click();

    await expect
      .poll(async () =>
        (
          await prisma.userGroup.findMany({
            orderBy: { groupId: "asc" },
            select: { groupId: true },
            where: { userId: member.id }
          })
        ).map((membership) => membership.groupId)
      )
      .toEqual([archivedGroup.id, preservedGroup.id].sort());
    await expect(detail.getByRole("button", { name: "Remove" })).toHaveCount(0);

    await detail.getByRole("button", { name: "Back to access groups" }).click();
    await expect(search).toHaveValue(targetGroupName);
    await expect(groupRow(access, targetGroupName)).toBeVisible();

    await search.fill(archivedGroupName);
    await access.getByRole("button", { name: "archived" }).click();
    await groupRow(access, archivedGroupName).click();
    const archivedDetail = access.getByTestId("admin-access-group-detail");
    await archivedDetail.getByRole("button", { name: "Members" }).click();
    await expect(archivedDetail.getByText(memberEmail, { exact: false })).toBeVisible();
    await expect(archivedDetail.getByLabel("Add member")).toHaveCount(0);
    await expect(archivedDetail.getByRole("button", { name: "Add member" })).toHaveCount(0);
    await expect(archivedDetail.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(
      prisma.userGroup.findUnique({
        where: {
          userId_groupId: {
            groupId: archivedGroup.id,
            userId: member.id
          }
        }
      })
    ).resolves.not.toBeNull();
  } finally {
    await prisma.user.deleteMany({ where: { id: member.id } });
    await prisma.group.deleteMany({
      where: {
        id: {
          in: [targetGroup.id, preservedGroup.id, archivedGroup.id]
        }
      }
    });
  }
});

test("admin sees the built-in Full access group with automatic resource coverage", async ({ page }) => {
  await bootstrapAdmin(page);
  await openAdminSection(page, adminSection("access"));

  const access = page.getByTestId("admin-section-access");
  await access.getByLabel("Search access groups").fill("Full access");
  const row = groupRow(access, "Full access");
  await expect(row).toBeVisible();
  await expect(row.getByText("Built-in", { exact: true })).toBeVisible();
  await row.click();

  const detail = access.getByTestId("admin-access-group-detail");
  await expect(detail.getByRole("heading", { name: "Full access" })).toBeVisible();
  await expect(detail.getByText(/cannot be renamed, archived, or deleted/i)).toBeVisible();
  await expect(detail.getByRole("button", { name: "Rename group" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Archive group" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Delete group" })).toHaveCount(0);
  const systemGroup = await prisma.group.findUnique({
    select: {
      id: true,
      users: {
        select: {
          role: true,
          user: { select: { email: true } }
        }
      }
    },
    where: { systemRole: "full_access" }
  });
  expect(systemGroup?.users).toEqual([
    { role: "owner", user: { email: "operator@aiqsa.local" } }
  ]);

  await detail.getByRole("button", { name: "Members" }).click();
  await expect(detail.getByText("operator@aiqsa.local", { exact: false })).toBeVisible();
  await expect(detail.getByLabel("Add member")).toBeVisible();

  await detail.getByRole("button", { name: "Models & search" }).click();
  await expect(detail.getByRole("heading", { name: "Automatic full access" })).toBeVisible();
  await expect(
    detail.getByText(
      /independently selected provider credential and its current availability check are valid/i
    )
  ).toBeVisible();
  await expect(detail.getByRole("button", { name: /Grant provider/i })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /Grant model/i })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /Grant search/i })).toHaveCount(0);

  await detail.getByRole("button", { name: "Tools" }).click();
  await expect(detail.getByText(/included automatically/i).first()).toBeVisible();
  await expect(detail.getByText(/personal fields remain direct-user permissions/i)).toBeVisible();
  await expect(detail.getByRole("button", { name: /for group Full access/i })).toHaveCount(0);

  await page.setViewportSize({ height: 844, width: 390 });
  await detail.getByRole("button", { name: "Overview" }).click();
  await expect(
    detail.getByText(/provider credentials and personal MCP setup remain separate/i)
  ).toBeVisible();
  await expectNoPageOverflow(page);
});

test("admin creates and deletes an installation-owned MCP draft", async ({ page }) => {
  const serverName = `mem0-browser-${randomUUID().slice(0, 8)}`;

  try {
    await bootstrapAdmin(page);
    await openAdminSection(page, adminSection("mcp"));
    const section = page.getByTestId("admin-section-mcp");
    await expect(section).toBeVisible();

    await section.getByRole("button", { name: "New server" }).click();
    await expect(section.getByRole("heading", { name: "Add an MCP server" })).toBeVisible();
    await section.getByRole("button", { name: "Configure manually" }).click();
    await section.getByLabel("Display name").fill(serverName);
    await section.getByLabel("MCP endpoint URL").fill("https://mcp.example.com/mcp");
    await section.getByLabel("Mode").selectOption("oauth");
    await section.getByLabel("Allowed authorization server origins").fill("https://auth.example.com");
    await section.getByRole("button", { name: "Continue to authorization" }).click();

    await expect(section.getByRole("heading", { name: serverName })).toBeVisible();
    await expect(
      section.getByText(
        "MCP server draft created. Connect OAuth; AIQSA will then test and activate it automatically."
      )
    ).toBeVisible();
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
    await openAdminSection(page, adminSection("users"));

    const approvedRow = userRow(page, approvedEmail);
    await expect(approvedRow.getByText("pending")).toBeVisible();
    await approvedRow.click();
    const approvedDetail = page.getByTestId("admin-user-detail");
    await approvedDetail.getByLabel(group.name).check();
    await approvedDetail.getByRole("button", { name: "Approve user" }).click();
    await expect(approvedDetail.getByText("Active", { exact: true })).toBeVisible();
    const activeApprovedDetail = page.getByTestId("admin-user-detail");
    const saveGroups = activeApprovedDetail.getByRole("button", { name: "Save groups" });
    await expect(saveGroups).toBeDisabled();
    await expect(saveGroups).toHaveClass(/\bbg-control-surface\b/);
    const detailBox = await activeApprovedDetail.boundingBox();
    const saveGroupsBox = await saveGroups.boundingBox();
    expect(detailBox).toBeTruthy();
    expect(saveGroupsBox).toBeTruthy();
    expect(saveGroupsBox!.width).toBeLessThan(detailBox!.width / 2);
    await activeApprovedDetail.getByRole("button", { name: "Back to users" }).click();

    const rejectedRow = userRow(page, rejectedEmail);
    await expect(rejectedRow.getByText("pending")).toBeVisible();
    await rejectedRow.click();
    const rejectedDetail = page.getByTestId("admin-user-detail");
    await rejectedDetail.getByRole("button", { name: "Reject user" }).click();
    await confirmAdminDialog(page, "admin-confirm-reject-user", /confirm reject user/i);
    await expect(rejectedDetail.getByText("denied", { exact: true })).toBeVisible();

    await openAdminSection(page, adminSection("access-rules"));
    const rules = page.getByTestId("admin-section-access-rules");
    await rules.getByRole("button", { name: "New rule" }).click();
    await rules.getByLabel("Value").fill(ruleEmail);
    await rules.getByLabel(group.name).check();
    await rules.getByRole("button", { name: "Save rule" }).click();
    await expect(rules.getByText(ruleEmail)).toBeVisible();

    await openAdminSection(page, adminSection("invites"));
    const invites = page.getByTestId("admin-section-invites");
    await expect(invites.getByRole("button", { name: "Expiring soon" })).toBeVisible();
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
    await expect(userPage.getByRole("menu", { name: "Account" }).getByRole("link", { name: "Control Center" })).toHaveCount(0);
    await userPage.keyboard.press("Escape");
    await expect.poll(() => browserFetchStatus(userPage!, "/api/admin")).toBe(403);
    await userPage.goto("/admin");
    await expect(userPage.getByTestId("admin-denied")).toBeVisible();
    await userPage.goto("/");
    await expect(userPage.getByTestId("app-shell")).toBeVisible();
    let modelPicker = await openModelPicker(userPage);
    await expect(modelPicker).toContainText("Fake QSA");
    await userPage.keyboard.press("Escape");

    await openAdminSection(page, adminSection("access"));
    const access = page.getByTestId("admin-section-access");
    await access.getByLabel("Search access groups").fill(group.name);
    await groupRow(access, group.name).click();
    const groupDetail = access.getByTestId("admin-access-group-detail");
    await groupDetail.getByRole("button", { name: "Models & search" }).click();
    await groupDetail.getByLabel("Grant model Fake QSA / Fake QSA").click();
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
      modelPicker = await openModelPicker(userPage);
      await expect(modelPicker).not.toContainText("Fake QSA");
      await userPage.keyboard.press("Escape");
    } else {
      await expect(runSummary).toContainText("No models available");
      await expect(userPage.getByText(
        "No models available. Contact your administrator.",
        { exact: true }
      ).first()).toBeVisible();
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
        searchPlan: { mode: "all_selected", optionIds: [] },
        text: "stale entitlement check"
      }
    });
    expect(staleRun.status()).toBe(403);
    await expect(staleRun.json()).resolves.toEqual({
      error: "model_not_available"
    });

    await openAdminSection(page, adminSection("users"));
    const selectedUserDetail = page.getByTestId("admin-user-detail");
    if (await selectedUserDetail.isVisible()) {
      await selectedUserDetail.getByRole("button", { name: "Back to users" }).click();
      await expect(selectedUserDetail).toHaveCount(0);
    }
    await userRow(page, approvedEmail).click();
    const activeUserDetail = page.getByTestId("admin-user-detail");
    await expect(activeUserDetail.getByText("Disable this user before deletion can be considered.")).toBeVisible();
    await activeUserDetail.getByRole("button", { name: "Revoke sessions" }).click();
    await confirmAdminDialog(page, "admin-confirm-revoke-user-sessions", /confirm revoke sessions/i);
    await expect.poll(
      () => browserFetchStatus(userPage!, "/api/me"),
      { timeout: 15_000 }
    ).toBe(401);

    await loginWithPassword(userPage, approvedEmail, approvedPassword);
    await expect(userPage.getByTestId("app-shell")).toBeVisible();

    await activeUserDetail.getByRole("button", { name: "Disable user" }).click();
    await confirmAdminDialog(page, "admin-confirm-disable-user", /confirm disable user/i);
    await expect(activeUserDetail.getByText("Disabled", { exact: true })).toBeVisible();
    await expect.poll(
      () => browserFetchStatus(userPage!, "/api/me"),
      { timeout: 15_000 }
    ).toBe(401);
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

test("admin console keeps all redesigned sections operable end to end", async ({ page }) => {
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
    const adminEntry = page.getByRole("menu", { name: "Account" }).getByRole("link", {
      name: "Control Center"
    });
    await expect(adminEntry).toHaveAttribute("href", "/admin");
    await adminEntry.click();
    await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
    await expect(page.getByTestId("admin-section-providers")).toBeVisible();
    const sectionIndex = page.getByTestId("admin-section-index");
    await expect(sectionIndex.getByTestId("admin-nav-group-ai-setup")).toContainText("AI setup");
    await expect(sectionIndex.getByTestId("admin-nav-group-team-access")).toContainText("Team & access");
    await expect(sectionIndex.getByTestId("admin-nav-group-operations")).toContainText("Operations");
    await expect(sectionIndex.getByTestId("admin-nav-group-infrastructure")).toContainText("Infrastructure");
    await expect(sectionIndex.getByTestId("admin-nav-group-safety")).toContainText("Safety");
    await expect(sectionIndex.getByText("Personal", { exact: true })).toHaveCount(0);
    await expect(sectionIndex.getByText("Team", { exact: true })).toHaveCount(0);
    await expect(sectionIndex.getByText("Advanced", { exact: true })).toHaveCount(0);

    for (const section of adminSections) {
      await openAdminSection(page, section);
      await expectNoPageOverflow(page);
    }

    await page.setViewportSize({ height: 500, width: 1_440 });
    await page.goto("/admin?section=search");
    const searchSection = page.getByTestId("admin-section-search");
    const searchCatalog = searchSection.getByRole("list", { name: "Search source catalog" });
    await expect(searchCatalog).toBeVisible();
    await searchCatalog.getByRole("button").first().click();
    const searchOverview = searchSection.getByRole("region", { name: "Search overview" });
    await expect(searchOverview.getByText("One Search source", { exact: true })).toBeVisible();
    await expect(searchOverview.getByText("Compatible answer models", { exact: true })).toBeVisible();
    await expect(searchOverview.getByText("Availability", { exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.setViewportSize({ height: 900, width: 1_440 });

    await page.goto("/admin");
    await expect(page.getByTestId("admin-section-providers")).toBeVisible();
    await openAdminSection(page, adminSection("usage"));
    await openAdminSection(page, adminSection("access"));
    await page.goBack();
    await expect(page.getByTestId("admin-section-usage")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("admin-section-providers")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("admin-section-usage")).toBeVisible();

    for (const section of adminSections) {
      const path = section.id === "providers" ? "/admin" : `/admin?section=${section.id}`;
      await page.goto(path);
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
      await page.reload();
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
    }

    await page.goto("/admin?section=not-a-real-section");
    await expect(page.getByTestId("admin-section-providers")).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto("/admin?section=access");
    await expect(page.getByTestId("admin-section-access")).toBeVisible();
    const access = page.getByTestId("admin-section-access");
    await access.getByRole("button", { name: "New group" }).click();
    await access.getByLabel("Group name").fill(groupName);
    await access.getByRole("button", { name: "Create" }).click();
    await expect(groupRow(access, groupName)).toBeVisible();
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

    await access.getByLabel("Search access groups").fill(groupName);
    const createdGroupRow = groupRow(access, groupName);
    await expect(createdGroupRow).toBeVisible();
    await createdGroupRow.click();

    const groupDetail = access.getByTestId("admin-access-group-detail");
    await groupDetail.getByRole("button", { name: "Rename group" }).click();
    await groupDetail.getByLabel("Rename group").fill(renamedGroupName);
    await groupDetail.getByRole("button", { name: "Save" }).click();
    await expect(groupDetail.getByRole("heading", { name: renamedGroupName })).toBeVisible();

    await groupDetail.getByRole("button", { name: "Models & search" }).click();
    await groupDetail.getByLabel("Grant provider Fake QSA").click();
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

    await groupDetail.getByRole("button", { name: `Grant all Fake QSA models to ${renamedGroupName}` }).click();
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

    await groupDetail.getByRole("button", { name: "Grant search Anthropic Search" }).click();
    await expect
      .poll(async () =>
        prisma.accessGrant.findFirst({
          where: {
            enabled: true,
            groupId: groupId!,
            providerConnectionId: null,
            providerModelId: null,
            searchStrategy: "anthropic-web-search"
          }
        })
      )
      .not.toBeNull();

    await groupDetail.getByRole("button", { name: `Clear Fake QSA models from ${renamedGroupName}` }).click();
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

    await openAdminSection(page, adminSection("access-rules"));
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

    await openAdminSection(page, adminSection("invites"));
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

    await openAdminSection(page, adminSection("users"));
    const users = page.getByTestId("admin-section-users");
    await users.getByLabel("Search users").fill("operator@aiqsa.local");
    const selfRow = userRow(page, "operator@aiqsa.local");
    await expect(selfRow).toBeVisible();
    await selfRow.click();
    const selfDetail = page.getByTestId("admin-user-detail");
    await expect(selfDetail.getByText(/Self-disable and self-delete are not exposed/)).toBeVisible();
    await expect(selfDetail.getByRole("button", { name: "Delete stale user" })).toHaveCount(0);
    await selfDetail.getByRole("button", { name: "Back to users" }).click();

    await users.getByLabel("Search users").fill(staleUserEmail);
    const staleUserRow = userRow(page, staleUserEmail);
    await expect(staleUserRow).toBeVisible();
    await staleUserRow.click();
    await page.getByTestId("admin-user-detail").getByRole("button", { name: "Delete stale user" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-user", /confirm delete user/i);
    await expect(staleUserRow).toHaveCount(0);

    await openAdminSection(page, adminSection("access-rules"));
    const ruleSection = page.getByTestId("admin-section-access-rules");
    const ruleRow = accessRuleRow(ruleSection, domain);
    await expect(ruleRow).toBeVisible();
    await ruleRow.getByRole("button", { name: "Details" }).click();
    await page.getByTestId("admin-access-rule-detail").getByRole("button", { name: "Delete rule" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-access-rule", /confirm delete rule/i);
    await expect(ruleRow).toHaveCount(0);

    await openAdminSection(page, adminSection("access"));
    const accessAfterDelete = page.getByTestId("admin-section-access");
    await accessAfterDelete.getByRole("button", { name: "Back to access groups" }).click();
    await accessAfterDelete.getByLabel("Search access groups").fill(renamedGroupName);
    const renamedGroupRow = groupRow(accessAfterDelete, renamedGroupName);
    await expect(renamedGroupRow).toBeVisible();
    await renamedGroupRow.click();
    const blockedGroupDetail = accessAfterDelete.getByTestId("admin-access-group-detail");
    await expect(blockedGroupDetail.getByText(/Remove [0-9]+ active grants? before deleting this group\./)).toBeVisible();
    await blockedGroupDetail.getByRole("button", { name: "Back to access groups" }).click();

    await accessAfterDelete.getByLabel("Search access groups").fill(emptyGroupName);
    const emptyGroupRow = groupRow(accessAfterDelete, emptyGroupName);
    await expect(emptyGroupRow).toBeVisible();
    await emptyGroupRow.click();
    const emptyGroupDetail = accessAfterDelete.getByTestId("admin-access-group-detail");
    await emptyGroupDetail.getByRole("button", { name: "Delete group" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-group", /confirm delete group/i);
    await expect(emptyGroupRow).toHaveCount(0);
    emptyGroupId = null;

    await accessAfterDelete.getByLabel("Search access groups").fill(renamedGroupName);
    await expect(renamedGroupRow).toBeVisible();
    await renamedGroupRow.click();
    const groupToArchiveDetail = accessAfterDelete.getByTestId("admin-access-group-detail");
    await groupToArchiveDetail.getByRole("button", { name: "Archive group" }).click();
    await confirmAdminDialog(page, "admin-confirm-archive-group", /confirm archive group/i);
    await expect(groupToArchiveDetail.getByText(/Archived groups remain visible/)).toBeVisible();
    await groupToArchiveDetail.getByRole("button", { name: "Back to access groups" }).click();
    await expect(accessAfterDelete.getByRole("button", { name: "archived" })).toHaveAttribute("aria-pressed", "true");
    await expect(groupRow(accessAfterDelete, renamedGroupName)).toBeVisible();
    await groupRow(accessAfterDelete, renamedGroupName).click();
    const archivedAccessDetail = accessAfterDelete.getByTestId("admin-access-group-detail");
    await archivedAccessDetail.getByRole("button", { name: "Models & search" }).click();
    await expect(
      archivedAccessDetail.getByText("Archived groups do not apply grants. Access editing is disabled for this group.")
    ).toBeVisible();
    await expect(archivedAccessDetail.getByLabel("Grant provider Fake QSA")).toBeDisabled();

    await page.setViewportSize({
      height: 844,
      width: 390
    });
    await page.goto("/admin?section=users");
    await expect(page.getByTestId("admin-section-users")).toBeVisible();

    await openAdminSection(page, adminSection("safety"));
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
        .toBe(section.id === "providers" ? null : section.id);
      await expectNoPageOverflow(page);
    }

    await openAdminSection(page, adminSection("users"));
    const users = page.getByTestId("admin-section-users");
    await expectTouchTarget(users.getByLabel("Search users"));
    await expectTouchTarget(users.getByRole("button", { exact: true, name: "all" }));

    await users.getByLabel("Search users").fill("operator@aiqsa.local");
    const operatorRow = userRow(page, "operator@aiqsa.local");
    await operatorRow.scrollIntoViewIfNeeded();
    await expectTouchTarget(operatorRow);
    await operatorRow.click();
    const selectedDetail = page.getByTestId("admin-user-detail");
    await expect(selectedDetail).toContainText("Acting admin");
    await expectNoPageOverflow(page);
    const backToUsers = selectedDetail.getByRole("button", { name: "Back to users" });
    await expectTouchTarget(backToUsers);
    await backToUsers.click();
    await expect(users.getByLabel("Search users")).toHaveValue("operator@aiqsa.local");
    await expect(operatorRow).toBeVisible();

    await openAdminSection(page, adminSection("access"));
    const access = page.getByTestId("admin-section-access");
    await access.getByLabel("Search access groups").fill(compactGroupName);
    const newGroup = access.getByRole("button", { exact: true, name: "New group" });
    await expectTouchTarget(newGroup);
    await newGroup.click();
    await expectTouchTarget(access.getByLabel("Group name"));
    await expectTouchTarget(access.getByRole("button", { exact: true, name: "Create" }));
    await expectNoPageOverflow(page);
    const backToGroupsFromCreate = access.getByRole("button", { name: "Back to access groups" });
    await expectTouchTarget(backToGroupsFromCreate);
    await backToGroupsFromCreate.click();
    const accessGroupSearch = access.getByLabel("Search access groups");
    await expect(accessGroupSearch).toHaveValue(compactGroupName);
    const accessGroupRow = groupRow(access, compactGroupName);
    await expectTouchTarget(accessGroupRow);
    await accessGroupRow.scrollIntoViewIfNeeded();
    await accessGroupRow.click();
    const accessDetail = access.getByTestId("admin-access-group-detail");
    await expect(accessDetail).toBeVisible();
    const modelsAndSearch = accessDetail.getByRole("button", { name: "Models & search" });
    await expectTouchTarget(modelsAndSearch);
    await modelsAndSearch.click();
    await expectTouchTarget(accessDetail.getByRole("button", { name: /Grant provider / }).first());
    await expectNoPageOverflow(page);
    const backToAccessGroups = accessDetail.getByRole("button", { name: "Back to access groups" });
    await expectTouchTarget(backToAccessGroups);
    await backToAccessGroups.click();
    await expect(accessGroupSearch).toHaveValue(compactGroupName);
    await expect(accessGroupRow).toBeVisible();

    await openAdminSection(page, adminSection("invites"));
    const invites = page.getByTestId("admin-section-invites");
    await invites.getByLabel("Search invites").fill(compactGroupName);
    const newInvite = invites.getByRole("button", { exact: true, name: "New invite" });
    await expectTouchTarget(newInvite);
    await newInvite.click();
    const backToInvites = invites.getByRole("button", { name: "Back to invites" });
    await expect(backToInvites).toBeFocused();
    await expectTouchTarget(invites.getByLabel("Email", { exact: true }));
    await expectTouchTarget(invites.getByRole("button", { exact: true, name: "Create invite" }));
    await expectTouchTarget(invites.getByLabel(compactGroupName).locator(".."));
    await expectNoPageOverflow(page);
    for (const viewport of [
      { height: 768, width: 1024 },
      { height: 500, width: 1280 },
      { height: 900, width: 1440 }
    ]) {
      await page.setViewportSize(viewport);
      await expectNoPageOverflow(page);
      await expectReadableDetail(page, invites.getByTestId("admin-invites-detail-pane"));
    }
    await page.setViewportSize({ height: 844, width: 390 });
    await expectTouchTarget(backToInvites);
    await backToInvites.click();
    await expect(newInvite).toBeFocused();
    await expect(invites.getByLabel("Search invites")).toHaveValue(compactGroupName);

    await openAdminSection(page, adminSection("access-rules"));
    const rules = page.getByTestId("admin-section-access-rules");
    await rules.getByLabel("Search access rules").fill(compactGroupName);
    const newRule = rules.getByRole("button", { exact: true, name: "New rule" });
    await expectTouchTarget(newRule);
    await newRule.click();
    const backToRules = rules.getByRole("button", { name: "Back to access rules" });
    await expect(backToRules).toBeFocused();
    await expectTouchTarget(rules.getByLabel("Kind"));
    await expectTouchTarget(rules.getByLabel("Value"));
    await expectTouchTarget(rules.getByRole("button", { exact: true, name: "Save rule" }));
    await expectTouchTarget(rules.getByLabel(compactGroupName).locator(".."));
    await expectNoPageOverflow(page);
    for (const viewport of [
      { height: 768, width: 1024 },
      { height: 500, width: 1280 },
      { height: 900, width: 1440 }
    ]) {
      await page.setViewportSize(viewport);
      await expectNoPageOverflow(page);
      await expectReadableDetail(page, rules.getByTestId("admin-access-rules-detail-pane"));
    }
    await page.setViewportSize({ height: 844, width: 390 });
    await expectTouchTarget(backToRules);
    await backToRules.click();
    await expect(newRule).toBeFocused();
    await expect(rules.getByLabel("Search access rules")).toHaveValue(compactGroupName);

    await openAdminSection(page, adminSection("safety"));
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

    await openAdminSection(page, adminSection("usage"));
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
    await expectNoPageOverflow(page);

    await openAdminSection(page, adminSection("access-rules"));
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
    await openAdminSection(page, adminSection("users"));

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

    await openAdminSection(page, adminSection("usage"));
    const usage = page.getByTestId("admin-section-usage");
    await expect(usage.getByTestId("admin-usage-groups-mobile")).toBeVisible();
    await expect(usage.getByTestId("admin-usage-users-mobile")).toBeVisible();
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
    await expectNoPageOverflow(page);
  } finally {
    await context.close();
  }
});
