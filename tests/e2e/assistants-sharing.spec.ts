import { PrismaClient } from "@prisma/client";
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import { runAccountMenuAction } from "./shell/page";
import { createAssistantFixture, type AssistantFixture, type E2EAssistant } from "./support/assistants";
import { captureState, type CaptureSize } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { createPeopleFixture, type E2EUser, type PeopleFixture } from "./support/people";
import { submitPasswordSignIn } from "./support/workspace";

/**
 * Sharing and administration of Assistants v2 with several people (PRD A-31,
 * A-32, A-33, A-34; scenarios 2 and 11). The flows a test is about go through
 * the Sharing sheet, Control Center › Assistants and the Assistant link;
 * everything else is prepared through the shared helpers. Every test creates
 * its own people and Assistants and removes them afterwards. No test sends a
 * message, so the seeded Workspace default does not matter here. Captures are
 * evidence for a visual review, not assertions.
 */

test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" } });
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

const DESKTOP = { viewport: { height: 900, width: 1440 } } as const;
const SHEET_SIZES: readonly CaptureSize[] = [
  { height: 900, width: 1440 },
  { height: 1024, width: 768 },
  { height: 844, width: 390 },
  { height: 390, width: 844 }
];
const PAGE_SIZES: readonly CaptureSize[] = [
  { height: 900, width: 1440 },
  { height: 844, width: 390 }
];
const LINK_UNAVAILABLE = "This Assistant isn't available to you.";

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

function exactPath(path: string): RegExp {
  return new RegExp(`^[^?#]*//[^/]+${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
}

function isPhone(size: CaptureSize): boolean {
  return size.width < 640 || size.height < 512;
}

// Studio › Assistants

/** Opens Studio › Assistants from a fresh new chat and waits until the list has loaded. */
async function openGallery(page: Page): Promise<Locator> {
  await page.goto("/");
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 30_000 });
  await runAccountMenuAction(page, "Assistants");
  const gallery = page.getByTestId("library-v2").getByTestId("assistant-gallery");
  await expect(gallery).toBeVisible();
  await expect(gallery.getByRole("status", { name: "Loading Assistants" })).toHaveCount(0, { timeout: 15_000 });
  return gallery;
}

function card(gallery: Locator, assistant: E2EAssistant): Locator {
  return gallery.getByTestId(`assistant-card-${assistant.id}`);
}

async function cardMenuAction(page: Page, gallery: Locator, assistant: E2EAssistant, action: string): Promise<void> {
  await card(gallery, assistant).getByRole("button", { exact: true, name: `More actions for ${assistant.name}` }).click();
  await page.getByRole("menu", { name: `Actions for ${assistant.name}` }).getByRole("menuitem", { exact: true, name: action }).click();
}

/** The Sharing sheet's panel, once its form has loaded. */
async function sharingSheet(page: Page, assistant: E2EAssistant): Promise<Locator> {
  const sheet = page.getByRole("dialog", { exact: true, name: `Sharing · ${assistant.name}` });
  await expect(sheet.getByRole("radio", { exact: true, name: "Only me" })).toBeVisible({ timeout: 15_000 });
  return sheet;
}

async function openSharing(page: Page, gallery: Locator, assistant: E2EAssistant): Promise<Locator> {
  await cardMenuAction(page, gallery, assistant, "Share…");
  return sharingSheet(page, assistant);
}

function radio(sheet: Locator, name: string): Locator {
  return sheet.getByRole("radio", { exact: true, name });
}

function saveButton(sheet: Locator): Locator {
  return sheet.getByRole("button", { exact: true, name: "Save" });
}

/** Saves and waits for the sheet to close, which happens once the list is refreshed. */
async function saveSharing(sheet: Locator): Promise<void> {
  await saveButton(sheet).click();
  await expect(sheet).toHaveCount(0, { timeout: 20_000 });
}

/** The sheet at every size: 600 px beside the page, full screen on phones in both orientations. */
async function captureSharing(page: Page, testInfo: TestInfo, name: string, sheet: Locator, sizes = SHEET_SIZES): Promise<void> {
  await captureState(page, testInfo, name, {
    atEachSize: async ({ size }) => {
      const label = `${name} ${size.width}x${size.height}`;
      const box = (await sheet.boundingBox())!;
      expect(Math.round(box.height), label).toBe(size.height);
      expect(Math.round(box.width), label).toBe(isPhone(size) ? size.width : 600);
      await expectWithinViewport(page, saveButton(sheet));
      await expectNoHorizontalOverflow(page);
    },
    sizes
  });
}

async function createSkill(request: APIRequestContext, name: string): Promise<{ id: string; name: string }> {
  const response = await request.post("/api/me/skills", {
    data: { description: "Synthetic sharing fixture", instructions: "Keep the response concise.", name }
  });
  expect(response.status(), await response.text()).toBe(201);
  const { skill } = await response.json() as { skill: { id: string; name: string } };
  return { id: skill.id, name: skill.name };
}

// Control Center › Assistants

async function openAdminAssistants(
  page: Page,
  options: Readonly<{ filter?: "requests"; resource?: string }> = {}
): Promise<Locator> {
  const query = new URLSearchParams({ section: "assistants" });
  if (options.filter) query.set("filter", options.filter);
  if (options.resource) query.set("resource", options.resource);
  await page.goto(`/admin?${query.toString()}`);
  const section = page.getByTestId("admin-assistants-section");
  if (options.resource) {
    // The review sheet is modal: the section behind it is inert and hidden from
    // the accessibility tree until the sheet closes, so only the sheet is reachable.
    await expect(reviewSheet(page)).toBeVisible({ timeout: 30_000 });
    return section;
  }
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expectFilterSelected(section, options.filter);
  return section;
}

async function expectFilterSelected(section: Locator, filter?: "requests"): Promise<void> {
  await expect(section.getByRole("button", { name: filter ? /^Requests/u : /^Listed for everyone/u }))
    .toHaveAttribute("aria-pressed", "true");
}

function reviewSheet(page: Page): Locator {
  return page.getByRole("dialog", { exact: true, name: "Review listing request" });
}

async function openReview(page: Page, section: Locator, requestId: string, assistant: E2EAssistant): Promise<Locator> {
  const row = section.getByTestId(`admin-assistant-request-${requestId}`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole("link", { exact: true, name: `Review ${assistant.name}` }).click();
  const sheet = reviewSheet(page);
  await expect(sheet.getByTestId("admin-assistant-review-status")).toBeVisible({ timeout: 15_000 });
  return sheet;
}

async function capturePage(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: Readonly<{ atEachSize?: (size: CaptureSize) => Promise<void>; sizes?: readonly CaptureSize[] }> = {}
): Promise<void> {
  await captureState(page, testInfo, name, {
    atEachSize: async ({ size }) => {
      await options.atEachSize?.(size);
      await expectNoHorizontalOverflow(page);
    },
    sizes: options.sizes ?? PAGE_SIZES
  });
}

// Stored state, read only after the interface has settled.

async function requestStates(assistantId: string): Promise<string[]> {
  const rows = await prisma.assistantListingRequest.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { state: true },
    where: { assistantId }
  });
  return rows.map((row) => row.state);
}

async function latestRequest(assistantId: string) {
  return prisma.assistantListingRequest.findFirstOrThrow({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { definitionVersion: true, id: true, reviewNote: true, state: true },
    where: { assistantId }
  });
}

async function publications(assistantId: string): Promise<{ featured: boolean; groupId: string | null; scope: string }[]> {
  const rows = await prisma.assistantPublication.findMany({
    orderBy: [{ scope: "asc" }, { groupId: "asc" }],
    select: { featuredOrder: true, groupId: true, scope: true },
    where: { assistantId }
  });
  return rows.map((row) => ({ featured: row.featuredOrder !== null, groupId: row.groupId, scope: row.scope }));
}

// Blank chat

/** A fresh new chat whose Assistants list has been read, so an absent strip pill is a real absence. */
async function openBlankChat(page: Page): Promise<void> {
  const listed = page.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname === "/api/me/assistants" && response.ok(),
  { timeout: 30_000 });
  await page.goto("/");
  await expect(page.getByRole("textbox", { exact: true, name: "Message" })).toBeVisible({ timeout: 30_000 });
  await listed;
}

function stripPill(page: Page, assistant: E2EAssistant): Locator {
  return page.getByTestId("assistant-strip").getByRole("button", { exact: true, name: assistant.name });
}

test("a listing request goes Pending, Withdrawn, Outdated after an edit, is approved, Featured in a colleague's empty chat and removed by Unlist · A-31 A-32 scenario 2", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Listing owner");
    const colleague = await people.user("Colleague");
    const admin = await people.admin("Reviewer");
    const ownerPage = await signIn(people, browser, owner);
    const colleaguePage = await signIn(people, browser, colleague);
    const adminPage = await signIn(people, browser, admin);
    const instructions = `Answer onboarding questions. Review marker ${people.suffix}.`;
    const assistant = await assistants.create(ownerPage.request, {
      description: "Answers onboarding questions.",
      name: "Onboarding guide",
      systemPrompt: instructions
    });

    // The owner asks to list it for everyone: Save sends a pending request.
    const gallery = await openGallery(ownerPage);
    let sheet = await openSharing(ownerPage, gallery, assistant);
    await expect(radio(sheet, "Only me")).toBeChecked();
    await expect(radio(sheet, "Everyone in this installation")).toHaveCount(0);
    const requestRadio = radio(sheet, "Request listing for everyone");
    await expect(requestRadio).toBeEnabled();
    await expect(requestRadio).toHaveAccessibleDescription(
      "An administrator reviews the Assistant, including its instructions, before it is listed."
    );
    await captureSharing(ownerPage, testInfo, "sharing-sheet-private", sheet);
    await requestRadio.check();
    await expect(sheet).toContainText("Save sends the request to an administrator.");
    await saveSharing(sheet);
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText("Sharing updated.");
    await expect.poll(() => requestStates(assistant.id)).toEqual(["pending"]);

    // Pending, then Withdraw: the request is withdrawn and the audience is Only me again.
    sheet = await openSharing(ownerPage, gallery, assistant);
    await expect(radio(sheet, "Request listing for everyone")).toBeChecked();
    await expect(sheet).toContainText(/Pending · Sent [^.]+\./u);
    await expect(sheet).not.toContainText("An administrator reviews it.");
    const withdraw = sheet.getByRole("button", { exact: true, name: "Withdraw request" });
    await expect(withdraw).toBeVisible();
    await captureSharing(ownerPage, testInfo, "sharing-sheet-pending-request", sheet);
    await withdraw.click();
    await expect(withdraw).toHaveCount(0, { timeout: 15_000 });
    await expect(radio(sheet, "Only me")).toBeChecked();
    await expect(sheet).not.toContainText("Pending ·");
    await expect.poll(() => requestStates(assistant.id)).toEqual(["withdrawn"]);

    // Requested again from the same sheet.
    await radio(sheet, "Request listing for everyone").check();
    await saveSharing(sheet);
    await expect.poll(() => requestStates(assistant.id)).toEqual(["withdrawn", "pending"]);
    const firstRequest = await latestRequest(assistant.id);

    // The administrator reviews the definition read-only: the note is the only field.
    let section = await openAdminAssistants(adminPage, { filter: "requests" });
    const firstRow = section.getByTestId(`admin-assistant-request-${firstRequest.id}`);
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    await expect(firstRow).toHaveAttribute("data-request-status", "pending");
    await expect(firstRow).toContainText(`By ${owner.displayName}`);
    await capturePage(adminPage, testInfo, "control-center-assistant-requests");
    let review = await openReview(adminPage, section, firstRequest.id, assistant);
    await expect(review.getByTestId("admin-assistant-review-status")).toHaveAttribute("data-request-status", "pending");
    await expect(review.getByTestId("admin-assistant-review-definition")).toBeVisible();
    await expect(review.getByTestId("admin-assistant-review-instructions")).toContainText(instructions);
    await expect(review.getByRole("textbox")).toHaveCount(1);
    await expect(review.getByRole("textbox", { name: /^Review note/u })).toBeEditable();
    await expect(review.getByRole("button", { exact: true, name: "Approve" })).toBeEnabled();
    await expect(review.getByRole("button", { exact: true, name: "Reject" })).toBeEnabled();
    await capturePage(adminPage, testInfo, "control-center-request-sheet-pending");
    await review.getByRole("button", { exact: true, name: "Close" }).click();
    await expect(review).toHaveCount(0);

    // The owner edits the Assistant: the pending request no longer matches the definition.
    await cardMenuAction(ownerPage, gallery, assistant, "Edit");
    const editor = ownerPage.getByTestId("library-v2").getByTestId("assistant-editor");
    await expect(editor.getByLabel("Name Required", { exact: true })).toHaveValue(assistant.name);
    await editor.getByLabel("Description", { exact: true }).fill("Answers onboarding and benefits questions.");
    await editor.getByTestId("assistant-editor-save").click();
    await expect(editor.getByTestId("assistant-library-notice")).toContainText("Saved. Future runs use these changes.");
    await expect.poll(async () => {
      const definition = await prisma.assistantDefinition.findUniqueOrThrow({ select: { version: true }, where: { id: assistant.id } });
      return definition.version > firstRequest.definitionVersion;
    }).toBe(true);

    // Outdated for the administrator: the row and the sheet say so, and nothing can be decided.
    section = await openAdminAssistants(adminPage, { filter: "requests" });
    await expect(firstRow).toHaveAttribute("data-request-status", "outdated", { timeout: 15_000 });
    await expect(firstRow).toContainText("Outdated");
    review = await openReview(adminPage, section, firstRequest.id, assistant);
    await expect(review.getByTestId("admin-assistant-review-status")).toHaveAttribute("data-request-status", "outdated");
    await expect(review.getByTestId("admin-assistant-review-unavailable")).toContainText(
      "The owner changed this Assistant after asking to list it"
    );
    await expect(review.getByTestId("admin-assistant-review-definition")).toHaveCount(0);
    await expect(review.getByRole("button", { exact: true, name: "Approve" })).toHaveCount(0);
    await expect(review.getByRole("button", { exact: true, name: "Reject" })).toHaveCount(0);
    await expect(review.getByRole("textbox")).toHaveCount(0);
    await capturePage(adminPage, testInfo, "control-center-request-sheet-outdated");
    await review.getByRole("button", { exact: true, name: "Close" }).click();
    await expect(review).toHaveCount(0);

    // The owner sees Outdated in Sharing (opened from the editor) and sends a fresh request.
    await editor.getByRole("button", { exact: true, name: "Manage sharing…" }).click();
    sheet = await sharingSheet(ownerPage, assistant);
    await expect(sheet).toContainText(
      "Outdated · Your Assistant changed since the request. Choose this option and save to send it again."
    );
    await expect(radio(sheet, "Only me")).toBeChecked();
    await radio(sheet, "Request listing for everyone").check();
    await saveSharing(sheet);
    await expect.poll(() => requestStates(assistant.id)).toEqual(["withdrawn", "superseded", "pending"]);
    const freshRequest = await latestRequest(assistant.id);
    expect(freshRequest.id).not.toBe(firstRequest.id);

    // The administrator approves the fresh request; the superseded one is gone from the list.
    section = await openAdminAssistants(adminPage, { filter: "requests" });
    await expect(section.getByTestId(`admin-assistant-request-${freshRequest.id}`)).toHaveAttribute("data-request-status", "pending", { timeout: 15_000 });
    await expect(firstRow).toHaveCount(0);
    review = await openReview(adminPage, section, freshRequest.id, assistant);
    await expect(review.getByTestId("admin-assistant-review-definition")).toBeVisible();
    await review.getByRole("button", { exact: true, name: "Approve" }).click();
    await expect(review.getByRole("status")).toContainText(`${assistant.name} is now listed for everyone.`, { timeout: 15_000 });
    await expect(review.getByRole("button", { exact: true, name: "Feature it" })).toBeVisible();
    await review.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(() => requestStates(assistant.id)).toEqual(["withdrawn", "superseded", "approved"]);
    await expect.poll(() => publications(assistant.id)).toEqual([{ featured: false, groupId: null, scope: "installation" }]);

    // A colleague who shares no group with the owner finds it under Shared.
    let colleagueGallery = await openGallery(colleaguePage);
    await colleagueGallery.getByRole("button", { name: /^Shared \d+$/u }).click();
    const colleagueCard = card(colleagueGallery, assistant);
    await expect(colleagueCard).toBeVisible();
    await expect(colleagueCard).toContainText(`By ${owner.displayName}`);
    await expect(colleagueCard.getByRole("button", { exact: true, name: `Start chat with ${assistant.name}` })).toBeEnabled();

    // The administrator turns Featured on in the listed view.
    section = await openAdminAssistants(adminPage);
    const listedRow = section.getByTestId(`admin-assistant-row-${assistant.id}`);
    await expect(listedRow).toBeVisible({ timeout: 15_000 });
    await expect(listedRow).toContainText(`By ${owner.displayName}`);
    const featured = listedRow.getByRole("radiogroup", { exact: true, name: `Featured: ${assistant.name}` });
    await expect(featured.getByRole("radio", { exact: true, name: "Off" })).toHaveAttribute("aria-checked", "true");
    await featured.getByRole("radio", { exact: true, name: "On" }).click();
    await expect(listedRow).toHaveAttribute("data-featured-order", /^\d+$/u, { timeout: 15_000 });
    await expect(featured.getByRole("radio", { exact: true, name: "On" })).toHaveAttribute("aria-checked", "true");
    await expect(listedRow.getByTestId("admin-assistant-featured-position")).toBeVisible();
    await expect.poll(() => publications(assistant.id)).toEqual([{ featured: true, groupId: null, scope: "installation" }]);
    // Open takes the administrator, by keyboard, to the Assistant's detail sheet in Studio.
    const open = listedRow.getByRole("link", { exact: true, name: `Open ${assistant.name}` });
    await expect(open).toHaveAttribute("data-testid", "admin-assistant-open");
    await expect(open).toHaveAttribute("href", `/?library=assistants&assistant=${assistant.id}`);
    await expect(open).not.toHaveAttribute("target", /.+/u);
    await capturePage(adminPage, testInfo, "control-center-assistants-listed", {
      atEachSize: async (size) => {
        await expectWithinViewport(adminPage, open);
        await expect(open, `${size.width}x${size.height}`).toBeVisible();
      }
    });
    await open.focus();
    await adminPage.keyboard.press("Enter");
    const detail = adminPage.getByRole("dialog", { exact: true, name: assistant.name });
    await expect(detail.getByTestId("assistant-detail")).toBeVisible({ timeout: 30_000 });
    await expect(detail).toContainText(`By ${owner.displayName}`);
    await expect(adminPage).toHaveURL(exactPath("/"));
    // Back to the section; the Assistant is still listed and Featured.
    section = await openAdminAssistants(adminPage);
    await expect(listedRow).toHaveAttribute("data-featured-order", /^\d+$/u, { timeout: 15_000 });

    // The colleague's empty chat offers it in the strip.
    await openBlankChat(colleaguePage);
    await expect(stripPill(colleaguePage, assistant)).toBeVisible({ timeout: 15_000 });
    await capturePage(colleaguePage, testInfo, "colleague-empty-chat-featured-strip");

    // Unlist names what it removes, then takes it off the listed view.
    await listedRow.getByRole("button", { exact: true, name: `More actions for ${assistant.name}` }).click();
    await adminPage.getByRole("menuitem", { exact: true, name: "Unlist…" }).click();
    const confirmation = adminPage.getByTestId("admin-confirm-unlist-assistant");
    const dialog = confirmation.getByRole("dialog", { exact: true, name: `Unlist ${assistant.name}` });
    await expect(dialog).toContainText(`Unlist ${assistant.name}?`);
    await expect(dialog).toContainText(`${assistant.name} will be removed from everyone's Assistants list and from Featured.`);
    await capturePage(adminPage, testInfo, "control-center-unlist-confirmation");
    await dialog.getByRole("button", { exact: true, name: "Confirm unlist" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(listedRow).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => publications(assistant.id)).toEqual([]);

    // Gone from the colleague's strip and gallery.
    await openBlankChat(colleaguePage);
    await expect(stripPill(colleaguePage, assistant)).toHaveCount(0);
    colleagueGallery = await openGallery(colleaguePage);
    await expect(card(colleagueGallery, assistant)).toHaveCount(0);
  });
});

test("a rejection with a note reaches the owner's Sharing sheet, and the review stays open across a reload · A-31", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Rejected owner");
    const admin = await people.admin("Strict reviewer");
    const ownerPage = await signIn(people, browser, owner);
    const adminPage = await signIn(people, browser, admin);
    const assistant = await assistants.create(ownerPage.request, { description: "Drafts policy answers.", name: "Policy drafter" });
    const { requestId } = await assistants.requestListing(ownerPage.request, assistant.id);

    // The request is a Control Center resource: its address opens the sheet, also after a reload.
    const section = await openAdminAssistants(adminPage, { filter: "requests", resource: requestId });
    const review = reviewSheet(adminPage);
    await expect(review.getByTestId("admin-assistant-review-definition")).toBeVisible({ timeout: 15_000 });
    await adminPage.reload();
    await expect(review.getByTestId("admin-assistant-review-definition")).toBeVisible({ timeout: 30_000 });
    expect(new URL(adminPage.url()).searchParams.get("resource")).toBe(requestId);

    const note = `Narrow the instructions to one policy area ${people.suffix}.`;
    await review.getByRole("textbox", { name: /^Review note/u }).fill(note);
    await review.getByRole("button", { exact: true, name: "Reject" }).click();
    await expect(review.getByRole("status")).toContainText("Request rejected. The owner can read your note in Sharing.", { timeout: 15_000 });
    await expect(review.getByTestId("admin-assistant-review-status")).toHaveAttribute("data-request-status", "rejected");
    await review.getByRole("button", { exact: true, name: "Done" }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(() => new URL(adminPage.url()).searchParams.get("resource")).toBeNull();
    // Closed, the sheet leaves the section reachable again, still on its Requests filter.
    await expectFilterSelected(section, "requests");
    expect(new URL(adminPage.url()).searchParams.get("filter")).toBe("requests");
    await expect.poll(async () => {
      const request = await latestRequest(assistant.id);
      return { note: request.reviewNote, state: request.state };
    }).toEqual({ note, state: "rejected" });

    // The owner reads the decision and the note, and can ask again.
    const gallery = await openGallery(ownerPage);
    const sheet = await openSharing(ownerPage, gallery, assistant);
    await expect(sheet).toContainText(/Rejected · Reviewed .+\./u);
    await expect(sheet).toContainText(`Reviewer's note: ${note}`);
    await expect(sheet).toContainText("Choose this option and save to send it again.");
    await expect(radio(sheet, "Only me")).toBeChecked();
    await expect(radio(sheet, "Request listing for everyone")).toBeEnabled();
    await captureSharing(ownerPage, testInfo, "sharing-sheet-rejected-note", sheet);
  });
});

test("sharing with one group reaches its member only, and narrowing back to Only me names the group before removing it · PRD 10.4", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const team = await people.group("Sharing team");
    const elsewhere = await people.group("Other team");
    const owner = await people.user("Group owner", { groups: [team] });
    const member = await people.user("Team member", { groups: [team] });
    const outsider = await people.user("Outsider", { groups: [elsewhere] });
    const ownerPage = await signIn(people, browser, owner);
    const memberPage = await signIn(people, browser, member);
    const outsiderPage = await signIn(people, browser, outsider);
    const assistant = await assistants.create(ownerPage.request, { description: "Answers team questions.", name: "Team desk" });

    const gallery = await openGallery(ownerPage);
    let sheet = await openSharing(ownerPage, gallery, assistant);
    await radio(sheet, "Selected groups").check();
    await expect(sheet).toContainText("Choose at least one group, or choose Only me.");
    await expect(saveButton(sheet)).toBeDisabled();
    const teamBox = sheet.getByRole("checkbox", { exact: true, name: team.name });
    await expect(teamBox).toHaveAccessibleDescription("2 people");
    await expect(sheet.getByRole("checkbox", { exact: true, name: elsewhere.name })).toHaveCount(0);
    await teamBox.check();
    await expect(saveButton(sheet)).toBeEnabled();
    await captureSharing(ownerPage, testInfo, "sharing-sheet-groups", sheet);
    await saveSharing(sheet);
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText("Sharing updated.");
    await expect(card(gallery, assistant)).toContainText("Yours · 1 group ·");
    await expect.poll(() => publications(assistant.id)).toEqual([{ featured: false, groupId: team.id, scope: "group" }]);

    const memberGallery = await openGallery(memberPage);
    await memberGallery.getByRole("button", { name: /^Shared \d+$/u }).click();
    await expect(card(memberGallery, assistant)).toContainText(`By ${owner.displayName}`);
    const outsiderGallery = await openGallery(outsiderPage);
    await expect(card(outsiderGallery, assistant)).toHaveCount(0);

    // Narrowing lists what Save takes away before it happens.
    sheet = await openSharing(ownerPage, gallery, assistant);
    await expect(radio(sheet, "Selected groups")).toBeChecked();
    await expect(sheet.getByRole("checkbox", { exact: true, name: team.name })).toBeChecked();
    await expect(sheet.getByRole("listitem").filter({ hasText: "Saving stops sharing" })).toHaveCount(0);
    await radio(sheet, "Only me").check();
    await expect(sheet.getByRole("listitem").filter({ hasText: "Saving stops sharing" }))
      .toHaveText(`Saving stops sharing it with ${team.name}.`);
    await captureSharing(ownerPage, testInfo, "sharing-sheet-narrowing-consequences", sheet);
    await saveSharing(sheet);
    await expect(card(gallery, assistant)).toContainText("Yours · Only you");
    await expect.poll(() => publications(assistant.id)).toEqual([]);

    const memberAfter = await openGallery(memberPage);
    await expect(card(memberAfter, assistant)).toHaveCount(0);
  });
});

test("the Assistant link from Sharing starts a chat with it for a group member, also after signing in, and lands an outsider on / with the neutral notice · A-34 scenario 11", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const team = await people.group("Link team");
    const owner = await people.user("Link owner", { groups: [team] });
    const member = await people.user("Link member", { groups: [team] });
    const outsider = await people.user("Link outsider");
    const ownerPage = await signIn(people, browser, owner);
    const assistant = await assistants.create(ownerPage.request, { description: "Answers questions about the release.", name: "Release helper" });
    await assistants.publish(ownerPage.request, assistant.id, { groupId: team.id });

    // The owner copies the link from Sharing.
    const gallery = await openGallery(ownerPage);
    const sheet = await openSharing(ownerPage, gallery, assistant);
    const field = sheet.getByRole("textbox", { exact: true, name: "Assistant link" });
    const link = `${new URL(ownerPage.url()).origin}/assistant/${assistant.id}`;
    await expect(field).toHaveValue(link);
    await expect(sheet.getByRole("button", { exact: true, name: "Copy link" })).toBeVisible();
    await sheet.getByRole("button", { exact: true, name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);

    const expectChosen = async (page: Page) => {
      await expect(page).toHaveURL(exactPath("/"), { timeout: 30_000 });
      const selector = page.getByTestId("header-assistant-selector");
      await expect(selector).toHaveAttribute("data-state", "chosen", { timeout: 20_000 });
      await expect(selector).toHaveAccessibleName(`Assistant: ${assistant.name}`);
      const intro = page.getByTestId("assistant-blank-intro");
      await expect(intro).toContainText(assistant.name);
      await expect(intro).toContainText(`By ${owner.displayName}`);
    };

    // A member of the group lands in a new chat with the Assistant chosen.
    const memberPage = await signIn(people, browser, member);
    await memberPage.goto(link);
    await expectChosen(memberPage);
    await capturePage(memberPage, testInfo, "assistant-link-member-chat");

    // Someone outside the group lands on their own new chat with one neutral notice.
    const outsiderPage = await signIn(people, browser, outsider);
    await outsiderPage.goto(link);
    await expect(outsiderPage.getByTestId("shell-notice")).toContainText(LINK_UNAVAILABLE, { timeout: 30_000 });
    await expect(outsiderPage).toHaveURL(exactPath("/"));
    await expect(outsiderPage.getByTestId("header-assistant-selector")).toHaveAttribute("data-state", "empty");
    await expect(outsiderPage.getByTestId("assistant-blank-intro")).toHaveCount(0);
    await expect(outsiderPage.getByText(assistant.name)).toHaveCount(0);

    // A signed-out member goes through sign-in and arrives in the chat with the Assistant.
    const signedOut = await browser.newContext({ ...DESKTOP, locale: "en-US", reducedMotion: "reduce" });
    try {
      const page = await signedOut.newPage();
      await page.goto(link);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=.*assistant.*${assistant.id}`, "u"), { timeout: 30_000 });
      await submitPasswordSignIn(page, member);
      await expectChosen(page);
    } finally {
      await signedOut.close();
    }
  });
});

test("publishing to a group with a Skill that lacks an approved revision shows the error at that group and publishes nothing · A-33", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  await withFixtures(async ({ assistants, people }) => {
    const team = await people.group("Skill team");
    const owner = await people.user("Skill owner", { groups: [team] });
    const ownerPage = await signIn(people, browser, owner);
    // Created by the owner through the API: private, with no approved (shared) revision.
    const skill = await createSkill(ownerPage.request, `Unshared checklist ${people.suffix}`);
    const assistant = await assistants.create(ownerPage.request, {
      name: "Checklist runner",
      rows: { skills: { policy: "fixed", value: { links: [{ delivery: "always", skillId: skill.id }], mode: "auto" } } }
    });

    const gallery = await openGallery(ownerPage);
    const sheet = await openSharing(ownerPage, gallery, assistant);
    await expect(sheet.getByRole("region", { name: "People you share with need access to" })).toContainText(`Skill “${skill.name}”`);
    await radio(sheet, "Selected groups").check();
    const teamBox = sheet.getByRole("checkbox", { exact: true, name: team.name });
    await teamBox.check();
    await saveButton(sheet).click();

    // The sheet stays open, says what was not applied and marks the group with the Skill's name.
    await expect(sheet.getByRole("alert")).toContainText(
      "Not everything was saved. The changes marked below were not applied; the rest is saved.",
      { timeout: 20_000 }
    );
    await expect(teamBox).toHaveAttribute("aria-invalid", "true");
    // Named with the group it has to reach, in the sheet's own terms.
    const skillError = `Share the Skill “${skill.name}” with ${team.name} first, then save again.`;
    await expect(teamBox).toHaveAccessibleDescription(`1 person ${skillError}`);
    await expect(sheet).toContainText(skillError);
    await expect(sheet.getByRole("alert")).toBeFocused();
    expect(await publications(assistant.id)).toEqual([]);
    await captureSharing(ownerPage, testInfo, "sharing-sheet-group-skill-error", sheet, PAGE_SIZES);
  });
});

test("an administrator lists their own Assistant for everyone with Featured from Sharing, and Only me names the loss of both · PRD 10.4", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  await withFixtures(async ({ assistants, people }) => {
    const admin = await people.admin("Listing admin");
    const page = await signIn(people, browser, admin);
    const assistant = await assistants.create(page.request, { description: "Answers questions for everyone.", name: "Front desk" });

    const gallery = await openGallery(page);
    let sheet = await openSharing(page, gallery, assistant);
    const everyone = radio(sheet, "Everyone in this installation");
    await expect(everyone).toHaveAccessibleDescription("You are an administrator: listed right away.");
    await expect(radio(sheet, "Request listing for everyone")).toHaveCount(0);
    await expect(sheet.getByRole("switch", { exact: true, name: "Featured" })).toHaveCount(0);
    await everyone.check();
    const featured = sheet.getByRole("switch", { exact: true, name: "Featured" });
    await expect(featured).toHaveAttribute("aria-checked", "false");
    await featured.click();
    await expect(featured).toHaveAttribute("aria-checked", "true");
    await expect(sheet).toContainText(/Position \d+ of \d+/u);
    await captureSharing(page, testInfo, "sharing-sheet-admin-featured", sheet);
    await saveSharing(sheet);
    await expect(gallery.getByTestId("assistant-gallery-notice")).toContainText("Sharing updated.");
    await expect.poll(() => publications(assistant.id)).toEqual([{ featured: true, groupId: null, scope: "installation" }]);
    await expect(gallery.getByRole("region", { name: "Featured" }).getByTestId(`assistant-card-${assistant.id}`)).toBeVisible();

    sheet = await openSharing(page, gallery, assistant);
    await expect(radio(sheet, "Everyone in this installation")).toBeChecked();
    await expect(sheet.getByRole("switch", { exact: true, name: "Featured" })).toHaveAttribute("aria-checked", "true");
    await radio(sheet, "Only me").check();
    await expect(sheet.getByRole("listitem").filter({ hasText: "Saving removes" }))
      .toHaveText("Saving removes it from everyone in this installation and from Featured.");
    await captureSharing(page, testInfo, "sharing-sheet-admin-narrowing-consequences", sheet, PAGE_SIZES);
    await saveSharing(sheet);
    await expect.poll(() => publications(assistant.id)).toEqual([]);
    await expect(card(gallery, assistant)).toContainText("Yours · Only you");
  });
});

test("a non-administrator is offered a listing request instead of Everyone and cannot reach Control Center › Assistants · PRD 9.4 10.4", async ({ browser }) => {
  test.setTimeout(180_000);
  await withFixtures(async ({ assistants, people }) => {
    const owner = await people.user("Plain owner");
    const page = await signIn(people, browser, owner);
    const assistant = await assistants.create(page.request, { name: "Plain helper" });

    const gallery = await openGallery(page);
    const sheet = await openSharing(page, gallery, assistant);
    await expect(sheet.getByRole("radio")).toHaveCount(3);
    await expect(radio(sheet, "Only me")).toBeVisible();
    await expect(radio(sheet, "Selected groups")).toBeVisible();
    await expect(radio(sheet, "Request listing for everyone")).toBeVisible();
    await expect(radio(sheet, "Everyone in this installation")).toHaveCount(0);
    await expect(sheet).not.toContainText("You are an administrator");
    await radio(sheet, "Request listing for everyone").check();
    await expect(sheet.getByRole("switch", { exact: true, name: "Featured" })).toHaveCount(0);

    // Leaving with the unsaved choice asks first; discarding sends nothing.
    await sheet.getByRole("button", { exact: true, name: "Cancel" }).click();
    const discard = page.getByTestId("discard-changes-confirmation");
    await expect(discard.getByRole("heading", { name: "Discard sharing changes?" })).toBeVisible();
    await discard.getByRole("button", { exact: true, name: "Confirm discard changes" }).click();
    await expect(sheet).toHaveCount(0);
    expect(await requestStates(assistant.id)).toEqual([]);

    const api = await page.request.get("/api/admin/assistants?state=requests");
    expect(api.status()).toBe(403);
    await page.goto("/admin?section=assistants&filter=requests");
    await expect(page.getByTestId("admin-denied")).toContainText("Admin access required");
    await expect(page.getByTestId("admin-assistants-section")).toHaveCount(0);
  });
});
