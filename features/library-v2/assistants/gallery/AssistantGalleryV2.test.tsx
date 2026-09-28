import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantGalleryView, LibraryNotice } from "@/components/assistants/libraryViewContracts";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { assistantSummary } from "@/tests/support/assistantLibraryFixtures";
import { AssistantGalleryV2, ASSISTANTS_DESCRIPTION } from "./AssistantGalleryV2";

function gallery(assistants: AssistantSummary[], overrides: Partial<AssistantGalleryView> = {}): AssistantGalleryView {
  return {
    assistants,
    onArchiveToggle: vi.fn(),
    onCopyLink: vi.fn(async () => true),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onEdit: vi.fn(),
    onOpenDetail: vi.fn(),
    onPinToggle: vi.fn(),
    onShare: vi.fn(),
    onStartChat: vi.fn(async () => true),
    recentAssistantIds: [],
    viewer: { canPublishInstallation: false, defaultAssistantId: null },
    ...overrides
  };
}

function renderGallery(view: AssistantGalleryView | null, props: Partial<Parameters<typeof AssistantGalleryV2>[0]> = {}) {
  const handlers = { onFromCurrentChat: vi.fn(), onNewAssistant: vi.fn(), onRetry: vi.fn() };
  render(
    <AssistantGalleryV2
      busy={false}
      catalogError={null}
      catalogState="ready"
      gallery={view}
      notice={null}
      onDismissNotice={vi.fn()}
      {...handlers}
      {...props}
    />
  );
  return handlers;
}

const list = [
  assistantSummary({ featured: true, featuredOrder: 1, id: "featured-b", name: "Beta desk", owned: false, ownerDisplayName: "Ada", scope: { kind: "installation" }, updatedAt: "2026-09-02T00:00:00.000Z" }),
  assistantSummary({ featured: true, featuredOrder: 0, id: "featured-a", name: "Alpha desk", owned: false, ownerDisplayName: "Ada", scope: { kind: "installation" }, updatedAt: "2026-09-01T00:00:00.000Z" }),
  assistantSummary({ id: "pinned", name: "Pinned writer", pinned: true, updatedAt: "2026-09-03T00:00:00.000Z" }),
  assistantSummary({ category: "writing", description: "Edits briefs", id: "old", name: "Older helper", updatedAt: "2026-08-01T00:00:00.000Z" }),
  assistantSummary({ id: "new", name: "Newer helper", ownerDisplayName: "Dana Ops", updatedAt: "2026-09-10T00:00:00.000Z" }),
  assistantSummary({ archived: true, availability: { ok: false, reason: "archived" }, id: "archived", name: "Retired helper" })
];

function chip(name: string) {
  return within(screen.getByRole("group", { name: "Filter Assistants" })).getByRole("button", { name: new RegExp(`^${name} \\d+$`, "u") });
}

describe("Assistants gallery", () => {
  it("heads the section with its one-sentence description and New assistant", () => {
    const handlers = renderGallery(gallery(list));
    expect(screen.getByRole("heading", { level: 2, name: "Assistants" })).toBeInTheDocument();
    expect(screen.getByText(ASSISTANTS_DESCRIPTION)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New assistant" }));
    expect(handlers.onNewAssistant).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Import/u })).not.toBeInTheDocument();
  });

  it("counts every chip over the list it shows, with All excluding archived", () => {
    renderGallery(gallery(list));
    expect(chip("All")).toHaveTextContent("All 5");
    expect(chip("Pinned")).toHaveTextContent("Pinned 1");
    expect(chip("Yours")).toHaveTextContent("Yours 3");
    expect(chip("Shared")).toHaveTextContent("Shared 2");
    expect(chip("Featured")).toHaveTextContent("Featured 2");
    expect(chip("Archived")).toHaveTextContent("Archived 1");
    expect(screen.queryByText("Retired helper")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Assistants" }), { target: { value: "helper" } });
    expect(chip("All")).toHaveTextContent("All 2");
    expect(chip("Archived")).toHaveTextContent("Archived 1");
    expect(screen.getAllByRole("article")).toHaveLength(2);

    // The box shows the chosen value over the transparent select.
    expect(screen.getByText("Any", { selector: "[aria-hidden] > [data-current]" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "writing" } });
    expect(screen.getByText("Writing", { selector: "[aria-hidden] > [data-current]" })).toBeInTheDocument();
    expect(chip("All")).toHaveTextContent("All 1");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("groups Featured, Pinned, then the rest by update under All, and lists flat while searching", () => {
    renderGallery(gallery(list));
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Featured", "Pinned", "Recently updated"]);
    const featured = screen.getByRole("region", { name: "Featured" });
    expect(within(featured).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent))
      .toEqual(["Alpha desk", "Beta desk"]);
    const rest = screen.getByRole("region", { name: "Recently updated" });
    expect(within(rest).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent))
      .toEqual(["Newer helper", "Older helper"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Assistants" }), { target: { value: "desk" } });
    expect(screen.queryByRole("heading", { name: "Featured" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent))
      .toEqual(["Beta desk", "Alpha desk"]);
  });

  it("searches the author too and says when nothing matches", () => {
    renderGallery(gallery(list));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Assistants" }), { target: { value: "ada" } });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Assistants" }), { target: { value: "quantum" } });
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });

  it("clears the search and the category from Nothing matches and returns to the search field", () => {
    renderGallery(gallery(list));
    const search = screen.getByRole("searchbox", { name: "Search Assistants" });
    const category = screen.getByRole("combobox", { name: "Category" });
    fireEvent.click(chip("Yours"));
    fireEvent.change(category, { target: { value: "writing" } });
    fireEvent.change(search, { target: { value: "quantum" } });
    expect(screen.getByText("Nothing matches")).not.toContainElement(screen.getByRole("button", { name: "Clear search" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(category).toHaveValue("");
    expect(search).toHaveFocus();
    expect(chip("Yours")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Nothing matches")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
  });

  it("offers Clear search when only the category empties the list", () => {
    renderGallery(gallery(list));
    fireEvent.click(chip("Featured"));
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "writing" } });
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("");
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("offers no Clear search when the chip alone is empty", () => {
    renderGallery(gallery(list.filter((assistant) => !assistant.archived)));
    fireEvent.click(chip("Archived"));
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("shows archived Assistants only under Archived, with Restore and Delete", () => {
    const view = gallery(list);
    renderGallery(view);
    fireEvent.click(chip("Archived"));
    const card = screen.getByTestId("assistant-card-archived");
    expect(card).toHaveTextContent("Archived");
    expect(within(card).queryByRole("button", { name: /Start chat/u })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Restore Retired helper" }));
    expect(view.onArchiveToggle).toHaveBeenCalledWith("archived", false);
    fireEvent.click(within(card).getByRole("button", { name: "Delete Retired helper" }));
    expect(view.onDelete).toHaveBeenCalledWith("archived");
  });

  it("explains the empty, loading and failed list", () => {
    const empty = renderGallery(gallery([]));
    expect(screen.getByRole("heading", { name: "No Assistants yet" })).toBeInTheDocument();
    expect(screen.getByText("Create one from a template or from your current chat.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "From current chat" }));
    expect(empty.onFromCurrentChat).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Filter Assistants" })).not.toBeInTheDocument();
  });

  it("keeps loading distinct from an error with Reload", () => {
    renderGallery(null, { catalogState: "loading" });
    expect(screen.getByRole("status", { name: "Loading Assistants" })).toBeInTheDocument();
  });

  it("offers Reload when the list did not load", () => {
    const handlers = renderGallery(gallery([]), { catalogError: "Server unavailable.", catalogState: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent("The list did not loadServer unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(handlers.onRetry).toHaveBeenCalledOnce();
  });
});

describe("Assistant card", () => {
  it("shows owner, scope and model, the capability line, and opens the detail sheet from its heading or body", () => {
    const view = gallery([assistantSummary({
      fingerprint: { knowledgeLabel: null, knowledgeResourceCount: 2, mcpServerCount: 1, modelLabel: null, reasoningEffort: null, searchOptionCount: 0 },
      skillLinkCount: 3
    })]);
    renderGallery(view);
    const card = screen.getByTestId("assistant-card-assistant-1");
    expect(card.tagName).toBe("ARTICLE");
    expect(card).toHaveTextContent("Yours · Only you · Your model");
    const capabilities = within(card).getByRole("list", { name: "Capabilities" });
    expect(within(capabilities).getAllByRole("listitem").map((item) => item.getAttribute("data-tooltip")))
      .toEqual(["1 MCP server", "2 Knowledge bases or documents", "3 linked Skills"]);

    fireEvent.click(within(card).getByRole("button", { name: "Code reviewer" }));
    expect(view.onOpenDetail).toHaveBeenCalledWith("assistant-1");
    fireEvent.click(within(card).getByText("Reviews changes with care."));
    expect(view.onOpenDetail).toHaveBeenCalledTimes(2);
    fireEvent.click(within(card).getByRole("button", { name: "Start chat with Code reviewer" }));
    expect(view.onStartChat).toHaveBeenCalledWith("assistant-1");
    expect(view.onOpenDetail).toHaveBeenCalledTimes(2);
  });

  it("says Your model only for a usable Assistant without a model name, and never guesses one", () => {
    const unnamed = { knowledgeLabel: null, knowledgeResourceCount: 0, mcpServerCount: 0, modelLabel: null, reasoningEffort: null, searchOptionCount: 0 };
    renderGallery(gallery([
      assistantSummary({ fingerprint: unnamed, id: "ready", name: "Ready" }),
      assistantSummary({
        availability: { dependencies: [{ kind: "model", name: "GPT-5.5" }], ok: false, reason: "model_access" },
        fingerprint: unnamed,
        id: "owner-model",
        name: "Owner model"
      }),
      assistantSummary({ availability: { ok: false, reason: "model_access" }, fingerprint: unnamed, id: "consumer-model", name: "Consumer model", owned: false, ownerDisplayName: "Ada", scope: { kind: "installation" } }),
      assistantSummary({ availability: { ok: false, reason: "tools_access" }, fingerprint: unnamed, id: "consumer-tools", name: "Consumer tools", owned: false, ownerDisplayName: "Ada", scope: { kind: "installation" } })
    ]));
    const meta = (id: string) => screen.getByTestId(`assistant-card-${id}`).querySelector(".v2-assistants-card-meta")?.textContent;
    expect(meta("ready")).toBe("Yours · Only you · Your model");
    expect(meta("owner-model")).toBe("Yours · Only you · Unavailable model");
    expect(screen.getByTestId("assistant-card-owner-model")).toHaveTextContent("Needs attention: GPT-5.5 isn't available");
    expect(meta("consumer-model")).toBe("By Ada · Everyone · Unavailable model");
    // Unusable for another reason: an inherited model and a missing fixed one look the same.
    expect(meta("consumer-tools")).toBe("By Ada · Everyone");
  });

  it("gives the name button the whole name as its title without changing its name", () => {
    const name = "Quarterly planning partner for the finance team";
    renderGallery(gallery([assistantSummary({ name })]));
    expect(screen.getByRole("button", { name })).toHaveAttribute("title", name);
  });

  it("pins with a pressed toggle", () => {
    const view = gallery([assistantSummary({ pinned: true })]);
    renderGallery(view);
    const pin = screen.getByRole("button", { name: "Pin Code reviewer" });
    expect(pin).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(pin);
    expect(view.onPinToggle).toHaveBeenCalledWith("assistant-1", false);
  });

  it("draws the Pin toggle as a pushpin, filled when pinned, and keeps the star for Featured", () => {
    renderGallery(gallery([
      assistantSummary({ featured: true, featuredOrder: 0, id: "featured", name: "Featured desk" }),
      assistantSummary({ id: "pinned", name: "Pinned writer", pinned: true })
    ]));
    const glyph = (button: HTMLElement) => button.querySelector("use")?.getAttribute("href");
    expect(glyph(screen.getByRole("button", { name: "Pin Featured desk" }))).toBe("#v2-icon-pin");
    expect(glyph(screen.getByRole("button", { name: "Pin Pinned writer" }))).toBe("#v2-icon-pin-fill");
    const featuredCard = screen.getByTestId("assistant-card-featured");
    expect(featuredCard.querySelector(".v2-assistants-featured-mark use")).toHaveAttribute("href", "#v2-icon-star-fill");
    expect(screen.getByTestId("assistant-card-pinned").querySelector("use[href^='#v2-icon-star']")).toBeNull();
  });

  it("gives the owner every management action and no Export", () => {
    const view = gallery([assistantSummary()]);
    renderGallery(view);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Code reviewer" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Edit", "Duplicate", "Copy link", "Share…", "Archive", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Share…" }));
    expect(view.onShare).toHaveBeenCalledWith("assistant-1");
    fireEvent.click(screen.getByRole("button", { name: "More actions for Code reviewer" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(view.onDelete).toHaveBeenCalledWith("assistant-1");
    expect(view.onOpenDetail).not.toHaveBeenCalled();
  });

  it("gives the owner's audience on the card as Only you, a count of groups, or Everyone without its groups", () => {
    const audiences: Array<[NonNullable<AssistantSummary["audience"]>, string]> = [
      [{ everyone: false, groupNames: [] }, "Only you"],
      [{ everyone: false, groupNames: ["Sales"] }, "1 group"],
      [{ everyone: false, groupNames: ["Sales", "Support"] }, "2 groups"],
      [{ everyone: true, groupNames: [] }, "Everyone"],
      [{ everyone: true, groupNames: ["Design", "Sales", "Support"] }, "Everyone"]
    ];
    renderGallery(gallery(audiences.map(([audience], index) =>
      assistantSummary({ audience, id: `audience-${index}`, name: `Audience ${index}`, published: audience.everyone || audience.groupNames.length > 0 }))));
    audiences.forEach(([, text], index) => {
      expect(screen.getByTestId(`assistant-card-audience-${index}`)).toHaveTextContent(`Yours · ${text} · Model one`);
    });
  });

  it("counts the groups that reach another viewer instead of naming them", () => {
    renderGallery(gallery([
      assistantSummary({ id: "one-group", name: "One group", owned: false, ownerDisplayName: "Ada", scope: { groupNames: ["Sales"], kind: "group" } }),
      assistantSummary({ id: "listed", name: "Listed desk", owned: false, ownerDisplayName: "Ada", scope: { kind: "installation" } })
    ]));
    const card = screen.getByTestId("assistant-card-one-group");
    expect(card).toHaveTextContent("By Ada · 1 group · Model one");
    expect(card).not.toHaveTextContent("Sales");
    expect(screen.getByTestId("assistant-card-listed")).toHaveTextContent("By Ada · Everyone · Model one");
  });

  it("gives someone else's Assistant only Duplicate and Copy link", async () => {
    const view = gallery([assistantSummary({ owned: false, ownerDisplayName: "Ada", scope: { groupNames: ["Sales", "Support"], kind: "group" } })]);
    renderGallery(view);
    expect(screen.getByTestId("assistant-card-assistant-1")).toHaveTextContent("By Ada · 2 groups · Model one");
    fireEvent.click(screen.getByRole("button", { name: "More actions for Code reviewer" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Duplicate", "Copy link"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
    expect(view.onCopyLink).toHaveBeenCalledWith("assistant-1");
    expect(await screen.findByText("Assistant link copied.")).toBeInTheDocument();
  });

  it("disables Start chat when the Assistant is not available, naming dependencies only to the owner", () => {
    renderGallery(gallery([
      assistantSummary({ availability: { ok: false, reason: "tools_access" }, id: "foreign", name: "Foreign", owned: false }),
      assistantSummary({
        availability: { dependencies: [{ kind: "mcp", name: "Jira" }], ok: false, reason: "tools_access" },
        id: "mine",
        name: "Mine"
      })
    ]));
    const foreign = screen.getByTestId("assistant-card-foreign");
    expect(foreign).toHaveTextContent("Not available to you");
    expect(within(foreign).getByRole("button", { name: "Start chat with Foreign" })).toBeDisabled();
    const mine = screen.getByTestId("assistant-card-mine");
    expect(mine).toHaveTextContent("Needs attention: Jira isn't available");
    expect(within(mine).getByRole("button", { name: "Start chat with Mine" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Why?" })).not.toBeInTheDocument();
  });
});

describe("Gallery notice", () => {
  const archived: LibraryNotice = { kind: "success", text: "Archived Code reviewer." };

  const views = new Map<AssistantSummary[], AssistantGalleryView>();
  function galleryElement(assistants: AssistantSummary[], notice: LibraryNotice | null) {
    if (!views.has(assistants)) views.set(assistants, gallery(assistants));
    return (
      <AssistantGalleryV2
        busy={false}
        catalogError={null}
        catalogState="ready"
        gallery={views.get(assistants)!}
        notice={notice}
        onDismissNotice={vi.fn()}
        onFromCurrentChat={vi.fn()}
        onNewAssistant={vi.fn()}
        onRetry={vi.fn()}
      />
    );
  }

  const liveRegion = () => screen.getAllByRole("status").find((element) => element.classList.contains("sr-only"))!;

  it("takes the focus that left with a removed card, and is read as the focused element", async () => {
    const { rerender } = render(galleryElement([assistantSummary()], null));
    screen.getByRole("button", { name: "Code reviewer" }).focus();
    rerender(galleryElement([], archived));
    const notice = screen.getByTestId("assistant-gallery-notice");
    await waitFor(() => expect(notice).toHaveFocus());
    expect(notice).toHaveAttribute("tabindex", "-1");
    expect(notice).not.toHaveAttribute("role");
    expect(liveRegion()).toBeEmptyDOMElement();
  });

  it("hands focus over when the refresh after the notice takes the focused card away", async () => {
    // The notice alone leaves the list as it was; the refresh replaces it.
    const before = [assistantSummary()];
    const { rerender } = render(galleryElement(before, null));
    const opener = screen.getByRole("button", { name: "Code reviewer" });
    opener.focus();
    rerender(galleryElement(before, archived));
    await waitFor(() => expect(liveRegion()).toHaveTextContent("Archived Code reviewer."));
    expect(opener).toHaveFocus();
    rerender(galleryElement([], archived));
    await waitFor(() => expect(screen.getByTestId("assistant-gallery-notice")).toHaveFocus());
  });

  it("waits for a layer above the gallery and keeps the focus it returned to a card", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.setAttribute("inert", "");
    const { rerender } = render(galleryElement([assistantSummary()], null), { container: host });
    rerender(galleryElement([assistantSummary()], { kind: "success", text: "Sharing updated." }));
    const card = screen.getByRole("button", { name: "Code reviewer" });
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(liveRegion()).toBeEmptyDOMElement();
    // The layer closes and returns focus to the card's button.
    card.focus();
    host.removeAttribute("inert");
    await waitFor(() => expect(liveRegion()).toHaveTextContent("Sharing updated."));
    expect(card).toHaveFocus();
    rerender(galleryElement([assistantSummary(), assistantSummary({ id: "second", name: "Second" })], { kind: "success", text: "Sharing updated." }));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    expect(card).toHaveFocus();
    host.remove();
  });

  it("takes focus after a layer closes when its focus return found nothing", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.setAttribute("inert", "");
    const { rerender } = render(galleryElement([assistantSummary()], null), { container: host });
    rerender(galleryElement([], { kind: "success", text: "Deleted Code reviewer." }));
    (document.activeElement as HTMLElement | null)?.blur();
    host.removeAttribute("inert");
    await waitFor(() => expect(screen.getByTestId("assistant-gallery-notice")).toHaveFocus());
    host.remove();
  });
});
