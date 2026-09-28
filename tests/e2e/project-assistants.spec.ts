import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { e2eAssistantAvatar, e2eAssistantRows } from "./support/assistants";
import { signInWithLocalToken } from "./support/localAuth";

/*
 * Assistants in Project chats (PRD A-36): the picker lists only
 * the Project's Assistants, a new Project chat starts with the Project
 * default, and a member changes or removes it for their own chat without
 * touching the Project's defaults. The first message of a new Project chat
 * always names its Assistant, `null` without one.
 */

type Created = Readonly<{ id: string; name: string; version: number }>;

function messageRequest(page: Page): Promise<Request> {
  return page.waitForRequest((request) => request.method() === "POST" &&
    /^\/api\/chats\/[^/]+\/messages$/u.test(new URL(request.url()).pathname));
}

async function send(page: Page, text: string): Promise<Record<string, unknown>> {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  const request = messageRequest(page);
  await page.getByRole("button", { name: "Send message" }).click();
  const body = (await request).postDataJSON() as Record<string, unknown>;
  await expect(page.getByRole("region", { name: "Conversation", exact: true }).getByText(`Fake answer: ${text}`))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });
  return body;
}

async function openAssistantMenu(page: Page) {
  await page.getByTestId("header-assistant-selector").click();
  const menu = page.getByRole("menu", { name: "Assistant" });
  await expect(menu).toBeVisible();
  return menu;
}

test("a Project chat offers the Project's Assistants and never changes the Project default", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 900, width: 1440 });
  await signInWithLocalToken(page);
  const catalog = (await (await page.request.get("/api/me/catalog")).json()).catalog;
  const model = catalog.models.find((value: { providerFamily: string; upstreamModelId: string }) =>
    value.providerFamily === "fake" && value.upstreamModelId === "fake-qsa");
  expect(model).toBeTruthy();
  // The Fake QSA window cannot hold Workspace's tool context.
  const workspaceDefault = catalog.defaults.workspaceEnabled ?? false;
  const suffix = randomUUID().slice(0, 8);
  const assistants: Created[] = [];
  let projectId: string | undefined;
  try {
    expect((await page.request.patch("/api/me/settings", { data: { defaultWorkspaceEnabled: false } })).ok()).toBe(true);
    await page.goto("/");
    await expect(page.getByTestId("app-shell")).toBeVisible();
    for (const [name, paletteId] of [["Default", "ocean"], ["Second", "meadow"], ["Personal only", "plum"]] as const) {
      const response = await page.request.post("/api/me/assistants", { data: {
        avatar: e2eAssistantAvatar(paletteId),
        category: null,
        description: `${name} Assistant for Project chats.`,
        name: `${name} ${suffix}`,
        rows: e2eAssistantRows(model.modelId),
        starterPrompts: [],
        systemPrompt: "Answer briefly."
      } });
      expect(response.status()).toBe(201);
      const assistant = (await response.json()).assistant;
      assistants.push({ id: assistant.id, name: assistant.content.name, version: assistant.version });
    }
    const [projectDefault, second, personalOnly] = assistants as [Created, Created, Created];

    const created = await page.request.post("/api/projects", {
      data: { name: `Assistants ${suffix}`, preferredModelId: model.modelId }
    });
    expect(created.status()).toBe(201);
    let project = (await created.json()).project;
    projectId = project.id;
    for (const assistant of [projectDefault, second]) {
      const bound = await page.request.post(`/api/projects/${project.id}/resources`, { data: {
        expectedAssistantVersion: assistant.version,
        expectedPolicyRevision: project.policyRevision,
        resourceId: assistant.id,
        type: "assistant"
      } });
      expect(bound.status()).toBe(201);
      project = (await (await page.request.get(`/api/projects/${project.id}`)).json()).project;
    }
    const updated = await page.request.patch(`/api/projects/${project.id}`, { data: {
      defaults: { ...project.defaults, assistantId: projectDefault.id },
      expectedPolicyRevision: project.policyRevision
    } });
    expect(updated.ok()).toBe(true);
    const projectDefaultId = async () =>
      (await (await page.request.get(`/api/projects/${projectId}`)).json()).project.defaults.assistantId;

    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.locator('section[aria-label="Shared projects"] .v2-project-row').filter({ hasText: project.name }).click();
    await page.getByTestId("project-overview-page").getByRole("button", { name: "Start shared chat" }).click();

    // A new Project chat starts with the Project default, which reads as the Project's.
    const selector = page.getByTestId("header-assistant-selector");
    await expect(selector).toHaveAttribute("data-state", "chosen");
    await expect(selector).toHaveAccessibleName(`Assistant: ${projectDefault.name}`);
    let menu = await openAssistantMenu(page);
    await expect(menu.getByTestId("header-assistant-menu-head")).toHaveText(`${projectDefault.name} · Project “${project.name}”`);
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByRole("menuitem", { name: "Copy link" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Edit Assistant" })).toHaveCount(0);

    // The picker lists only the Project's Assistants, flat, with the Project settings route.
    await menu.getByRole("menuitem", { name: "Change…" }).click();
    const picker = page.getByTestId("assistant-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByTestId(`assistant-picker-row-${projectDefault.id}`)).toBeVisible();
    await expect(picker.getByTestId(`assistant-picker-row-${second.id}`)).toBeVisible();
    await expect(picker.getByTestId(`assistant-picker-row-${personalOnly.id}`)).toHaveCount(0);
    await expect(picker.getByRole("heading")).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "Manage in Project settings" })).toBeVisible();
    await picker.getByTestId(`assistant-picker-row-${second.id}`).click();
    await expect(picker).toHaveCount(0);
    await expect(selector).toHaveAttribute("data-state", "chosen");
    await expect(selector).toHaveAccessibleName(`Assistant: ${second.name}`);

    // The first message names the chosen Assistant with the bound-chat payload.
    const first = await send(page, `First with the second Assistant ${suffix}`);
    expect(first).toMatchObject({ assistantId: second.id, projectDraft: expect.any(Object) });
    for (const key of ["modelId", "prompt", "searchPreferencePlan", "searchPreferenceSource"]) {
      expect(first).not.toHaveProperty(key);
    }
    expect(await projectDefaultId()).toBe(projectDefault.id);

    // Remove for this chat is a chat update; the Project default stays.
    menu = await openAssistantMenu(page);
    const removal = page.waitForResponse((response) => response.request().method() === "PATCH" &&
      /^\/api\/chats\/[^/]+$/u.test(new URL(response.url()).pathname));
    await menu.getByRole("menuitem", { name: /Remove for this chat/u }).click();
    const removed = await removal;
    expect(removed.ok()).toBe(true);
    expect(removed.request().postDataJSON()).toEqual({ assistantId: null });
    await expect(selector).toHaveAttribute("data-state", "empty");
    expect(await projectDefaultId()).toBe(projectDefault.id);
    const later = await send(page, `Later without an Assistant ${suffix}`);
    expect(later).not.toHaveProperty("assistantId");

    // Another new chat starts with the default again; removed before the first
    // message, it is sent as explicitly none.
    await page.getByRole("complementary", { name: "Project navigation" }).getByRole("button", { name: "New shared chat" }).click();
    await expect(selector).toHaveAttribute("data-state", "chosen");
    await expect(selector).toHaveAccessibleName(`Assistant: ${projectDefault.name}`);
    menu = await openAssistantMenu(page);
    await menu.getByRole("menuitem", { name: /Remove for this chat/u }).click();
    await expect(selector).toHaveAttribute("data-state", "empty");
    const none = await send(page, `First without an Assistant ${suffix}`);
    expect(none).toMatchObject({ assistantId: null, projectDraft: expect.any(Object) });
    expect(await projectDefaultId()).toBe(projectDefault.id);
  } finally {
    if (projectId) expect((await page.request.delete(`/api/projects/${projectId}`)).ok()).toBe(true);
    for (const assistant of assistants) {
      const response = await page.request.get(`/api/me/assistants/${assistant.id}`);
      if (!response.ok()) continue;
      const detail = (await response.json()).assistant;
      await page.request.patch(`/api/me/assistants/${assistant.id}`, {
        data: { archived: true, expectedVersion: detail.version }
      });
    }
    await page.request.patch("/api/me/settings", { data: { defaultWorkspaceEnabled: workspaceDefault } });
  }
});
