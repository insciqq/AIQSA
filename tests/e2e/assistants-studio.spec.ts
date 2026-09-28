import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type Response } from "@playwright/test";
import type { AssistantDetail, AssistantDetailResponse, AssistantListResponse } from "../../lib/contracts/assistants";
import type { ChatDetailResponseWire } from "../../lib/contracts/chats";
import { runAccountMenuAction } from "./shell/page";
import { createAssistantFixture, fakeModelId, type AssistantFixture, type E2EAssistant } from "./support/assistants";
import { captureState, type CaptureSize } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { createPeopleFixture, type E2EUser, type PeopleFixture } from "./support/people";

/**
 * Studio › Assistants v2 in the real application (PRD A-23 to A-30 and
 * scenario 9). Every test signs in synthetic people, creates what it needs
 * through the shared helpers and removes it afterwards; no test depends on
 * another. Geometry is asserted with numbers; the captures in both themes at
 * the five standard sizes are evidence for a visual review, not assertions.
 */

test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const DESKTOP = { viewport: { height: 900, width: 1440 } } as const;
const ROW_LABELS = ["Model", "Reasoning & parameters", "Web search", "Tools", "Knowledge", "Skills"] as const;
const POLICY_NAME = /^(Fixed|Adjustable)$/u;

type Fixtures = Readonly<{ assistants: AssistantFixture; people: PeopleFixture }>;

/** Runs a scenario with fresh fixtures and always removes what they created. */
async function withFixtures(run: (fixtures: Fixtures) => Promise<void>): Promise<void> {
  const people = createPeopleFixture(prisma);
  const assistants = createAssistantFixture(prisma, { suffix: people.suffix });
  try {
    await run({ assistants, people });
  } finally {
    try {
      await assistants.cleanup();
    } finally {
      await people.cleanup();
    }
  }
}

async function signIn(people: PeopleFixture, browser: Browser, user: E2EUser): Promise<Page> {
  return (await people.signIn(browser, user, DESKTOP)).page;
}

async function openAssistants(page: Page): Promise<{ gallery: Locator; library: Locator }> {
  await runAccountMenuAction(page, "Assistants");
  const library = page.getByTestId("library-v2");
  const gallery = library.getByTestId("assistant-gallery");
  await expect(gallery).toBeVisible();
  return { gallery, library };
}

async function cardMenuAction(page: Page, card: Locator, name: string, action: string): Promise<void> {
  await card.getByRole("button", { exact: true, name: `More actions for ${name}` }).click();
  await page.getByRole("menu", { name: `Actions for ${name}` }).getByRole("menuitem", { exact: true, name: action }).click();
}

async function openEditor(page: Page, library: Locator, assistant: E2EAssistant): Promise<Locator> {
  await cardMenuAction(page, library.getByTestId(`assistant-card-${assistant.id}`), assistant.name, "Edit");
  const editor = library.getByTestId("assistant-editor");
  await expect(editor.getByLabel("Name Required", { exact: true })).toHaveValue(assistant.name);
  return editor;
}

/** Opens the New assistant sheet from the gallery heading. */
async function openNewAssistantSheet(page: Page, library: Locator): Promise<Locator> {
  await library.getByRole("button", { exact: true, name: "New assistant" }).first().click();
  const sheet = page.getByRole("dialog", { exact: true, name: "New assistant" });
  await expect(sheet.getByRole("radio", { exact: true, name: "Blank" })).toBeChecked();
  return sheet;
}

async function readAssistant(request: APIRequestContext, assistantId: string): Promise<AssistantDetail> {
  const response = await request.get(`/api/me/assistants/${assistantId}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json() as AssistantDetailResponse).assistant;
}

async function readChat(request: APIRequestContext, chatId: string): Promise<ChatDetailResponseWire["chat"]> {
  const response = await request.get(`/api/chats/${chatId}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json() as ChatDetailResponseWire).chat;
}

async function createSkill(request: APIRequestContext, name: string): Promise<{ id: string; name: string }> {
  const response = await request.post("/api/me/skills", {
    data: { description: "Synthetic Studio fixture", instructions: "Keep the response concise.", name }
  });
  expect(response.status(), await response.text()).toBe(201);
  const { skill } = await response.json() as { skill: { id: string; name: string } };
  return { id: skill.id, name: skill.name };
}

/** Counts `POST /api/me/assistants`, so a scenario can prove that nothing was created. */
function countAssistantCreations(page: Page): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/me/assistants") count += 1;
  });
  return () => count;
}

function assistantCreation(page: Page): Promise<Response> {
  return page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/me/assistants");
}

function isPhone(size: CaptureSize): boolean {
  return size.width < 640 || size.height < 512;
}

/** Cards in the first row of a grid, measured from their boxes. */
async function firstRowColumns(cards: Locator): Promise<number> {
  const tops = await cards.evaluateAll((elements) =>
    elements.map((element) => Math.round(element.getBoundingClientRect().top)));
  const first = Math.min(...tops);
  return tops.filter((top) => Math.abs(top - first) <= 2).length;
}

/** The product of the opacities up the tree: 1 when nothing hides the control until hover. */
async function effectiveOpacity(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility !== "visible" || style.display === "none") return 0;
      opacity *= Number(style.opacity);
    }
    return opacity;
  });
}

/** Every chip's count equals the number of cards its list shows under the current category and search. */
async function expectChipCountsMatchLists(gallery: Locator, context: string): Promise<Record<string, number>> {
  const chips = gallery.getByRole("group", { name: "Filter Assistants" }).getByRole("button");
  await expect(chips).toHaveCount(6);
  const counts: Record<string, number> = {};
  for (const label of ["Pinned", "Yours", "Shared", "Featured", "Archived", "All"]) {
    const chip = chips.filter({ hasText: new RegExp(`^${label} \\d+$`, "u") });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    const count = Number(/(\d+)$/u.exec((await chip.innerText()).trim())?.[1]);
    expect(Number.isInteger(count), `${context}: ${label} shows a count`).toBe(true);
    await expect(gallery.getByRole("article"), `${context}: ${label} lists what it counts`).toHaveCount(count);
    counts[label] = count;
  }
  return counts;
}

test("gallery chips count exactly what they list under category and search, Featured leads and Start chat needs no hover · A-23", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const group = await people.group("Gallery team");
    const colleague = await people.user("Colleague", { groups: [{ group, role: "manager" }] });
    const viewer = await people.user("Viewer", { groups: [group] });
    const admin = await people.admin("Gallery admin");
    const colleagueApi = (await signIn(people, browser, colleague)).request;
    const adminApi = (await signIn(people, browser, admin)).request;
    const page = await signIn(people, browser, viewer);

    const alpha = await assistants.create(page.request, { category: "writing", description: "Drafts release notes.", name: "Alpha notes" });
    const beta = await assistants.create(page.request, { name: "Beta pinned" });
    const gamma = await assistants.create(page.request, { name: "Gamma plain" });
    const omega = await assistants.create(page.request, { name: "Omega archived" });
    await assistants.pin(page.request, beta.id);
    await assistants.archive(page.request, omega.id);
    const delta = await assistants.create(colleagueApi, { description: "Answers team questions.", name: "Delta shared" });
    await assistants.publish(colleagueApi, delta.id, { groupId: group.id });
    const epsilon = await assistants.create(colleagueApi, { name: "Epsilon featured" });
    const { requestId } = await assistants.requestListing(colleagueApi, epsilon.id);
    await assistants.decideListing(adminApi, requestId, "approve");
    await assistants.feature(adminApi, epsilon.id, 0);

    const { gallery } = await openAssistants(page);
    const card = (assistant: E2EAssistant) => gallery.getByTestId(`assistant-card-${assistant.id}`);
    for (const assistant of [alpha, beta, gamma, delta, epsilon]) await expect(card(assistant)).toBeVisible();

    // All: Featured is the first group, the pinned card is under Pinned, archived cards are not listed.
    await expect(gallery.getByRole("heading", { level: 3 }).first()).toHaveText("Featured");
    await expect(gallery.getByRole("region", { name: "Featured" }).getByRole("article").first())
      .toHaveAttribute("data-testid", `assistant-card-${epsilon.id}`);
    await expect(gallery.getByRole("region", { name: "Pinned" }).getByTestId(`assistant-card-${beta.id}`)).toBeVisible();
    await expect(card(omega)).toHaveCount(0);

    // Start chat is visible and usable on every card without hovering it.
    await page.mouse.move(0, 0);
    for (const assistant of [alpha, delta, epsilon]) {
      const start = card(assistant).getByRole("button", { exact: true, name: `Start chat with ${assistant.name}` });
      await expect(start).toBeVisible();
      await expect(start).toBeEnabled();
      expect(await effectiveOpacity(start), assistant.name).toBe(1);
    }

    const counts = await expectChipCountsMatchLists(gallery, "no filter");
    expect(counts.Archived).toBeGreaterThanOrEqual(1);
    expect(counts.Yours).toBe(3);
    await gallery.getByRole("button", { name: /^Archived \d+$/u }).click();
    await expect(card(omega)).toContainText("Archived");
    await expect(card(omega).getByRole("button", { exact: true, name: `Restore ${omega.name}` })).toBeVisible();
    await gallery.getByRole("button", { name: /^All \d+$/u }).click();

    // Category narrows the same selection the chips count.
    const category = gallery.getByRole("combobox", { name: "Category" });
    await category.selectOption("writing");
    await expectChipCountsMatchLists(gallery, "category Writing");
    await expect(card(alpha)).toBeVisible();
    await expect(card(beta)).toHaveCount(0);
    await category.selectOption("");

    // Search covers the author: one flat list without group headings.
    const search = gallery.getByRole("searchbox", { name: "Search Assistants" });
    await search.fill(colleague.displayName);
    await expectChipCountsMatchLists(gallery, "author search");
    for (const heading of ["Featured", "Pinned", "Recently updated"]) {
      await expect(gallery.getByRole("heading", { exact: true, name: heading })).toHaveCount(0);
    }
    await expect(card(delta)).toBeVisible();
    await expect(card(epsilon)).toBeVisible();
    await expect(card(alpha)).toHaveCount(0);
    await search.fill("");

    await captureState(page, testInfo, "studio-assistant-gallery", {
      atEachSize: async ({ size }) => {
        await expect(card(alpha).getByRole("button", { exact: true, name: `Start chat with ${alpha.name}` }), `${size.width}x${size.height}`)
          .toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    });

    // Columns from the cards' boxes: 3 from 900 px of gallery width, 2 from 600, 1 below (PRD 10.1, 11).
    await gallery.getByRole("button", { name: /^Yours \d+$/u }).click();
    const prdColumns: Readonly<Record<number, number>> = { 1024: 2, 1440: 3, 390: 1 };
    await captureState(page, testInfo, "studio-assistant-gallery-yours", {
      atEachSize: async ({ size }) => {
        const label = `${size.width}x${size.height}`;
        const width = (await gallery.boundingBox())!.width;
        const columns = await firstRowColumns(gallery.getByRole("article"));
        expect(columns, `${label}, gallery ${Math.round(width)} px`).toBe(width >= 900 ? 3 : width >= 600 ? 2 : 1);
        const expected = prdColumns[size.width];
        if (expected !== undefined) expect(columns, `${label} PRD columns`).toBe(expected);
        await expectNoHorizontalOverflow(page);
      }
    });
  });
});

test("detail sheet shows six Setup rows with policies, names for the owner, counts for a consumer and read-only instructions · A-24", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const group = await people.group("Detail team");
    const owner = await people.user("Owner", { groups: [{ group, role: "manager" }] });
    const consumer = await people.user("Consumer", { groups: [group] });
    const ownerPage = await signIn(people, browser, owner);
    const consumerPage = await signIn(people, browser, consumer);
    const skill = await createSkill(ownerPage.request, `Private checklist ${people.suffix}`);
    const reminder = "Reminder text that stays with the model.";
    const assistant = await assistants.create(ownerPage.request, {
      description: "Answers release questions.",
      name: "Release desk",
      responseReminder: reminder,
      rows: { skills: { policy: "fixed", value: { links: [{ delivery: "always", skillId: skill.id }], mode: "auto" } } },
      starterPrompts: ["What ships this week?", "Draft the release note"],
      systemPrompt: "You answer release questions. Today is {local_date}."
    });
    // A group publication with a private Skill link: the API would refuse it, the stored state is what matters.
    await assistants.seedPublication(assistant.id, { groupId: group.id });

    const openSheet = async (page: Page, gallery: Locator) => {
      await gallery.getByTestId(`assistant-card-${assistant.id}`).getByRole("button", { exact: true, name: assistant.name }).click();
      const sheet = page.getByRole("dialog", { exact: true, name: assistant.name });
      await expect(sheet.getByTestId("assistant-detail")).toBeVisible();
      return sheet;
    };
    const expectInstructionsPreview = async (sheet: Locator) => {
      await sheet.getByRole("region", { name: "Instructions" }).getByRole("button", { exact: true, name: "View" }).click();
      const preview = sheet.getByLabel("Instructions preview");
      await expect(preview).toContainText("You answer release questions. Today is");
      await expect(preview).not.toContainText("{local_date}");
      await expect(preview).toContainText("[response reminder omitted]");
      await expect(preview).not.toContainText(reminder);
    };
    const sheetGeometry = (page: Page, sheet: Locator) => async ({ size }: { size: CaptureSize }) => {
      const label = `${size.width}x${size.height}`;
      const box = (await sheet.boundingBox())!;
      if (isPhone(size)) {
        expect(Math.round(box.width), label).toBe(size.width);
        expect(Math.round(box.height), label).toBe(size.height);
      } else {
        expect(Math.round(box.width), label).toBe(600);
      }
      await expectNoHorizontalOverflow(page);
    };

    const ownerSheet = await openSheet(ownerPage, (await openAssistants(ownerPage)).gallery);
    const ownerSetup = ownerSheet.getByRole("region", { name: "Setup" });
    await expect(ownerSetup.getByRole("row")).toHaveCount(6);
    for (const label of ROW_LABELS) {
      await expect(ownerSetup.getByRole("row", { name: new RegExp(`^${label}`, "u") })).toContainText(label === "Reasoning & parameters" ? "Adjustable" : "Fixed");
    }
    await expect(ownerSetup.getByRole("row", { name: /^Skills/u })).toContainText(`1 always: ${skill.name}`);
    await expect(ownerSheet).toContainText("Yours · 1 group · Updated");
    await expect(ownerSheet.getByRole("button", { exact: true, name: "Edit" })).toBeVisible();
    await expect(ownerSheet.getByRole("region", { name: "Conversation starters" }).getByRole("button")).toHaveCount(2);
    const sharing = ownerSheet.getByRole("region", { name: "Sharing" });
    await expect(sharing).toContainText(`Groups: ${group.name}`);
    await expect(sharing.getByRole("button", { exact: true, name: "Manage sharing…" })).toBeVisible();
    await expect(ownerSheet.getByRole("region", { name: "Usage" })).toContainText("in the last 30 days");
    await expectInstructionsPreview(ownerSheet);
    await captureState(ownerPage, testInfo, "studio-assistant-detail-owner", { atEachSize: sheetGeometry(ownerPage, ownerSheet) });

    const consumerGallery = (await openAssistants(consumerPage)).gallery;
    const consumerCard = consumerGallery.getByTestId(`assistant-card-${assistant.id}`);
    await expect(consumerCard).toContainText("Not available to you");
    await expect(consumerCard.getByRole("button", { exact: true, name: `Start chat with ${assistant.name}` })).toBeDisabled();
    const consumerSheet = await openSheet(consumerPage, consumerGallery);
    const consumerSetup = consumerSheet.getByRole("region", { name: "Setup" });
    await expect(consumerSetup.getByRole("row")).toHaveCount(6);
    for (const label of ROW_LABELS) {
      await expect(consumerSetup.getByRole("row", { name: new RegExp(`^${label}`, "u") })).toContainText(/Fixed|Adjustable/u);
    }
    const consumerSkills = consumerSetup.getByRole("row", { name: /^Skills/u });
    await expect(consumerSkills).toContainText("1 Skill you can't access");
    await expect(consumerSkills).toContainText("Not available to you");
    await expect(consumerSheet).not.toContainText(skill.name);
    await expect(consumerSheet).toContainText(`By ${owner.displayName}`);
    await expect(consumerSheet.getByRole("button", { exact: true, name: "Start chat" })).toBeDisabled();
    await expect(consumerSheet.getByRole("button", { exact: true, name: "Edit" })).toHaveCount(0);
    await expect(consumerSheet.getByRole("button", { exact: true, name: "Manage sharing…" })).toHaveCount(0);
    await expect(consumerSheet.getByRole("region", { name: "Usage" })).toHaveCount(0);
    // A consumer reads the instructions, rendered and without the reminder text.
    await expectInstructionsPreview(consumerSheet);
    const consumerDetail = JSON.stringify(await readAssistant(consumerPage.request, assistant.id));
    expect(consumerDetail).not.toContain(skill.id);
    expect(consumerDetail).not.toContain(skill.name);
    await captureState(consumerPage, testInfo, "studio-assistant-detail-consumer", { atEachSize: sheetGeometry(consumerPage, consumerSheet) });
  });
});

test("editor has two columns at 1440 and one column with Setup after the starters below it, with the save bar in view · A-25", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Editor owner");
    const page = await signIn(people, browser, owner);
    const assistant = await assistants.create(page.request, {
      description: "Reviews release diffs.",
      name: "Layout desk",
      starterPrompts: ["Summarize the diff", "List the risks"]
    });
    const { library } = await openAssistants(page);
    const editor = await openEditor(page, library, assistant);
    const main = editor.locator(".v2-assistant-editor-main");
    const setup = editor.getByRole("complementary", { name: "Setup" });
    const starters = editor.getByRole("heading", { exact: true, name: "Conversation starters" });
    const instructions = editor.locator(".v2-assistant-instructions > .v2-markdown-editor");
    const save = editor.getByTestId("assistant-editor-save");

    // Each row: an accordion button and a policy toggle named Fixed or Adjustable with aria-pressed.
    for (const label of ROW_LABELS) {
      await expect(setup.getByRole("button", { exact: true, name: label })).toHaveAttribute("aria-expanded", "false");
    }
    const toggles = setup.getByRole("button", { name: POLICY_NAME });
    await expect(toggles).toHaveCount(6);
    for (const toggle of await toggles.all()) {
      const name = (await toggle.innerText()).trim();
      await expect(toggle).toHaveAttribute("aria-pressed", name === "Fixed" ? "true" : "false");
    }

    await captureState(page, testInfo, "studio-assistant-editor-existing", {
      atEachSize: async ({ size }) => {
        const label = `${size.width}x${size.height}`;
        const [pageBox, mainBox, setupBox, startersBox, instructionsBox] = await Promise.all([
          editor.boundingBox(), main.boundingBox(), setup.boundingBox(), starters.boundingBox(), instructions.boundingBox()
        ]);
        // Two columns from 1040 px of editor width with a 360 px Setup column; one column below.
        if (pageBox!.width >= 1040) {
          expect(setupBox!.x, label).toBeGreaterThanOrEqual(mainBox!.x + mainBox!.width - 1);
          expect(setupBox!.y, label).toBeLessThan(startersBox!.y);
          expect(Math.round(setupBox!.width), label).toBe(360);
        } else {
          expect(setupBox!.y, label).toBeGreaterThan(startersBox!.y);
          expect(Math.abs(setupBox!.x - mainBox!.x), label).toBeLessThanOrEqual(1);
        }
        if (size.width === 1440) {
          expect(pageBox!.width, label).toBeGreaterThanOrEqual(1040);
          expect(instructionsBox!.height, label).toBeGreaterThanOrEqual(480);
        }
        if (size.width === 1024 || size.width === 390) expect(pageBox!.width, label).toBeLessThan(1040);
        expect(instructionsBox!.height, label).toBeGreaterThanOrEqual(319);
        // Split only when the instructions editor's own container is at least 880 px wide.
        const split = instructions.getByRole("radio", { name: "Split" });
        if (instructionsBox!.width >= 880) await expect(split, label).toBeChecked();
        else {
          await expect(split, label).toHaveCount(0);
          await expect(instructions.getByRole("radio", { name: "Write" }), label).toBeChecked();
        }
        await expect(save, label).toBeInViewport({ ratio: 1 });
        await expectNoHorizontalOverflow(page);
      }
    });
  });
});

test("policy toggles ask for a concrete value before Create and save exactly what they show · A-25", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ people }) => {
    const owner = await people.user("Policy owner");
    const page = await signIn(people, browser, owner);
    const modelId = await fakeModelId(prisma);
    const creations = countAssistantCreations(page);
    const { library } = await openAssistants(page);
    const sheet = await openNewAssistantSheet(page, library);
    await sheet.getByRole("button", { exact: true, name: "Continue" }).click();
    const editor = library.getByTestId("assistant-editor");
    const name = `Fixed rows ${people.suffix}`;
    await editor.getByLabel("Name Required", { exact: true }).fill(name);
    await expect(editor.getByRole("button", { name: POLICY_NAME })).toHaveCount(6);
    await expect(editor.getByRole("button", { exact: true, name: "Adjustable" })).toHaveCount(6);

    const fixRow = async (key: "controls" | "model" | "tools", label: string) => {
      const row = editor.getByTestId(`assistant-setup-row-${key}`);
      await row.getByRole("button", { exact: true, name: "Adjustable" }).click();
      const fixed = row.getByRole("button", { exact: true, name: "Fixed" });
      await expect(fixed).toHaveAttribute("aria-pressed", "true");
      // Focus keeps the exact name; the explanation is the description, not part of the name.
      await expect(fixed).toBeFocused();
      await expect(fixed).toHaveAccessibleName("Fixed");
      await expect(fixed).toHaveAccessibleDescription(/Fixed: used in every chat, cannot be changed there\./u);
      // Fixed on an inherited value opens the row and asks for a value there.
      await expect(row.getByRole("button", { exact: true, name: label })).toHaveAttribute("aria-expanded", "true");
      return row;
    };
    const modelRow = await fixRow("model", "Model");
    await expect(modelRow).toContainText("Choose a value to fix, or make this row Adjustable.");
    const toolsRow = await fixRow("tools", "Tools");
    await expect(toolsRow).toContainText("Choose a value to fix, or make this row Adjustable.");

    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByRole("alert").filter({ hasText: "Review the highlighted fields." })).toBeVisible();
    expect(creations()).toBe(0);

    await modelRow.getByLabel("Model", { exact: true }).selectOption(modelId);
    await expect(modelRow).not.toContainText("Choose a value to fix");
    await toolsRow.getByRole("radio", { exact: true, name: "Off" }).check();
    await expect(toolsRow).not.toContainText("Choose a value to fix");
    // Fixed parameters need at least one value; the toggle goes back to Adjustable.
    const controlsRow = await fixRow("controls", "Reasoning & parameters");
    await expect(controlsRow).toContainText("Set at least one parameter to fix, or make this row Adjustable.");
    await controlsRow.getByRole("button", { exact: true, name: "Fixed" }).click();
    await expect(controlsRow.getByRole("button", { exact: true, name: "Adjustable" })).toHaveAttribute("aria-pressed", "false");
    await expect(controlsRow).not.toContainText("Set at least one parameter");

    const creation = assistantCreation(page);
    await editor.getByTestId("assistant-editor-save").click();
    const response = await creation;
    expect(response.status()).toBe(201);
    const created = (await response.json() as AssistantDetailResponse).assistant;
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Assistant created.");
    const rows = (await readAssistant(page.request, created.id)).content.rows;
    expect(rows.model).toEqual({ policy: "fixed", value: { mode: "model", modelId } });
    expect(rows.tools).toEqual({ policy: "fixed", value: { mode: "off" } });
    expect(rows.controls.policy).toBe("adjustable");
    expect(rows.search).toEqual({ policy: "adjustable", value: { mode: "inherit" } });
    expect(rows.knowledge).toEqual({ policy: "adjustable", value: { mode: "none" } });
    expect(rows.skills).toEqual({ policy: "adjustable", value: { links: [], mode: "auto" } });
  });
});

test("Skills row keeps one list with Always or On demand per link, an honest switch and a count, without an Order number · A-26", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Skills owner");
    const page = await signIn(people, browser, owner);
    const always = await createSkill(page.request, `Always checklist ${people.suffix}`);
    const onDemand = await createSkill(page.request, `On demand charts ${people.suffix}`);
    const assistant = await assistants.create(page.request, {
      name: "Skills desk",
      rows: {
        skills: {
          policy: "adjustable",
          value: { links: [{ delivery: "always", skillId: always.id }, { delivery: "on_demand", skillId: onDemand.id }], mode: "auto" }
        }
      }
    });
    const { library } = await openAssistants(page);
    const editor = await openEditor(page, library, assistant);
    const row = editor.getByTestId("assistant-setup-row-skills");
    await row.getByRole("button", { exact: true, name: "Skills" }).click();
    await expect(row.getByRole("button", { exact: true, name: "Skills" })).toHaveAttribute("aria-expanded", "true");

    const links = row.getByRole("list", { name: "Linked Skills" });
    await expect(links.getByRole("listitem")).toHaveCount(2);
    await expect(links.getByRole("listitem").nth(0)).toContainText(always.name);
    await expect(links.getByRole("listitem").nth(1)).toContainText(onDemand.name);
    const delivery = (skill: { name: string }) => links.getByRole("radiogroup", { exact: true, name: `Delivery for ${skill.name}` });
    await expect(delivery(always).getByRole("radio", { exact: true, name: "Always" })).toHaveAttribute("aria-checked", "true");
    await expect(delivery(onDemand).getByRole("radio", { exact: true, name: "On demand" })).toHaveAttribute("aria-checked", "true");
    const loading = row.getByRole("switch", { exact: true, name: "Load Skills on demand" });
    await expect(loading).toHaveAttribute("aria-checked", "true");
    await expect(row).toContainText("Off keeps Always Skills and disables loading others");
    await expect(row.getByText("1 always · 1 on demand", { exact: true })).toBeVisible();
    await expect(row).toContainText("Always Skills are delivered in this order");
    // One control per link: no remove checkbox, no delivery select, no Order number.
    await expect(row).not.toContainText(/Order \d/u);
    await expect(row.getByRole("checkbox")).toHaveCount(0);
    await expect(row.getByRole("combobox")).toHaveCount(0);
    await expect(row.getByRole("spinbutton")).toHaveCount(0);

    await delivery(onDemand).getByRole("radio", { exact: true, name: "Always" }).click();
    await expect(row.getByText("2 always · 0 on demand", { exact: true })).toBeVisible();
    await loading.click();
    await expect(loading).toHaveAttribute("aria-checked", "false");
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    expect((await readAssistant(page.request, assistant.id)).content.rows.skills).toEqual({
      policy: "adjustable",
      value: { links: [{ delivery: "always", skillId: always.id }, { delivery: "always", skillId: onDemand.id }], mode: "off" }
    });

    await captureState(page, testInfo, "studio-assistant-editor-skills-row", {
      anchor: row,
      atEachSize: () => expectNoHorizontalOverflow(page)
    });
  });
});

test("Save & try from the Code reviewer template opens a Temporary chat with the Assistant and Edit Assistant returns to it · A-27", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ people }) => {
    const owner = await people.user("Try owner");
    const page = await signIn(people, browser, owner);
    const { library } = await openAssistants(page);
    const sheet = await openNewAssistantSheet(page, library);
    await sheet.getByText("Code reviewer", { exact: true }).click();
    await expect(sheet.getByRole("radio", { exact: true, name: "Code reviewer" })).toBeChecked();
    await sheet.getByRole("button", { exact: true, name: "Continue" }).click();
    const editor = library.getByTestId("assistant-editor");
    const name = `Code reviewer ${people.suffix}`;
    await editor.getByLabel("Name Required", { exact: true }).fill(name);

    const creation = assistantCreation(page);
    await editor.getByRole("button", { exact: true, name: "Save & try" }).click();
    const response = await creation;
    expect(response.status()).toBe(201);
    const created = (await response.json() as AssistantDetailResponse).assistant;

    await expect(page.getByTestId("library-v2")).toHaveCount(0);
    await expect(page.getByTestId("header-temporary-indicator")).toBeVisible();
    const selector = page.getByTestId("header-assistant-selector");
    await expect(selector).toHaveAttribute("data-state", "chosen");
    await expect(selector).toHaveAccessibleName(`Assistant: ${name}`);
    // Scenario 1: nothing in Setup was touched, so the header shows the user's own model without the Assistant's mark.
    await expect(page.getByTestId("header-model-trigger")).not.toHaveAttribute("data-provenance", "assistant");
    await expect(page.getByTestId("assistant-starter-prompts").getByRole("button", { name: "Review this diff before I merge it" }))
      .toBeVisible();
    const rows = (await readAssistant(page.request, created.id)).content.rows;
    expect(rows).toEqual({
      controls: { policy: "adjustable", value: {} },
      knowledge: { policy: "adjustable", value: { mode: "none" } },
      model: { policy: "adjustable", value: { mode: "inherit" } },
      search: { policy: "adjustable", value: { mode: "inherit" } },
      skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
      tools: { policy: "adjustable", value: { mode: "inherit" } }
    });

    await selector.click();
    await page.getByRole("menu", { name: "Assistant" }).getByRole("menuitem", { exact: true, name: "Edit Assistant" }).click();
    const reopened = page.getByTestId("library-v2").getByTestId("assistant-editor");
    await expect(reopened.getByLabel("Name Required", { exact: true })).toHaveValue(name);
    await expect(reopened.getByLabel("Description", { exact: true }))
      .toHaveValue("Names the file and line, explains the failure, proposes the smallest fix.");
    await expect(reopened.getByText("Saved", { exact: true })).toBeVisible();
    await expect(reopened.getByTestId("assistant-editor-save")).toHaveText("Save");
    await expect(reopened.getByTestId("assistant-editor-save")).toBeDisabled();
  });
});

test("templates and From current chat only fill the editor; nothing is created until Create · A-28", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ people }) => {
    const owner = await people.user("Template owner");
    const page = await signIn(people, browser, owner);
    const skill = await createSkill(page.request, `Pinned review ${people.suffix}`);
    const creations = countAssistantCreations(page);
    const { library } = await openAssistants(page);
    const cancelEditor = async (editor: Locator) => {
      // A prefilled draft nobody edited closes without a discard question.
      await editor.getByRole("button", { exact: true, name: "Cancel" }).click();
      await expect(editor).toHaveCount(0);
      await expect(library.getByTestId("assistant-gallery")).toBeVisible();
    };

    let sheet = await openNewAssistantSheet(page, library);
    await expect(sheet.getByRole("radio")).toHaveCount(8);
    await captureState(page, testInfo, "studio-assistant-new-sheet", {
      atEachSize: async () => {
        await expectWithinViewport(page, sheet.getByRole("button", { exact: true, name: "Continue" }));
        await expectNoHorizontalOverflow(page);
      }
    });
    await sheet.getByText("Code reviewer", { exact: true }).click();
    await sheet.getByRole("button", { exact: true, name: "Continue" }).click();
    let editor = library.getByTestId("assistant-editor");
    await expect(editor.getByLabel("Name Required", { exact: true })).toHaveValue("Code reviewer");
    await expect(editor.getByLabel("Description", { exact: true }))
      .toHaveValue("Names the file and line, explains the failure, proposes the smallest fix.");
    await expect(editor.getByRole("textbox", { exact: true, name: "Instructions" })).toHaveValue(/^# Role/u);
    const starters = ["Review this diff before I merge it", "Why does this function fail on empty input?",
      "Check this handler for security issues", "Suggest tests for this change"];
    for (const [index, starter] of starters.entries()) {
      await expect(editor.getByRole("textbox", { exact: true, name: `Conversation starter ${index + 1}` })).toHaveValue(starter);
    }
    await expect(editor.getByRole("button", { exact: true, name: "Adjustable" })).toHaveCount(6);
    await expect(editor.getByText("Not saved yet", { exact: true })).toBeVisible();
    await expect(editor.getByTestId("assistant-editor-save")).toHaveText("Create");
    await captureState(page, testInfo, "studio-assistant-editor-new-template", { atEachSize: () => expectNoHorizontalOverflow(page) });
    await cancelEditor(editor);

    // "Support with Knowledge" opens the Knowledge row for its first choice.
    sheet = await openNewAssistantSheet(page, library);
    await sheet.getByText("Support with Knowledge", { exact: true }).click();
    await sheet.getByRole("button", { exact: true, name: "Continue" }).click();
    editor = library.getByTestId("assistant-editor");
    const knowledge = editor.getByTestId("assistant-setup-row-knowledge");
    await expect(knowledge.getByRole("button", { exact: true, name: "Knowledge" })).toHaveAttribute("aria-expanded", "true");
    await expect(knowledge.getByRole("radio", { exact: true, name: "None" })).toBeChecked();
    await captureState(page, testInfo, "studio-assistant-editor-setup-expanded", {
      anchor: knowledge,
      atEachSize: () => expectNoHorizontalOverflow(page)
    });
    await cancelEditor(editor);
    expect(creations()).toBe(0);

    // From current chat: the composer's pinned Skill becomes an Always link of an adjustable row.
    await library.getByRole("button", { exact: true, name: "Back to chat" }).click();
    await expect(library).toHaveCount(0);
    await page.getByRole("button", { name: "Change Skills mode" }).click();
    await page.getByRole("menuitem", { name: /^Skills…/u }).click();
    const skills = page.getByRole("dialog", { exact: true, name: "Skills" });
    await skills.getByRole("searchbox", { name: "Search Skills" }).fill(skill.name);
    await skills.getByRole("button", { exact: true, name: `Always use ${skill.name}` }).click();
    await skills.getByRole("button", { exact: true, name: "Close Skills" }).click();
    await expect(skills).toHaveCount(0);

    await openAssistants(page);
    sheet = await openNewAssistantSheet(page, library);
    await sheet.getByText("From current chat", { exact: true }).click();
    await expect(sheet.getByRole("radio", { exact: true, name: "From current chat" })).toBeChecked();
    await sheet.getByRole("button", { exact: true, name: "Continue" }).click();
    editor = library.getByTestId("assistant-editor");
    await expect(editor.getByTestId("assistant-editor-save")).toHaveText("Create");
    await expect(editor.getByRole("button", { exact: true, name: "Adjustable" })).toHaveCount(6);
    await expect(editor.getByRole("button", { exact: true, name: "Fixed" })).toHaveCount(0);
    const skillsRow = editor.getByTestId("assistant-setup-row-skills");
    await expect(skillsRow).toContainText("1 always · 0 on demand");
    await skillsRow.getByRole("button", { exact: true, name: "Skills" }).click();
    const link = skillsRow.getByRole("list", { name: "Linked Skills" }).getByRole("listitem");
    await expect(link).toHaveCount(1);
    await expect(link).toContainText(skill.name);
    await expect(link.getByRole("radio", { exact: true, name: "Always" })).toHaveAttribute("aria-checked", "true");
    await cancelEditor(editor);

    expect(creations()).toBe(0);
    const list = await page.request.get("/api/me/assistants");
    expect(list.ok()).toBe(true);
    expect((await list.json() as AssistantListResponse).assistants.filter((assistant) => assistant.owned)).toEqual([]);
  });
});

test("delete lists the server's consequences before removing, and archive moves the card to Archived with Restore · A-29", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const group = await people.group("Delete team");
    const owner = await people.user("Delete owner", { groups: [{ group, role: "manager" }] });
    const page = await signIn(people, browser, owner);
    const assistant = await assistants.create(page.request, { description: "Retires soon.", name: "Retired helper" });
    await assistants.publish(page.request, assistant.id, { groupId: group.id });
    const chatId = await assistants.createChat(page.request, { assistant: { assistantId: assistant.id } });

    const { gallery } = await openAssistants(page);
    const card = gallery.getByTestId(`assistant-card-${assistant.id}`);
    const notice = gallery.getByTestId("assistant-gallery-notice");
    await cardMenuAction(page, card, assistant.name, "Archive");
    await expect(notice).toContainText(`Archived ${assistant.name}.`);
    await expect(card).toHaveCount(0);
    await gallery.getByRole("button", { name: /^Archived \d+$/u }).click();
    await expect(card).toContainText("Archived");
    await expect(card.getByRole("button", { name: /^Start chat/u })).toHaveCount(0);
    await card.getByRole("button", { exact: true, name: `Restore ${assistant.name}` }).click();
    await expect(notice).toContainText(`Restored ${assistant.name}.`);
    await expect(card).toHaveCount(0);
    await gallery.getByRole("button", { name: /^All \d+$/u }).click();
    await expect(card).toBeVisible();

    await cardMenuAction(page, card, assistant.name, "Delete");
    const dialog = page.getByRole("dialog", { name: `Delete “${assistant.name}”?` });
    await expect(dialog).toContainText("What changes:", { timeout: 15_000 });
    await expect(dialog.getByRole("listitem")).toHaveText([
      `It is unshared from the group ${group.name}.`,
      "1 chat keeps its messages and shows that the Assistant was deleted."
    ]);
    await expect(dialog.getByRole("button", { exact: true, name: "Delete" })).toBeEnabled();
    await captureState(page, testInfo, "studio-assistant-delete-dialog", {
      atEachSize: async () => {
        await expectWithinViewport(page, dialog.getByRole("button", { exact: true, name: "Delete" }));
        await expectNoHorizontalOverflow(page);
      }
    });
    await dialog.getByRole("button", { exact: true, name: "Delete" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(notice).toContainText(`Deleted ${assistant.name}.`);
    await expect(card).toHaveCount(0);
    expect((await page.request.get(`/api/me/assistants/${assistant.id}`)).status()).toBe(404);
    // What the dialog promised: the chat stays and reports the deletion.
    expect((await readChat(page.request, chatId)).assistant).toEqual({ state: "deleted" });
  });
});

test("duplicating a shared Assistant reports that Setup the copier cannot use was reset", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const group = await people.group("Copy team");
    const owner = await people.user("Copy owner", { groups: [{ group, role: "manager" }] });
    const copier = await people.user("Copier", { groups: [group] });
    const ownerPage = await signIn(people, browser, owner);
    const page = await signIn(people, browser, copier);
    const skill = await createSkill(ownerPage.request, `Owner-only checklist ${people.suffix}`);
    const assistant = await assistants.create(ownerPage.request, {
      name: "Checklist helper",
      rows: { skills: { policy: "fixed", value: { links: [{ delivery: "always", skillId: skill.id }], mode: "auto" } } }
    });
    await assistants.seedPublication(assistant.id, { groupId: group.id });

    const { gallery } = await openAssistants(page);
    await cardMenuAction(page, gallery.getByTestId(`assistant-card-${assistant.id}`), assistant.name, "Duplicate");
    const copyName = `Copy of ${assistant.name}`;
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText(
      `Duplicated as ${copyName}. The copy is private. Setup you cannot use was reset to your own defaults.`
    );
    const copyCard = gallery.getByRole("article").filter({ has: page.getByRole("button", { exact: true, name: copyName }) });
    await expect(copyCard).toContainText("Yours");
    await expect(copyCard.getByRole("button", { exact: true, name: `Start chat with ${copyName}` })).toBeEnabled();
    const list = await page.request.get("/api/me/assistants");
    const copy = (await list.json() as AssistantListResponse).assistants.find((entry) => entry.owned && entry.name === copyName);
    expect(copy).toBeTruthy();
    expect((await readAssistant(page.request, copy!.id)).content.rows.skills.value.links).toEqual([]);
  });
});

test("a version conflict keeps the draft beside the latest saved version and saves it on request · A-30", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Conflict owner");
    const page = await signIn(people, browser, owner);
    const assistant = await assistants.create(page.request, { description: "Original description", name: "Conflict desk" });
    const { library } = await openAssistants(page);
    const editor = await openEditor(page, library, assistant);
    const description = editor.getByLabel("Description", { exact: true });
    await description.fill("My local draft");
    await expect(editor.getByText("Unsaved changes", { exact: true })).toBeVisible();

    // Another session of the owner saves first.
    const latestVersion = await assistants.revise(page.request, assistant.id, {
      description: "Changed in another session",
      name: "Conflict desk"
    });
    const save = editor.getByTestId("assistant-editor-save");
    await save.click();
    const conflict = editor.getByTestId("assistant-editor-conflict");
    await expect(conflict).toContainText("Your draft is kept");
    const latest = conflict.getByText(`Latest saved version: ${assistant.name}`);
    await expect(latest).toBeVisible();
    await latest.click();
    await expect(conflict).toContainText("Changed in another session");
    await expect(description).toHaveValue("My local draft");
    await expect(editor.getByText("Unsaved changes", { exact: true })).toBeVisible();

    await conflict.getByRole("button", { exact: true, name: "Keep my draft" }).click();
    await expect(conflict).toHaveCount(0);
    await save.click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    const saved = await readAssistant(page.request, assistant.id);
    expect(saved.content.description).toBe("My local draft");
    expect(saved.version).toBe(latestVersion + 1);
  });
});

test("unsaved edits of an existing Assistant are guarded on every exit from Studio · A-30", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Guard owner");
    const page = await signIn(people, browser, owner);
    const assistant = await assistants.create(page.request, { description: "Saved description", name: "Guarded desk" });
    const { library } = await openAssistants(page);
    const editor = await openEditor(page, library, assistant);
    const description = editor.getByLabel("Description", { exact: true });
    await description.fill("Unsaved guard draft");
    const confirmation = page.getByTestId("discard-changes-confirmation");
    const rail = page.getByRole("navigation", { exact: true, name: "Workspace" });
    const exits: readonly (readonly [string, () => Promise<void>])[] = [
      ["Cancel", () => editor.getByRole("button", { exact: true, name: "Cancel" }).click()],
      ["Back to Assistants", () => library.getByRole("button", { exact: true, name: "Back to Assistants" }).click()],
      ["another Studio section", () => library.getByRole("tab", { exact: true, name: "Files" }).click()],
      ["New chat", () => rail.getByRole("button", { exact: true, name: "New chat" }).click()],
      ["Chats", () => rail.getByRole("button", { exact: true, name: "Chats" }).click()],
      ["Projects", () => rail.getByRole("button", { exact: true, name: "Projects" }).click()],
      ["new chat shortcut", () => page.keyboard.press("Control+Shift+O")]
    ];
    for (const [label, exit] of exits) {
      await exit();
      await expect(confirmation, label).toBeVisible();
      const keep = confirmation.getByRole("button", { exact: true, name: "Keep editing" });
      await expect(keep, label).toBeFocused();
      await keep.click();
      await expect(confirmation, label).toHaveCount(0);
      await expect(description, label).toHaveValue("Unsaved guard draft");
      await expect(library.getByRole("tab", { exact: true, name: "Assistants" }), label).toHaveAttribute("aria-selected", "true");
    }
    const unloadBlocked = () => page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(await unloadBlocked(), "leaving the page asks first").toBe(true);

    await library.getByRole("button", { exact: true, name: "Back to Assistants" }).click();
    await confirmation.getByRole("button", { name: /Confirm discard/u }).click();
    await expect(editor).toHaveCount(0);
    await expect(library.getByTestId("assistant-gallery")).toBeVisible();
    expect(await unloadBlocked()).toBe(false);
    expect((await readAssistant(page.request, assistant.id)).content.description).toBe("Saved description");
  });
});

test("Save chat setup to Assistant writes the rows changed in a chat into the Assistant · scenario 9", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Setup owner");
    const page = await signIn(people, browser, owner);
    const assistant = await assistants.create(page.request, {
      name: "Setup keeper",
      rows: { tools: { policy: "adjustable", value: { mode: "inherit" } } }
    });
    const chatId = await assistants.createChat(page.request, { assistant: { assistantId: assistant.id } });
    // The chat turned Tools off for itself (the chip's own flow belongs to the chat suite).
    await assistants.bindChat(page.request, chatId, { assistantOverrides: { tools: { mode: "off" } } });
    const before = await readAssistant(page.request, assistant.id);
    const chatBefore = await readChat(page.request, chatId);
    expect(chatBefore.assistant?.state === "bound" && chatBefore.assistant.rows.tools.provenance).toBe("chat");

    await page.goto(`/c/${chatId}`);
    const selector = page.getByTestId("header-assistant-selector");
    await expect(selector).toHaveAttribute("data-state", "chosen");
    await selector.click();
    const menu = page.getByRole("menu", { name: "Assistant" });
    const adopt = menu.getByRole("menuitem", { name: /^Save chat setup to Assistant/u });
    await expect(adopt).toBeEnabled();
    await expect(adopt).toContainText("MCP changed for this chat");
    const adopted = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/me/assistants/${assistant.id}/adopt-chat-setup`);
    await adopt.click();
    expect((await adopted).status()).toBe(200);
    await expect(page.getByTestId("shell-notice")).toContainText(`Chat setup saved to ${assistant.name}.`);

    const after = await readAssistant(page.request, assistant.id);
    // Only the chat's row is written; its policy and every other row stay as they were.
    expect(after.content.rows).toEqual({
      ...before.content.rows,
      tools: { policy: "adjustable", value: { mode: "off" } }
    });
    expect(after.version).toBe(before.version! + 1);
    const chatAfter = await readChat(page.request, chatId);
    expect(chatAfter.assistant?.state === "bound" && chatAfter.assistant.rows.tools.provenance).toBe("assistant");

    await selector.click();
    const again = page.getByRole("menu", { name: "Assistant" }).getByRole("menuitem", { name: /^Save chat setup to Assistant/u });
    await expect(again).toBeDisabled();
    await expect(again).toContainText("Nothing changed for this chat");
  });
});
