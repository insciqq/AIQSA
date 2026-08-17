import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import {
  LOCAL_MCP_MEMBER,
  LOCAL_RESTRICTED_MEMBER
} from "../../prisma/local-seed-fixtures";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

type ProjectDetail = {
  accessRevision: number;
  defaults: {
    assistantId: string | null;
    controlValues: Record<string, boolean | string>;
    knowledgePlan: { baseIds: string[] };
    mcpMode: "auto" | "load_all" | "off";
    providerModelId: string | null;
    searchPlan: { mode: "all_selected" | "ordered_fallback"; optionIds: string[] };
  };
  id: string;
  policyRevision: number;
};

type ProjectResponse = { project: ProjectDetail };
type ProjectChatResponse = { chat: { id: string; title: string } };

async function responseJson<T>(response: APIResponse, status: number): Promise<T> {
  const body = await response.json() as T;
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

async function loginWithPassword(
  page: Page,
  user: Readonly<{ email: string; password: string }>
): Promise<void> {
  await page.addInitScript(() => window.localStorage.removeItem("aiqsa.activeChatId"));
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
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

async function openProjectChat(page: Page, projectName: string, chatTitle: string): Promise<void> {
  await expect(page.locator(".v2-workspace-shell"))
    .toHaveAttribute("data-sidebar-composition", "desktop");
  await expect(page.getByRole("complementary", { name: "Chat navigation" })).toBeVisible();
  await expect(sharedProjects(page)).toBeVisible();
  await expect(projectRow(page, projectName)).toBeVisible({ timeout: 12_000 });
  await projectRow(page, projectName).click();
  await expect(projectChatRow(page, chatTitle)).toBeVisible({ timeout: 12_000 });
  await projectChatRow(page, chatTitle).click();
  await expect(page.getByRole("complementary", { name: "Shared project context" })).toBeVisible();
  await expect(page.getByText("Shared with all project members · Personal Memory is off")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
}

test("keeps two project members at the same live shared desk", async ({ browser }) => {
  const id = randomUUID();
  const projectName = `Shared desk ${id}`;
  const chatTitle = `Collaborative stream ${id}`;
  const discoveredChatTitle = `Discovered live ${id}`;
  const promptHead = `shared-desk-${id}`;
  const promptTail = `shared-desk-complete-${id}`;
  const longPrompt = [
    promptHead,
    ...Array.from({ length: 500 }, (_, index) => `c${index}`),
    promptTail
  ].join(" ");
  const contextOptions = {
    reducedMotion: "reduce" as const,
    viewport: { height: 900, width: 1440 }
  };
  const firstContext = await browser.newContext(contextOptions);
  const secondContext = await browser.newContext(contextOptions);
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  let projectId: string | null = null;

  await firstContext.addCookies([{
    name: "aiqsa.theme",
    value: "light",
    url: "http://127.0.0.1:3000"
  }]);
  await secondContext.addCookies([{
    name: "aiqsa.theme",
    value: "dark",
    url: "http://127.0.0.1:3000"
  }]);

  try {
    await loginWithPassword(firstPage, LOCAL_MCP_MEMBER);
    await loginWithPassword(secondPage, LOCAL_RESTRICTED_MEMBER);
    await expect(firstPage.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "dark");

    let { project } = await responseJson<ProjectResponse>(
      await firstPage.request.post("/api/projects", {
        data: { description: "Two members sharing one observable workspace.", name: projectName }
      }),
      201
    );
    projectId = project.id;

    await responseJson(
      await firstPage.request.post(`/api/projects/${projectId}/resources`, {
        data: {
          expectedPolicyRevision: project.policyRevision,
          resourceId: providerTemplateIds.fakeModel,
          type: "model"
        }
      }),
      201
    );
    ({ project } = await responseJson<ProjectResponse>(
      await firstPage.request.get(`/api/projects/${projectId}`),
      200
    ));
    ({ project } = await responseJson<ProjectResponse>(
      await firstPage.request.patch(`/api/projects/${projectId}`, {
        data: {
          defaults: { ...project.defaults, providerModelId: providerTemplateIds.fakeModel },
          expectedPolicyRevision: project.policyRevision
        }
      }),
      200
    ));
    await responseJson(
      await firstPage.request.post(`/api/projects/${projectId}/grants`, {
        data: {
          expectedAccessRevision: project.accessRevision,
          role: "CONTRIBUTOR",
          userId: LOCAL_RESTRICTED_MEMBER.id
        }
      }),
      201
    );
    await responseJson<ProjectChatResponse>(
      await firstPage.request.post(`/api/projects/${projectId}/chats`, {
        data: { title: chatTitle }
      }),
      201
    );

    await Promise.all([firstPage.reload(), secondPage.reload()]);
    await Promise.all([
      expect(firstPage.getByTestId("app-shell")).toBeVisible(),
      expect(secondPage.getByTestId("app-shell")).toBeVisible()
    ]);
    await openProjectChat(firstPage, projectName, chatTitle);
    await openProjectChat(secondPage, projectName, chatTitle);

    await firstPage.getByRole("textbox", { name: "Message" }).fill(longPrompt);
    await firstPage.getByRole("textbox", { name: "Message" }).press("Enter");
    await expect(firstPage.getByRole("button", { name: "Stop answer" })).toBeVisible({ timeout: 10_000 });

    const sharedQuestion = secondPage.getByRole("article", {
      name: `Question from ${LOCAL_MCP_MEMBER.displayName}`
    });
    await expect(sharedQuestion).toContainText(promptHead, { timeout: 8_000 });
    await expect(projectChatRow(secondPage, chatTitle).getByLabel("Answer in progress"))
      .toBeVisible({ timeout: 8_000 });
    await expect(secondPage.locator('article[data-role="assistant"]').last())
      .toContainText("Fake answer:", { timeout: 8_000 });

    await expect(secondPage.locator('article[data-role="assistant"]').last())
      .toContainText(promptTail, { timeout: 20_000 });
    await expect(projectChatRow(secondPage, chatTitle).getByLabel("Answer in progress"))
      .toHaveCount(0, { timeout: 8_000 });

    await responseJson<ProjectChatResponse>(
      await firstPage.request.post(`/api/projects/${projectId}/chats`, {
        data: { title: discoveredChatTitle }
      }),
      201
    );
    await expect(projectChatRow(secondPage, discoveredChatTitle)).toBeVisible({ timeout: 8_000 });

    await secondPage.setViewportSize({ height: 768, width: 1023 });
    await expect(secondPage.locator(".v2-workspace-shell"))
      .toHaveAttribute("data-sidebar-composition", "compact");
    await secondPage.getByRole("button", { name: "Open sidebar" }).click();
    await expect(projectRow(secondPage, projectName)).toBeVisible();
    await expect(projectChatRow(secondPage, discoveredChatTitle)).toBeVisible();
    await expect(secondPage.getByRole("complementary", { name: "Shared project context" })).toBeVisible();
    await expectNoHorizontalOverflow(secondPage);
  } finally {
    if (projectId) {
      await firstPage.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
    }
    await firstContext.close();
    await secondContext.close();
  }
});
