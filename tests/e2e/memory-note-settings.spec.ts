import { expect, test, type Page, type Route } from "@playwright/test";
import type { MemoryLegacySuggestion, MemoryNote, MemorySwitches } from "../../lib/contracts/memoryNote";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { captureState } from "./support/capture";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

// Settings › Memory over mocked owner routes (`app/api/me/memory/{note,preferences,legacy}`): the note, its switches and
// the earlier automatic memories. The server state lives in this fixture, so a reload shows what was saved.
const sizes = [{ width: 1440, height: 900 }, { width: 820, height: 1180 }, { width: 390, height: 844 }];
const updatedAt = "2026-11-22T10:00:00.000Z";

test.setTimeout(240_000);

type Server = {
  note: MemoryNote;
  switches: MemorySwitches;
  legacy: MemoryLegacySuggestion[];
  writes: Array<Readonly<{ method: string; path: string; body: unknown }>>;
  /** Changes the note behind the editor's back, as a chat's change would. */
  changeElsewhere(text: string): void;
};

async function prepare(page: Page, initial: Partial<Pick<Server, "note" | "legacy">> = {}): Promise<Server> {
  const server: Server = {
    note: initial.note ?? { text: "", revision: 0, lastChangedBy: null, updatedAt: null },
    switches: { memoryEnabled: true, pastChatSearchEnabled: true, memorySuggestionsEnabled: true },
    legacy: initial.legacy ?? [],
    writes: [],
    changeElsewhere(text) {
      server.note = { text, revision: server.note.revision + 1, lastChangedBy: "agent", updatedAt };
    }
  };
  const record = (route: Route) => {
    const request = route.request();
    server.writes.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() as unknown });
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMatrixCatalogFixture(page, { chats: [], folders: [] });
  await page.route("**/api/me/memory/note", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: server.note });
    record(route);
    const update = route.request().postDataJSON() as { text: string; revision: number };
    if (update.revision !== server.note.revision) return route.fulfill({ status: 409, json: { error: "memory_note_conflict" } });
    server.note = { text: update.text, revision: server.note.revision + 1, lastChangedBy: "user", updatedAt };
    return route.fulfill({ json: server.note });
  });
  await page.route("**/api/me/memory/preferences", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: server.switches });
    record(route);
    server.switches = { ...server.switches, ...(route.request().postDataJSON() as Partial<MemorySwitches>) };
    return route.fulfill({ json: server.switches });
  });
  await page.route(/\/api\/me\/memory\/legacy(?:\/[^/?]+)?(?:\?.*)?$/u, (route) => {
    const request = route.request();
    const id = /\/legacy\/([^/?]+)/u.exec(new URL(request.url()).pathname)?.[1] ?? null;
    if (request.method() === "GET") return route.fulfill({ json: { suggestions: server.legacy, nextCursor: null } });
    record(route);
    if (request.method() === "DELETE") {
      server.legacy = [];
      return route.fulfill({ status: 204, body: "" });
    }
    const item = server.legacy.find((entry) => entry.id === id);
    if (!item) return route.fulfill({ status: 404, json: { error: "memory_legacy_suggestion_not_found" } });
    server.legacy = server.legacy.filter((entry) => entry.id !== id);
    if ((request.postDataJSON() as { action: string }).action === "remove") return route.fulfill({ status: 204, body: "" });
    server.note = { text: server.note.text ? `${server.note.text}\n${item.text}` : item.text, revision: server.note.revision + 1,
      lastChangedBy: "user", updatedAt };
    return route.fulfill({ json: server.note });
  });
  await signInWithLocalToken(page, "/?library=memory");
  await expect(page.getByTestId("settings-memory")).toBeVisible({ timeout: 30_000 });
  return server;
}

const editor = (page: Page) => page.getByRole("textbox", { name: "Memory note" });

/** Opens Settings › Memory again from its address, as a reload of the page would: Settings does not keep `?library=` in the address. */
async function reopen(page: Page): Promise<void> {
  await page.goto("/?library=memory");
  await expect(page.getByTestId("settings-memory")).toBeVisible({ timeout: 30_000 });
}

test("the note is edited and saved as one text, and every control stays reachable at every size in both themes", async ({ page }, info) => {
  const server = await prepare(page);
  const section = page.getByTestId("settings-memory");
  await expect(section.getByText(/Nothing here yet/u)).toBeVisible();
  await captureState(page, info, "memory-note-empty", { anchor: editor(page), sizes, atEachSize: async () => {
    await expectWithinViewport(page, editor(page));
    await expectNoHorizontalOverflow(page);
  } });

  await editor(page).fill("I work on the billing team.\nAnswer in short bullet points.");
  await expect(section.getByTestId("memory-note-counter")).toHaveText("58 / 6,000 characters");
  await editor(page).press("ControlOrMeta+s");
  await expect(section.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect(server.writes).toEqual([{ method: "PUT", path: "/api/me/memory/note",
    body: { text: "I work on the billing team.\nAnswer in short bullet points.", revision: 0 } }]);

  await reopen(page);
  await expect(editor(page)).toHaveValue("I work on the billing team.\nAnswer in short bullet points.");
  await expect(section.getByRole("button", { name: "Save" })).toBeDisabled();
  await captureState(page, info, "memory-note-saved", { anchor: section.getByRole("button", { name: "Save" }), sizes, atEachSize: async () => {
    await expectWithinViewport(page, section.getByRole("button", { name: "Save" }));
    await expectWithinViewport(page, section.getByRole("switch", { name: "Use Memory in answers" }));
    await expectNoHorizontalOverflow(page);
  } });
});

test("a save over a stale revision keeps the user's text beside the saved note", async ({ page }, info) => {
  const server = await prepare(page, { note: { text: "Answer briefly.", revision: 4, lastChangedBy: "user", updatedAt } });
  await expect(editor(page)).toHaveValue("Answer briefly.");
  server.changeElsewhere("Answer briefly.\nUse metric units.");
  await editor(page).fill("Answer briefly and in Russian.");
  await page.getByRole("button", { name: "Save" }).click();
  const conflict = page.getByTestId("memory-note-conflict");
  await expect(conflict).toContainText("The note changed elsewhere");
  await expect(editor(page)).toHaveValue("Answer briefly and in Russian.");
  await conflict.getByText("Saved note", { exact: true }).click();
  await expect(conflict.getByLabel("Saved note")).toContainText("Use metric units.");
  await captureState(page, info, "memory-note-conflict", { anchor: conflict, sizes, atEachSize: async () => {
    await expectWithinViewport(page, conflict.getByRole("button", { name: "Keep my text and save over it" }));
    await expectNoHorizontalOverflow(page);
  } });
  await conflict.getByRole("button", { name: "Keep my text and save over it" }).click();
  await expect(conflict).toHaveCount(0);
  expect(server.note).toMatchObject({ text: "Answer briefly and in Russian.", revision: 6 });
});

test("the switches persist, and Memory off disables the two that depend on it", async ({ page }) => {
  const server = await prepare(page);
  const search = page.getByRole("switch", { name: "Search past chats" });
  await search.click();
  await expect(search).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Use Memory in answers" }).click();
  await expect(page.getByRole("switch", { name: "Use Memory in answers" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Offer to remember" })).toBeDisabled();
  expect(server.writes.map((write) => write.body)).toEqual([{ pastChatSearchEnabled: false }, { memoryEnabled: false }]);
  await reopen(page);
  await expect(page.getByRole("switch", { name: "Use Memory in answers" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Search past chats" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Offer to remember" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/Memory is off, so answers do not read the note/u)).toBeVisible();
});

test("an earlier automatic memory is kept into the note or removed, and the section leaves with the last one", async ({ page }, info) => {
  const legacy: MemoryLegacySuggestion[] = [
    { id: "legacy-1", text: "Works on the billing team.", origin: "automatic", createdAt: "2026-09-01T10:00:00.000Z" },
    { id: "legacy-2", text: "Asked about a dentist in March.", origin: "automatic", createdAt: "2026-09-02T10:00:00.000Z" },
    { id: "legacy-3", text: "Prefers tables for price comparisons, with model, price, shop and rating columns in that order.",
      origin: "saved_overflow", createdAt: "2026-09-03T10:00:00.000Z" }
  ];
  const server = await prepare(page, { note: { text: "Answer briefly.", revision: 1, lastChangedBy: "user", updatedAt }, legacy });
  const section = page.getByTestId("memory-legacy-suggestions");
  await expect(section.getByRole("heading", { name: "Earlier memories (3)" })).toBeVisible();
  await captureState(page, info, "memory-legacy", { anchor: section, sizes, atEachSize: async () => {
    await expectWithinViewport(page, section.getByRole("button", { name: "Keep in note: Works on the billing team." }));
    await expectNoHorizontalOverflow(page);
  } });
  await section.getByRole("button", { name: "Keep in note: Works on the billing team." }).click();
  await expect(editor(page)).toHaveValue("Answer briefly.\nWorks on the billing team.");
  await section.getByRole("button", { name: "Remove: Asked about a dentist in March." }).click();
  await expect(section.getByTestId("memory-legacy-row")).toHaveCount(1);
  await section.getByRole("button", { name: "Remove all" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove all earlier memories?" });
  await dialog.getByRole("button", { name: "Confirm remove all" }).click();
  await expect(section).toHaveCount(0);
  expect(server.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
    "POST /api/me/memory/legacy/legacy-1", "POST /api/me/memory/legacy/legacy-2", "DELETE /api/me/memory/legacy"
  ]);
});

test("clearing the note asks first and names the consequence", async ({ page }) => {
  const server = await prepare(page, { note: { text: "Answer briefly.", revision: 2, lastChangedBy: "user", updatedAt } });
  const clear = page.getByRole("button", { name: "Clear note…" });
  await clear.click();
  const dialog = page.getByRole("dialog", { name: "Clear your note?" });
  await expect(dialog).toContainText("Answers stop using everything in it from your next message.");
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(clear).toBeFocused();
  expect(server.writes).toEqual([]);
  await clear.click();
  await page.getByRole("dialog", { name: "Clear your note?" }).getByRole("button", { name: "Confirm clear note" }).click();
  await expect(editor(page)).toHaveValue("");
  expect(server.note).toMatchObject({ text: "", revision: 3 });
});
