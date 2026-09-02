import { randomUUID } from "node:crypto";
import { ModelRunStatus, Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import {
  LOCAL_MCP_MEMBER,
  LOCAL_RESTRICTED_MEMBER
} from "../../prisma/local-seed-fixtures";

const prisma = new PrismaClient();

test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);
test.use({ trace: "off" });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function loginWithPassword(
  page: Page,
  user: Readonly<{ email: string; password: string }>
): Promise<void> {
  await page.addInitScript(() => window.localStorage.removeItem("aiqsa.activeChatId"));
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
}

function sharedProjects(page: Page) {
  return page.locator('section[aria-label="Shared projects"]');
}

function projectRow(page: Page, projectName: string) {
  return sharedProjects(page).locator(".v2-project-row").filter({ hasText: projectName });
}

function projectChatRow(page: Page, chatTitle: string) {
  return sharedProjects(page).locator(".v2-project-chat-row").filter({ hasText: chatTitle });
}

async function warmProjectRouteModules(page: Page): Promise<void> {
  // Next dev otherwise cold-compiles every Project route concurrently when
  // the first workspace opens. Sequential privacy-neutral 404s keep this
  // browser smoke focused on realtime behavior instead of compiler pressure.
  const projectId = "00000000-0000-4000-8000-000000000099";
  const paths = [
    `/api/projects/${projectId}`,
    `/api/projects/${projectId}/chats`,
    `/api/projects/${projectId}/memory`,
    `/api/projects/${projectId}/activity`,
    `/api/projects/${projectId}/candidates?limit=20&q=warm&type=user`,
    `/api/projects/${projectId}/grants`,
    `/api/projects/${projectId}/grants/00000000-0000-4000-8000-000000000098?expectedAccessRevision=0`,
    `/api/projects/${projectId}/events`
  ];
  for (const path of paths) {
    expect((await page.request.get(path)).status()).toBe(404);
  }
}

async function createProjectThroughUi(page: Page, projectName: string): Promise<string> {
  await sharedProjects(page).getByRole("button", { name: "Create project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create project" });
  await dialog.getByLabel("Name", { exact: true }).fill(projectName);
  await dialog.getByLabel("Description").fill("Two members sharing one live Project workspace.");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(dialog).toBeHidden();
  await expect(projectRow(page, projectName)).toHaveAttribute("aria-current", "page");

  await expect.poll(async () => (
    await prisma.project.findFirst({ select: { id: true }, where: { name: projectName } })
  )?.id ?? null).not.toBeNull();
  return (await prisma.project.findFirstOrThrow({
    select: { id: true },
    where: { name: projectName }
  })).id;
}

async function addContributorThroughPicker(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Open ${projectName} details` }).first().click();
  const settings = page.getByRole("dialog", { name: `${projectName} settings` });
  await settings.getByRole("button", { name: "Members", exact: true }).dispatchEvent("click");
  await settings.getByLabel("Search people").fill(LOCAL_RESTRICTED_MEMBER.email);
  const candidate = settings.getByRole("option", {
    name: new RegExp(LOCAL_RESTRICTED_MEMBER.displayName, "u")
  });
  await expect(candidate).toBeVisible({ timeout: 30_000 });
  await candidate.click();
  await settings.getByLabel("Project role").selectOption("CONTRIBUTOR");
  await settings.getByRole("button", { name: "Add access", exact: true }).click();
  const confirmation = settings.getByRole("alertdialog", { name: "Confirm Project access" });
  await expect(confirmation).toContainText(LOCAL_RESTRICTED_MEMBER.displayName);
  await confirmation.getByRole("button", { name: "Add access" }).click();
  await expect(confirmation).toBeHidden();
  await expect(settings.locator(".v2-project-list-row").filter({
    hasText: LOCAL_RESTRICTED_MEMBER.email
  })).toBeVisible();
  await settings.getByRole("button", { name: "Close project settings" }).click();
  await expect(settings).toBeHidden();
}

async function openBlankProject(page: Page, projectName: string): Promise<void> {
  await expect(projectRow(page, projectName)).toBeVisible({ timeout: 30_000 });
  await projectRow(page, projectName).click();
  await expect(page.getByTestId("project-blank-orientation")).toContainText(projectName);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
}

async function injectSafePersistedOutputs(
  projectId: string,
  privateMarker: string
): Promise<void> {
  let runId = "";
  await expect.poll(async () => {
    const run = await prisma.modelRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { id: true },
      where: { chat: { projectId } }
    });
    runId = run?.id ?? "";
    return runId;
  }).not.toBe("");

  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ status: ModelRunStatus }>>(Prisma.sql`
      SELECT "status" FROM "ModelRun" WHERE "id" = ${runId} FOR UPDATE
    `);
    const run = rows[0];
    if (!run) throw new Error("project_run_fixture_missing");
    const latest = await tx.modelRunEvent.aggregate({
      _max: { sequence: true },
      where: { modelRunId: runId }
    });
    const firstSequence = (latest._max.sequence ?? -1) + 1;
    await tx.modelRunEvent.createMany({
      data: [
        {
          eventType: "artifact",
          modelRunId: runId,
          payload: {
            artifactType: "search",
            payload: {
              action: {
                sources: [{
                  rank: 1,
                  snippet: "Deterministic shared evidence with no provider-private metadata.",
                  title: "Project Search fixture",
                  url: "https://example.com/aiqsa-project-source"
                }]
              }
            }
          },
          sequence: firstSequence
        },
        {
          eventType: "artifact",
          modelRunId: runId,
          payload: {
            artifactType: "citation",
            payload: {
              index: 1,
              source: "Project Search",
              title: "Project Search fixture",
              url: "https://example.com/aiqsa-project-source"
            }
          },
          sequence: firstSequence + 1
        }
      ]
    });
    const now = new Date();
    await tx.modelRunToolCall.create({
      data: {
        arguments: { privateMarker },
        completedAt: now,
        modelRunId: runId,
        ordinal: 0,
        providerCallId: `fixture-${randomUUID()}`,
        result: { safe: true },
        roundIndex: 1,
        startedAt: new Date(now.getTime() - 25),
        state: "complete",
        toolName: "mcp_private_fixture_tool"
      }
    });
    // A same-value status write emits the ordinary durable Project run
    // invalidation. The test never calls a private browser-only fixture route.
    await tx.modelRun.update({ data: { status: run.status }, where: { id: runId } });
  });
}

async function revokeContributorThroughUi(page: Page, projectName: string): Promise<void> {
  await page.getByRole("button", { name: `Open ${projectName} details` }).first().click();
  const settings = page.getByRole("dialog", { name: `${projectName} settings` });
  await settings.getByRole("button", { name: "Members", exact: true }).dispatchEvent("click");
  const memberRow = settings.locator(".v2-project-list-row").filter({
    hasText: LOCAL_RESTRICTED_MEMBER.email
  });
  await memberRow.getByRole("button", { name: "Remove access" }).click();
  const confirmation = settings.getByRole("alertdialog", {
    name: "Confirm Project access removal"
  });
  await expect(confirmation).toContainText("1 active person loses Project access");
  await confirmation.getByRole("button", { name: "Remove access" }).click();
  await expect(memberRow).toHaveCount(0);
}

test("keeps two Project members at the same live shared desk", async ({ browser }) => {
  const id = randomUUID();
  const projectName = `Shared desk ${id}`;
  const promptHead = `shared-desk-${id}`;
  const promptTail = `shared-desk-complete-${id}`;
  const sameClientFollowUp = `owner-same-client-follow-up-${id}`;
  const followUp = `contributor-follow-up-${id}`;
  const privateMarker = `private-tool-argument-${id}`;
  const longPrompt = [
    promptHead,
    ...Array.from({ length: 100 }, (_, index) => `checkpoint-${index}`),
    promptTail
  ].join(" ");
  const contextOptions = {
    permissions: ["clipboard-read", "clipboard-write"],
    reducedMotion: "reduce" as const,
    viewport: { height: 900, width: 1440 }
  };
  let ownerContext = await browser.newContext(contextOptions);
  const contributorContext = await browser.newContext(contextOptions);
  let ownerPage = await ownerContext.newPage();
  const contributorPage = await contributorContext.newPage();
  let projectId: string | null = null;

  try {
    await loginWithPassword(ownerPage, LOCAL_MCP_MEMBER);
    await warmProjectRouteModules(ownerPage);

    projectId = await createProjectThroughUi(ownerPage, projectName);
    await expect(prisma.chat.count({ where: { projectId } })).resolves.toBe(0);
    await addContributorThroughPicker(ownerPage, projectName);
    await loginWithPassword(contributorPage, LOCAL_RESTRICTED_MEMBER);

    await contributorPage.bringToFront();
    await contributorPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await openBlankProject(contributorPage, projectName);
    await ownerPage.bringToFront();
    await expect(ownerPage.getByTestId("project-blank-orientation")).toContainText(projectName);
    await expect(ownerPage.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(prisma.chat.count({ where: { projectId } })).resolves.toBe(0);

    await ownerPage.getByRole("textbox", { name: "Message" }).fill(longPrompt);
    await ownerPage.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect(ownerPage.getByRole("button", { name: "Stop answer" }))
      .toBeVisible({ timeout: 10_000 });
    await expect.poll(() => prisma.chat.count({ where: { projectId } })).toBe(1);

    await expect(projectChatRow(contributorPage, promptHead)).toBeVisible({ timeout: 8_000 });
    await projectChatRow(contributorPage, promptHead).click();
    await expect(contributorPage.getByRole("complementary", { name: "Shared project context" }))
      .toBeVisible();
    const ownerQuestion = contributorPage.getByRole("article", {
      name: `Question from ${LOCAL_MCP_MEMBER.displayName}`
    });
    await expect(ownerQuestion).toContainText(promptHead, { timeout: 8_000 });
    await expect(contributorPage.locator('article[data-role="assistant"]').last())
      .toContainText("Fake answer:", { timeout: 8_000 });

    await injectSafePersistedOutputs(projectId, privateMarker);
    const toolActivity = contributorPage.getByTestId("tool-activity-disclosure").last();
    await expect(toolActivity).toBeVisible({ timeout: 8_000 });
    await toolActivity.locator("summary").click();
    await expect(toolActivity).toContainText("MCP tool");
    // Signal tool rows name the settled call ("Ran <tool>") with its duration
    // instead of a separate "Completed" status label.
    await expect(toolActivity).toContainText("Ran MCP tool");
    await expect(contributorPage.getByText(privateMarker, { exact: false })).toHaveCount(0);

    const contributorAnswer = contributorPage.locator('article[data-role="assistant"]').last();
    await expect(contributorAnswer).toContainText(promptTail, { timeout: 25_000 });
    await expect(projectChatRow(contributorPage, promptHead).getByLabel("Answer in progress"))
      .toHaveCount(0, { timeout: 8_000 });
    const sourcesToggle = contributorPage.getByTestId("answer-sources-toggle").last();
    await expect(sourcesToggle).toBeVisible();
    await sourcesToggle.click();
    const sources = contributorPage.getByTestId("answer-sources").last();
    await expect(sources.getByRole("link", { name: "Project Search fixture" }).first()).toBeVisible();

    // Continue from the exact client state that admitted the draft chat. No
    // workspace refresh or Project re-selection is allowed between the two
    // sends; terminal run streaming alone must clear the draft admission.
    await ownerPage.bringToFront();
    await ownerPage.getByRole("textbox", { name: "Message" }).fill(sameClientFollowUp);
    await ownerPage.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect(ownerPage.locator('article[data-role="assistant"]').last())
      .toContainText(`Fake answer: ${sameClientFollowUp}`, { timeout: 15_000 });
    await expect(ownerPage.getByRole("button", { name: "Stop answer" }))
      .toHaveCount(0, { timeout: 15_000 });

    await contributorPage.bringToFront();
    await expect(contributorPage.locator('article[data-role="assistant"]').last())
      .toContainText(`Fake answer: ${sameClientFollowUp}`, { timeout: 8_000 });
    await contributorPage.getByRole("textbox", { name: "Message" }).fill(followUp);
    await contributorPage.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect(ownerPage.getByRole("article", {
      name: `Question from ${LOCAL_RESTRICTED_MEMBER.displayName}`
    })).toContainText(followUp, { timeout: 8_000 });
    await expect(ownerPage.locator('article[data-role="assistant"]').last())
      .toContainText(`Fake answer: ${followUp}`, { timeout: 15_000 });

    await ownerPage.getByRole("button", { name: "Chat actions" }).click();
    await ownerPage.getByRole("menuitem", { name: "Copy link to chat" }).click();
    await expect(ownerPage.getByText("Project chat link copied.")).toBeVisible();
    const copiedLink = await ownerPage.evaluate(() => navigator.clipboard.readText());
    expect(copiedLink).toContain(`project=${projectId}`);
    expect(copiedLink).toMatch(/chat=[0-9a-f-]+/u);

    // Keep the smoke bounded to its two named users: discard the owner's old
    // browser state before proving that the copied destination works from a
    // genuinely clean session. The fresh owner session can also perform the
    // final grant revoke without a third concurrent browser context.
    await ownerContext.close();
    ownerContext = await browser.newContext(contextOptions);
    ownerPage = await ownerContext.newPage();
    await loginWithPassword(ownerPage, LOCAL_MCP_MEMBER);
    await ownerPage.goto(copiedLink);
    await expect(ownerPage.getByRole("complementary", { name: "Shared project context" }))
      .toContainText(projectName, { timeout: 12_000 });
    await expect(ownerPage.getByRole("article", {
      name: `Question from ${LOCAL_RESTRICTED_MEMBER.displayName}`
    })).toContainText(followUp, { timeout: 20_000 });

    await revokeContributorThroughUi(ownerPage, projectName);
    await expect(contributorPage.getByText(
      "Project access changed. The shared workspace was closed."
    )).toBeVisible({ timeout: 8_000 });
    await expect(contributorPage.getByRole("complementary", { name: "Shared project context" }))
      .toHaveCount(0);
    await expect(projectRow(contributorPage, projectName)).toHaveCount(0);
    const unavailable = await contributorPage.request.get(`/api/projects/${projectId}`);
    expect(unavailable.status()).toBe(404);
  } finally {
    if (projectId) {
      await ownerPage.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
    }
    await ownerContext.close();
    await contributorContext.close();
  }
});
