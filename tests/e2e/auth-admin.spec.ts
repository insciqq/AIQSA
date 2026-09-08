import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { AdminSystemModelCandidate, AdminSystemModelPolicyResponse } from "../../lib/contracts/adminSystemModelPolicy";
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
  { id: "overview", label: "Overview" },
  { id: "providers", label: "Providers" },
  { id: "roles", label: "Defaults & roles" },
  { id: "search", label: "Search" },
  { id: "retrieval", label: "Knowledge & Memory" },
  { id: "users", label: "Users" },
  { id: "groups", label: "Groups" },
  { id: "mcp", label: "MCP servers" },
  { id: "workspace", label: "Workspace" },
  { id: "email", label: "Email" },
  { id: "usage", label: "Usage" }
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

  const sectionsButton = page.getByRole("button", { name: "Sections" });
  if (await sectionsButton.isVisible().catch(() => false)) {
    await sectionsButton.click();
    await expect(page.getByRole("dialog", { name: "Control Center sections" })).toBeVisible();
  }

  const link = page.getByTestId("admin-section-index").getByRole("link", { exact: true, name: section.label });
  await link.click();
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
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("admin-section-overview")).toBeVisible();
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
  return section.getByTestId("admin-group-row").filter({ hasText: name });
}

function inviteRow(section: Locator, email: string) {
  return section.getByTestId("admin-invite-row").filter({ hasText: email });
}

function signupRule(sheet: Locator, value: string) {
  return sheet.getByTestId("admin-signup-rule").filter({ hasText: value });
}

function usersCrumb(page: Page) {
  return page.getByTestId("admin-topbar-title").getByRole("link", { name: "Users" });
}

/** Opens the Users section and returns to its list when a user page is open. */
async function openUsersList(page: Page): Promise<void> {
  await openAdminSection(page, adminSection("users"));
  const crumb = usersCrumb(page);
  if (await crumb.isVisible().catch(() => false)) {
    await crumb.click();
  }
  await expect(page.getByTestId("admin-users-index")).toBeVisible();
}

async function expectContainedInViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
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
    await openAdminSection(page, adminSection("groups"));
    const access = page.getByTestId("admin-section-groups");
    const search = access.getByLabel("Search groups");

    await search.fill(targetGroupName);
    await groupRow(access, targetGroupName).getByRole("link").click();
    const detail = access.getByTestId("admin-group-page");
    await detail.getByRole("button", { name: "Add a person" }).click();
    await page.getByRole("combobox", { name: "Search people" }).fill(memberEmail);
    await page.getByRole("option").filter({ hasText: memberEmail }).click();

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

    await page.getByTestId("admin-topbar-title").getByRole("link", { name: "Groups" }).click();
    await expect(search).toHaveValue(targetGroupName);
    await expect(groupRow(access, targetGroupName)).toBeVisible();

    await search.fill(archivedGroupName);
    await access.getByRole("button", { name: /^Archived · / }).click();
    await groupRow(access, archivedGroupName).getByRole("link").click();
    const archivedDetail = access.getByTestId("admin-group-page");
    await expect(archivedDetail.getByText(memberEmail, { exact: false })).toBeVisible();
    await expect(archivedDetail.getByRole("button", { name: "Add a person" })).toHaveCount(0);
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
  await openAdminSection(page, adminSection("groups"));

  const access = page.getByTestId("admin-section-groups");
  await access.getByLabel("Search groups").fill("Full access");
  const row = groupRow(access, "Full access");
  await expect(row).toBeVisible();
  await expect(row.getByText("Built-in", { exact: true })).toBeVisible();
  await row.getByRole("link").click();

  const detail = access.getByTestId("admin-group-page");
  await expect(detail.getByRole("heading", { name: "Full access" })).toBeVisible();
  await expect(detail.getByText(/cannot be renamed, archived or deleted/i)).toBeVisible();
  await expect(detail.getByRole("button", { name: "Rename" })).toHaveCount(0);
  await expect(detail.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "More actions for Full access" })).toHaveCount(0);
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

  await expect(detail.getByText("operator@aiqsa.local", { exact: false })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Add a person" })).toBeVisible();
  await expect(detail.getByTestId("admin-group-full-access")).toBeVisible();
  await expect(detail.getByRole("checkbox")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /Grant all/i })).toHaveCount(0);

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(detail.getByText(/Provider keys and personal MCP values stay separate/i)).toBeVisible();
  await expectNoPageOverflow(page);
});

test("admin creates and deletes an installation-owned MCP draft", async ({ page }) => {
  const serverName = `mem0-browser-${randomUUID().slice(0, 8)}`;

  try {
    await bootstrapAdmin(page);
    await openAdminSection(page, adminSection("mcp"));
    const section = page.getByTestId("admin-section-mcp");
    await expect(section).toBeVisible();

    await page.getByTestId("mcp-new-server").click();
    const form = page.getByRole("dialog", { name: "New server", exact: true });
    await expect(form).toBeVisible();
    await form.getByRole("button", { name: "Configure manually" }).click();
    await form.getByLabel("Name", { exact: true }).fill(serverName);
    await form.getByLabel("MCP endpoint URL").fill("https://mcp.example.com/mcp");
    await form.getByLabel("Mode").selectOption("oauth");
    await form.getByLabel("Allowed authorization server origins").fill("https://auth.example.com");
    await form.getByRole("button", { name: "Save and continue" }).click();
    await expect(form).toBeHidden();

    await expect(section.getByRole("heading", { name: serverName })).toBeVisible();
    await expect(page.getByTestId("admin-feedback"))
      .toContainText("Settings saved. Connect your account to check and apply them.");
    await page.getByRole("button", { name: `More actions for ${serverName}` }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-mcp-server", /confirm delete server/i);
    await expect(page.getByTestId("admin-feedback")).toContainText("MCP server deleted.");
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
    await openUsersList(page);

    const approvedRow = userRow(page, approvedEmail);
    await expect(approvedRow).toHaveAttribute("data-user-status", "pending");
    await approvedRow.getByRole("combobox", { name: "Group for Approved E2E User" }).selectOption(group.id);
    await approvedRow.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("User approved and added to the group.")).toBeVisible();
    await expect(approvedRow).toHaveAttribute("data-user-status", "active");
    await expect(approvedRow.getByText(group.name, { exact: true })).toBeVisible();
    await expect(approvedRow.getByRole("button", { name: "Approve" })).toHaveCount(0);

    const rejectedRow = userRow(page, rejectedEmail);
    await expect(rejectedRow).toHaveAttribute("data-user-status", "pending");
    await rejectedRow.getByRole("button", { name: "Reject" }).click();
    await confirmAdminDialog(page, "admin-confirm-reject-user", /confirm reject user/i);
    await expect(rejectedRow).toHaveAttribute("data-user-status", "denied");

    await page.getByRole("button", { name: "Sign-up rules" }).click();
    const rulesSheet = page.getByTestId("admin-signup-rules-sheet");
    await rulesSheet.getByLabel("Value").fill(ruleEmail);
    await rulesSheet.getByLabel(group.name).check();
    await rulesSheet.getByRole("button", { name: "Add rule" }).click();
    await expect(signupRule(rulesSheet, ruleEmail)).toContainText(`Email · ${group.name}`);
    await rulesSheet.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(rulesSheet).toHaveCount(0);

    await page.getByRole("button", { exact: true, name: "Invite" }).click();
    const inviteSheet = page.getByTestId("admin-invite-sheet");
    await inviteSheet.getByLabel("Email", { exact: true }).fill(inviteEmail);
    await inviteSheet.getByLabel(group.name).check();
    await expect(inviteSheet.getByRole("checkbox", { name: /Send invitation email/ })).toBeChecked();
    await inviteSheet.getByRole("button", { name: "Create invite" }).click();
    const inviteLink = inviteSheet.getByLabel("Invite link");
    await expect(inviteLink).toHaveValue(/\/login\?invite=/);
    await expect(inviteSheet.getByTestId("admin-invite-result")).toContainText("email sent");
    await expect(page.getByText("Invite created and email sent.")).toBeVisible();
    await expect
      .poll(async () => (await listAuthEmails(page.request)).filter((message) => message.to === inviteEmail).length)
      .toBe(1);
    const [inviteMessage] = (await listAuthEmails(page.request)).filter((message) => message.to === inviteEmail);
    expect(inviteMessage).toMatchObject({
      subject: "You're invited to AIQSA",
      to: inviteEmail
    });
    const inviteUrl = await inviteLink.inputValue();
    expect(inviteMessage?.text).toContain(inviteUrl);
    expect(inviteMessage?.text).not.toContain(group.name);
    await inviteSheet.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(inviteSheet).toHaveCount(0);
    const openInvites = page.getByTestId("admin-open-invites");
    const freshInviteRow = inviteRow(openInvites, inviteEmail);
    await expect(freshInviteRow).toContainText(`${group.name} · expires in`);
    await expect(freshInviteRow).toContainText("email sent");
    await expect(freshInviteRow.getByRole("button", { name: `Copy link for ${inviteEmail}` })).toBeVisible();

    const inviteContext = await browser.newContext();
    invitePage = await inviteContext.newPage();
    await invitePage.goto(inviteUrl);
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

    await page.getByRole("button", { exact: true, name: "Invite" }).click();
    const linkOnlySheet = page.getByTestId("admin-invite-sheet");
    await linkOnlySheet.getByLabel("Email", { exact: true }).fill(linkOnlyInviteEmail);
    await linkOnlySheet.getByRole("checkbox", { name: /Send invitation email/ }).uncheck();
    await linkOnlySheet.getByRole("button", { name: "Create invite" }).click();
    await expect(linkOnlySheet.getByTestId("admin-invite-result")).toContainText("no email sent");
    await expect(linkOnlySheet.getByLabel("Invite link")).toHaveValue(/\/login\?invite=/);
    expect((await listAuthEmails(page.request)).filter((message) => message.to === linkOnlyInviteEmail)).toHaveLength(0);
    await linkOnlySheet.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(linkOnlySheet).toHaveCount(0);
    await expect(inviteRow(openInvites, linkOnlyInviteEmail)).toContainText("no email sent");

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

    await openAdminSection(page, adminSection("groups"));
    const access = page.getByTestId("admin-section-groups");
    await access.getByLabel("Search groups").fill(group.name);
    await groupRow(access, group.name).getByRole("link").click();
    const groupDetail = access.getByTestId("admin-group-page");
    await groupDetail.getByRole("checkbox", { name: "Fake QSA" }).click();
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

    await openUsersList(page);
    await userRow(page, approvedEmail).getByRole("link", { name: "Open Approved E2E User" }).click();
    const activeUserDetail = page.getByTestId("admin-user-page");
    await expect(page).toHaveURL(/section=users&resource=/);
    await expect(activeUserDetail.getByText("Disable this user before deletion can be considered.")).toBeVisible();
    await expect(activeUserDetail.getByTestId("admin-user-groups")
      .getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await activeUserDetail.getByRole("button", { name: "Revoke sessions" }).click();
    await confirmAdminDialog(page, "admin-confirm-revoke-user-sessions", /confirm revoke sessions/i);
    await expect.poll(
      () => browserFetchStatus(userPage!, "/api/me"),
      { timeout: 15_000 }
    ).toBe(401);

    await loginWithPassword(userPage, approvedEmail, approvedPassword);
    await expect(userPage.getByTestId("app-shell")).toBeVisible();

    await activeUserDetail.getByRole("button", { exact: true, name: "Disable" }).click();
    await confirmAdminDialog(page, "admin-confirm-disable-user", /confirm disable user/i);
    await expect(activeUserDetail.getByText("Disabled", { exact: true })).toBeVisible();
    await expect(activeUserDetail.getByRole("button", { exact: true, name: "Disable" })).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByTestId("admin-section-overview")).toBeVisible();
    const sectionIndex = page.getByTestId("admin-section-index");
    await expect(sectionIndex.getByRole("link", { exact: true, name: "Overview" })).toHaveAttribute("aria-current", "page");
    await expect(sectionIndex.getByTestId("admin-nav-group-models")).toContainText("Models");
    await expect(sectionIndex.getByTestId("admin-nav-group-people")).toContainText("People");
    await expect(sectionIndex.getByTestId("admin-nav-group-platform")).toContainText("Platform");
    await expect(sectionIndex.getByRole("link")).toHaveCount(adminSections.length);
    await expect(page.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
    await expect(page.getByTestId("admin-topbar")).not.toContainText("operator@aiqsa.local");
    await expect(page.getByRole("link", { name: "Chats" }).first()).toHaveAttribute("href", "/");
    const attention = page.getByTestId("admin-section-overview");
    await expect(attention.getByRole("list", { name: "Needs attention" })).toBeVisible();
    await expect(attention.getByTestId("admin-attention-item").filter({ hasText: "Users are waiting for approval" })).toBeVisible();
    await expect(attention.getByTestId("admin-attention-item").filter({ hasText: "Email delivery is not configured" })).toBeVisible();
    await expect(attention.getByText(/When the list is empty, everything is working/)).toBeVisible();
    await attention.getByRole("button", { name: /^Review users:/ }).click();
    await expect(page.getByTestId("admin-section-users")).toBeVisible();
    await expect(page).toHaveURL(/section=users&filter=pending$/);
    await expect(page.getByRole("button", { name: /^Pending · \d+$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(userRow(page, staleUserEmail)).toHaveAttribute("data-user-status", "pending");
    await page.getByRole("button", { name: /^All · \d+$/ }).click();
    await expect(page).toHaveURL(/section=users$/);

    for (const section of adminSections) {
      await openAdminSection(page, section);
      await expectNoPageOverflow(page);
    }

    await page.setViewportSize({ height: 500, width: 1_440 });
    await page.goto("/admin?section=search");
    const searchSection = page.getByTestId("admin-section-search");
    const searchCatalog = searchSection.getByRole("list", { name: "Search sources" });
    await expect(searchCatalog).toBeVisible();
    await searchCatalog.getByRole("link").first().click();
    const searchPage = searchSection.getByTestId("search-source-page");
    await expect(searchPage.getByRole("region", { name: "Check", exact: true })).toBeVisible();
    await expect(searchPage.getByRole("region", { name: "Details", exact: true })).toBeVisible();
    await expect(searchPage.getByText("Chat models", { exact: true })).toBeVisible();
    await expect(searchPage.getByTestId("search-source-page-status")).toBeVisible();
    await expectNoPageOverflow(page);
    await page.setViewportSize({ height: 900, width: 1_440 });

    await page.goto("/admin");
    await expect(page.getByTestId("admin-section-overview")).toBeVisible();
    await openAdminSection(page, adminSection("usage"));
    await openAdminSection(page, adminSection("groups"));
    await page.goBack();
    await expect(page.getByTestId("admin-section-usage")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("admin-section-overview")).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId("admin-section-usage")).toBeVisible();

    for (const [legacy, current] of [
      ["system-models", "roles"],
      ["access", "groups"],
      ["invites", "users"],
      ["access-rules", "users"],
      ["safety", "users"],
      ["knowledge", "retrieval"],
      ["memory", "retrieval"]
    ] as const) {
      await page.goto(`/admin?section=${legacy}`);
      await expect(page.getByTestId(`admin-section-${current}`)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`section=${current}$`));
    }

    for (const section of adminSections) {
      const path = section.id === "overview" ? "/admin" : `/admin?section=${section.id}`;
      await page.goto(path);
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
      await page.reload();
      await expect(page.getByTestId(`admin-section-${section.id}`)).toBeVisible();
    }

    await page.goto("/admin?section=not-a-real-section");
    await expect(page.getByTestId("admin-section-overview")).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto("/admin?section=groups");
    await expect(page.getByTestId("admin-section-groups")).toBeVisible();
    const access = page.getByTestId("admin-section-groups");
    await page.getByRole("button", { name: "New group" }).click();
    const nameSheet = page.getByTestId("admin-group-name-sheet");
    await nameSheet.getByLabel("Group name").fill(groupName);
    await nameSheet.getByRole("button", { name: "Create" }).click();
    const groupDetail = access.getByTestId("admin-group-page");
    await expect(groupDetail.getByRole("heading", { name: groupName })).toBeVisible();
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

    await groupDetail.getByRole("button", { name: "Rename" }).click();
    const renameSheet = page.getByTestId("admin-group-name-sheet");
    await renameSheet.getByLabel("Group name").fill(renamedGroupName);
    await renameSheet.getByRole("button", { name: "Save" }).click();
    await expect(renameSheet).toHaveCount(0);
    await expect(groupDetail.getByRole("heading", { name: renamedGroupName })).toBeVisible();

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

    await groupDetail.getByRole("switch", { name: `Anthropic Search for ${renamedGroupName}` }).click();
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

    await groupDetail.getByRole("button", { name: `Revoke all Fake QSA models from ${renamedGroupName}` }).click();
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

    await groupDetail.getByRole("switch", { name: "All Fake QSA models, including ones added later" }).click();
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
    await expect(groupDetail.getByRole("button", { name: `Grant all Fake QSA models to ${renamedGroupName}` })).toHaveCount(0);

    await openUsersList(page);
    await page.getByRole("button", { name: "Sign-up rules" }).click();
    const rulesSheet = page.getByTestId("admin-signup-rules-sheet");
    await rulesSheet.getByLabel("Kind").selectOption("domain");
    await rulesSheet.getByLabel("Value").fill(` ${domain.toUpperCase()} `);
    await expect(rulesSheet.getByTestId("admin-signup-rule-preview")).toContainText(domain);
    await rulesSheet.getByLabel(renamedGroupName).check();
    await rulesSheet.getByRole("button", { name: "Add rule" }).click();
    await expect(signupRule(rulesSheet, domain)).toContainText(`Domain · ${renamedGroupName}`);
    await expect(rulesSheet.getByLabel("Value")).toHaveValue("");
    await rulesSheet.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(rulesSheet).toHaveCount(0);

    await page.getByRole("button", { exact: true, name: "Invite" }).click();
    const inviteSheet = page.getByTestId("admin-invite-sheet");
    await inviteSheet.getByLabel("Email", { exact: true }).fill(inviteEmail);
    await inviteSheet.getByLabel(renamedGroupName).check();
    await inviteSheet.getByRole("button", { name: "Create invite" }).click();
    await expect(inviteSheet.getByLabel("Invite link")).toHaveValue(/\/login\?invite=/);
    await inviteSheet.getByRole("button", { exact: true, name: "Copy" }).click();
    await expect(inviteSheet.getByRole("button", { name: "Copied" })).toBeVisible();
    await inviteSheet.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(inviteSheet).toHaveCount(0);
    const openInvites = page.getByTestId("admin-open-invites");
    const createdInviteRow = inviteRow(openInvites, inviteEmail);
    await expect(createdInviteRow).toContainText(renamedGroupName);
    await createdInviteRow.getByRole("button", { name: `Copy link for ${inviteEmail}` }).click();
    await expect(createdInviteRow.getByRole("button", { name: `Copy link for ${inviteEmail}` })).toHaveText("Copied");
    await createdInviteRow.getByRole("button", { name: `More actions for ${inviteEmail}` }).click();
    await page.getByRole("menuitem", { name: "Revoke" }).click();
    await confirmAdminDialog(page, "admin-confirm-revoke-invite", /confirm revoke invite/i);
    await expect(createdInviteRow).toHaveCount(0);
    await openInvites.getByRole("button", { exact: true, name: "Show" }).click();
    const revokedInviteRow = inviteRow(openInvites, inviteEmail);
    await expect(revokedInviteRow).toContainText("revoked");
    await expect(revokedInviteRow.getByRole("button", { name: /Copy link/ })).toHaveCount(0);
    await revokedInviteRow.getByRole("button", { name: `More actions for ${inviteEmail}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-invite", /confirm delete invite/i);
    await expect(revokedInviteRow).toHaveCount(0);

    const users = page.getByTestId("admin-section-users");
    const search = users.getByRole("searchbox", { name: "Search users" });
    await search.fill("operator@aiqsa.local");
    const selfRow = userRow(page, "operator@aiqsa.local");
    await expect(selfRow).toBeVisible();
    await expect(selfRow).toContainText("you · admin");
    await selfRow.getByRole("link", { name: /^Open / }).click();
    const selfPage = page.getByTestId("admin-user-page");
    await expect(selfPage.getByText(/Self-disable and self-delete are not exposed/)).toBeVisible();
    await expect(selfPage.getByRole("button", { name: "Delete stale" })).toHaveCount(0);
    await expect(selfPage.getByRole("button", { exact: true, name: "Disable" })).toHaveCount(0);
    await usersCrumb(page).click();
    await expect(search).toHaveValue("operator@aiqsa.local");

    await search.fill(staleUserEmail);
    const staleUserRow = userRow(page, staleUserEmail);
    await expect(staleUserRow).toBeVisible();
    await staleUserRow.getByRole("link", { name: /^Open / }).click();
    await page.getByTestId("admin-user-page").getByRole("button", { name: "Delete stale" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-user", /confirm delete user/i);
    await expect(page.getByTestId("admin-users-index")).toBeVisible();
    await expect(page).toHaveURL(/section=users$/);
    await expect(staleUserRow).toHaveCount(0);

    await page.getByRole("button", { name: "Sign-up rules" }).click();
    const rulesSheetAgain = page.getByTestId("admin-signup-rules-sheet");
    await rulesSheetAgain.getByRole("button", { name: `Delete rule ${domain}` }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-access-rule", /confirm delete rule/i);
    await expect(signupRule(rulesSheetAgain, domain)).toHaveCount(0);
    await expect(rulesSheetAgain.getByLabel("Value")).toBeFocused();
    await rulesSheetAgain.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(rulesSheetAgain).toHaveCount(0);

    await openAdminSection(page, adminSection("groups"));
    const accessAfterDelete = page.getByTestId("admin-section-groups");
    const groupsCrumb = page.getByTestId("admin-topbar-title").getByRole("link", { name: "Groups" });
    await accessAfterDelete.getByLabel("Search groups").fill(renamedGroupName);
    const renamedGroupRow = groupRow(accessAfterDelete, renamedGroupName);
    await expect(renamedGroupRow).toBeVisible();
    await renamedGroupRow.getByRole("link").click();
    const blockedGroupDetail = accessAfterDelete.getByTestId("admin-group-page");
    await expect(blockedGroupDetail.getByText(/Remove [0-9]+ active grants? before deleting this group\./)).toBeVisible();
    await page.getByRole("button", { name: `More actions for ${renamedGroupName}` }).click();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await groupsCrumb.click();

    await accessAfterDelete.getByLabel("Search groups").fill(emptyGroupName);
    const emptyGroupRow = groupRow(accessAfterDelete, emptyGroupName);
    await expect(emptyGroupRow).toBeVisible();
    await emptyGroupRow.getByRole("link").click();
    await expect(accessAfterDelete.getByTestId("admin-group-page")).toBeVisible();
    await page.getByRole("button", { name: `More actions for ${emptyGroupName}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await confirmAdminDialog(page, "admin-confirm-delete-group", /confirm delete group/i);
    await expect(accessAfterDelete.getByTestId("admin-groups-index")).toBeVisible();
    await expect(emptyGroupRow).toHaveCount(0);
    emptyGroupId = null;

    await accessAfterDelete.getByLabel("Search groups").fill(renamedGroupName);
    await expect(renamedGroupRow).toBeVisible();
    await renamedGroupRow.getByRole("link").click();
    const groupToArchiveDetail = accessAfterDelete.getByTestId("admin-group-page");
    await page.getByRole("button", { name: `More actions for ${renamedGroupName}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await confirmAdminDialog(page, "admin-confirm-archive-group", /confirm archive group/i);
    await expect(groupToArchiveDetail.getByText(/This group is archived/)).toBeVisible();
    await expect(groupToArchiveDetail.getByRole("switch", { name: "All Fake QSA models, including ones added later" })).toBeDisabled();
    await groupsCrumb.click();
    await expect(groupRow(accessAfterDelete, renamedGroupName)).toHaveCount(0);
    await accessAfterDelete.getByRole("button", { name: /^Archived · / }).click();
    await expect(groupRow(accessAfterDelete, renamedGroupName)).toBeVisible();
    await expect(groupRow(accessAfterDelete, renamedGroupName).getByText("Archived · grants no longer apply", { exact: true })).toBeVisible();

    await page.setViewportSize({
      height: 844,
      width: 390
    });
    await page.goto("/admin?section=users");
    await expect(page.getByTestId("admin-section-users")).toBeVisible();
    await expectNoPageOverflow(page);

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Revoke all sessions" }).click();
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
        .toBe(section.id === "overview" ? null : section.id);
      await expectNoPageOverflow(page);
    }

    await openUsersList(page);
    const users = page.getByTestId("admin-section-users");
    const search = users.getByRole("searchbox", { name: "Search users" });
    await expectTouchTarget(search);
    await expectTouchTarget(users.getByRole("button", { name: /^All · \d+$/ }));

    await search.fill("operator@aiqsa.local");
    const operatorRow = userRow(page, "operator@aiqsa.local");
    await operatorRow.scrollIntoViewIfNeeded();
    await expectTouchTarget(operatorRow);
    await operatorRow.getByRole("link", { name: /^Open / }).click();
    const selectedPage = page.getByTestId("admin-user-page");
    await expect(selectedPage).toContainText("you");
    await expectNoPageOverflow(page);
    await usersCrumb(page).click();
    await expect(search).toHaveValue("operator@aiqsa.local");
    await expect(operatorRow).toBeVisible();

    await openAdminSection(page, adminSection("groups"));
    const access = page.getByTestId("admin-section-groups");
    const accessGroupSearch = access.getByLabel("Search groups");
    await accessGroupSearch.fill(compactGroupName);
    const newGroup = page.getByRole("button", { exact: true, name: "New group" });
    await expectTouchTarget(newGroup);
    await newGroup.click();
    const groupNameSheet = page.getByTestId("admin-group-name-sheet");
    await expectTouchTarget(groupNameSheet.getByLabel("Group name"));
    await expectTouchTarget(groupNameSheet.getByRole("button", { exact: true, name: "Create" }));
    await expectNoPageOverflow(page);
    await groupNameSheet.getByRole("button", { exact: true, name: "Cancel" }).click();
    await expect(groupNameSheet).toHaveCount(0);
    await expect(accessGroupSearch).toHaveValue(compactGroupName);
    const accessGroupRow = groupRow(access, compactGroupName);
    await expectTouchTarget(accessGroupRow);
    await accessGroupRow.scrollIntoViewIfNeeded();
    await accessGroupRow.getByRole("link").click();
    const accessDetail = access.getByTestId("admin-group-page");
    await expect(accessDetail).toBeVisible();
    await expectTouchTarget(accessDetail.getByRole("switch").first());
    await expectTouchTarget(accessDetail.getByRole("button", { name: "Add a person" }));
    await expectNoPageOverflow(page);
    const groupsCrumbLink = page.getByTestId("admin-topbar-title").getByRole("link", { name: "Groups" });
    await groupsCrumbLink.click();
    await expect(accessGroupSearch).toHaveValue(compactGroupName);
    await expect(accessGroupRow).toBeVisible();

    await openUsersList(page);
    const invite = page.getByRole("button", { exact: true, name: "Invite" });
    await expectTouchTarget(invite);
    await invite.click();
    const inviteSheet = page.getByTestId("admin-invite-sheet");
    await expect(inviteSheet.getByRole("button", { name: "Close" })).toBeFocused();
    await expectTouchTarget(inviteSheet.getByLabel("Email", { exact: true }));
    await expectTouchTarget(inviteSheet.getByRole("button", { exact: true, name: "Create invite" }));
    await expectTouchTarget(inviteSheet.getByLabel(compactGroupName).locator(".."));
    await expectNoPageOverflow(page);
    for (const viewport of [
      { height: 768, width: 1024 },
      { height: 500, width: 1280 },
      { height: 900, width: 1440 }
    ]) {
      await page.setViewportSize(viewport);
      await expectNoPageOverflow(page);
      await expectContainedInViewport(page, inviteSheet.getByRole("dialog"));
    }
    await page.setViewportSize({ height: 844, width: 390 });
    await inviteSheet.getByRole("button", { exact: true, name: "Cancel" }).click();
    await expect(inviteSheet).toHaveCount(0);
    await expect(invite).toBeFocused();

    const signupRules = page.getByRole("button", { exact: true, name: "Sign-up rules" });
    await expectTouchTarget(signupRules);
    await signupRules.click();
    const rulesSheet = page.getByTestId("admin-signup-rules-sheet");
    await expect(rulesSheet.getByRole("button", { name: "Close" })).toBeFocused();
    await expectTouchTarget(rulesSheet.getByLabel("Kind"));
    await expectTouchTarget(rulesSheet.getByLabel("Value"));
    await expectTouchTarget(rulesSheet.getByRole("button", { exact: true, name: "Add rule" }));
    await expectTouchTarget(rulesSheet.getByLabel(compactGroupName).locator(".."));
    await expectNoPageOverflow(page);
    for (const viewport of [
      { height: 768, width: 1024 },
      { height: 500, width: 1280 },
      { height: 900, width: 1440 }
    ]) {
      await page.setViewportSize(viewport);
      await expectNoPageOverflow(page);
      await expectContainedInViewport(page, rulesSheet.getByRole("dialog"));
    }
    await page.setViewportSize({ height: 844, width: 390 });
    await page.keyboard.press("Escape");
    await expect(rulesSheet).toHaveCount(0);
    await expect(signupRules).toBeFocused();

    const moreActions = page.getByRole("button", { exact: true, name: "More actions" });
    await expectTouchTarget(moreActions);
    await moreActions.click();
    const revokeAll = page.getByRole("menuitem", { exact: true, name: "Revoke all sessions" });
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

    await openUsersList(page);
    const users = page.getByTestId("admin-section-users");
    await users.getByRole("searchbox", { name: "Search users" }).fill("definitely-no-matching-user");
    const emptyState = users.getByTestId("admin-users-list").getByRole("status");
    await expect(emptyState).toContainText(/No users match this view/);
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
    await expect(page.getByRole("heading", { exact: true, name: "Users" })).toBeInViewport();
    await expect(users.getByRole("searchbox", { name: "Search users" })).toBeInViewport();
    await expect(page.getByTestId("admin-section-column")).toBeHidden();

    await page.getByRole("button", { name: "Sections" }).click();
    const drawer = page.getByRole("dialog", { name: "Control Center sections" });
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("admin-drawer-scrim")).toBeVisible();
    await expect
      .poll(() => page.getByTestId("admin-section-scroll").evaluate((element) => getComputedStyle(element).overflowY))
      .toBe("auto");
    await expect(page.getByRole("link", { exact: true, name: "Providers" })).toBeInViewport();

    await page.goBack();
    await expect(users).toBeVisible();
    await expect(page.getByTestId("admin-section-column")).toBeHidden();
    await page.goForward();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("admin-section-column")).toBeHidden();
    await page.getByRole("button", { name: "Sections" }).click();
    await expect(drawer).toBeVisible();
    await page.getByRole("button", { name: "Close sections" }).click();
    await expect(users).toBeVisible();
    await expect(page.getByTestId("admin-section-column")).toBeHidden();

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
    await expect(page.getByTestId("admin-section-column")).toBeHidden();
    await expect(page.getByTestId("admin-rail")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sections" })).toBeVisible();

    await page.getByRole("button", { name: "Sections" }).click();
    await expect(page.getByRole("dialog", { name: "Control Center sections" })).toBeVisible();
    await expect(page.getByRole("link", { exact: true, name: "Providers" })).toBeVisible();
    await expect(page.getByRole("link", { exact: true, name: "Usage" })).toBeVisible();

    const drawer = page.getByRole("dialog", { name: "Control Center sections" });
    for (let index = 0; index < 15; index += 1) {
      await page.keyboard.press("Tab");
      await expect.poll(() => drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("button", { name: "Sections" })).toBeFocused();
    await page.getByRole("button", { name: "Sections" }).click();

    await page.getByRole("link", { exact: true, name: "Usage" }).click();
    await expect(page.getByTestId("admin-section-column")).toBeHidden();
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

test("Control Center role labels and pickers fit the available viewport", async ({ page }) => {
  await bootstrapAdmin(page);
  const response = await page.request.get("/api/admin/providers/system-model-policy");
  expect(response.ok()).toBe(true);
  const { systemModelPolicy }: AdminSystemModelPolicyResponse = await response.json();
  const ready: AdminSystemModelCandidate = {
    connectionDisplayName: "Research gateway for document processing",
    connectionId: "geometry-provider",
    defaultReasoningEffort: null,
    displayName: "Research assistant with reasoning and long context",
    forcedToolCall: "verified",
    id: "geometry-ready",
    reasoningEfforts: [],
    structuredOutput: "verified"
  };
  const unchecked: AdminSystemModelCandidate = {
    ...ready,
    displayName: "New research model with a long deployment name",
    forcedToolCall: "not_verified",
    id: "geometry-unchecked",
    structuredOutput: "not_verified"
  };
  systemModelPolicy.candidates = [ready];
  systemModelPolicy.verificationCandidates = [ready, unchecked];
  systemModelPolicy.ineligible.memory = [
    { ...unchecked, reason: "not_checked" },
    { ...ready, displayName: "Disabled research deployment", id: "geometry-disabled", reason: "model_disabled" }
  ];
  systemModelPolicy.policy = {
    ...systemModelPolicy.policy,
    reasoningEffort: null,
    systemModel: { ...ready, available: true }
  };
  await page.route("**/api/admin/providers/system-model-policy", (route) => route.fulfill({
    json: { systemModelPolicy }
  }));
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 844, height: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/admin?section=roles");
    const role = page.getByTestId("admin-role-memory");
    const label = role.getByText("System model", { exact: true });
    await expect(label).toBeVisible();
    expect((await label.boundingBox())!.width).toBeGreaterThanOrEqual(140);
    const opener = page.getByTestId("admin-memory-picker");
    await opener.click();
    const picker = page.getByRole("dialog", { name: "System model deployment" });
    await expect(picker).toBeVisible();
    await expect.poll(async () => {
      const box = await picker.boundingBox();
      return Boolean(box && box.x >= 0 && box.y >= 0 &&
        box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
    }).toBe(true);
    await expect(picker.getByRole("button", {
      name: `Check ${unchecked.connectionDisplayName} / ${unchecked.displayName}`
    })).toBeVisible();
    await expect.poll(() => picker.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth + 1 &&
        Array.from(element.querySelectorAll("button, [role=option]")).every((control) => {
          const box = control.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right;
        });
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(opener).toBeFocused();
    await expectNoPageOverflow(page);
  }
});
