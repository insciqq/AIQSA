import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatHeaderGalleryAssistants,
  chatHeaderGalleryProjectAssistants,
  chatHeaderGalleryRecentIds
} from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import { AssistantPickerV2, assistantBylineV2, assistantPickerSectionsV2 } from "./AssistantPickerV2";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMobile(mobile: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: vi.fn(),
    matches: mobile,
    media: query,
    removeEventListener: vi.fn()
  }));
}

function renderPicker(overrides: Partial<Parameters<typeof AssistantPickerV2>[0]> = {}) {
  const anchor = document.createElement("button");
  anchor.textContent = "Selector";
  document.body.append(anchor);
  anchor.getBoundingClientRect = () => ({
    bottom: 40, height: 34, left: 520, right: 660, toJSON: () => ({}), top: 6, width: 140, x: 520, y: 6
  });
  const anchorRef = createRef<HTMLElement>() as { current: HTMLElement | null };
  anchorRef.current = anchor;
  const props = {
    anchorRef,
    assistants: chatHeaderGalleryAssistants,
    currentAssistantId: null,
    loading: false,
    onBrowse: vi.fn(),
    onClose: vi.fn(),
    onSelect: vi.fn(),
    projectScoped: false,
    recentIds: chatHeaderGalleryRecentIds,
    ...overrides
  };
  const view = render(<AssistantPickerV2 {...props} />);
  return { anchor, props, ...view };
}

describe("Assistant picker sections", () => {
  it("orders Pinned, Recent, Featured, Yours, Shared with each Assistant once", () => {
    const sections = assistantPickerSectionsV2(
      [...chatHeaderGalleryAssistants, { ...chatHeaderGalleryAssistants[1]!, archived: true, id: "archived" }],
      { projectScoped: false, query: "", recentIds: ["assistant-notes", "assistant-hr", "assistant-review"] }
    );
    expect(sections.map((section) => [section.label, section.items.map((item) => item.name)])).toEqual([
      ["Pinned", ["HR Helper"]],
      ["Recent", ["Meeting notes", "Code reviewer"]],
      ["Yours", ["Research analyst", "Jira desk"]],
      ["Shared", ["Sales brief"]]
    ]);
  });

  it("lists a Project's Assistants flat and searches name, description and author", () => {
    expect(assistantPickerSectionsV2(chatHeaderGalleryProjectAssistants, {
      projectScoped: true,
      query: "",
      recentIds: chatHeaderGalleryRecentIds
    })).toEqual([{ items: chatHeaderGalleryProjectAssistants, label: null }]);
    expect(assistantPickerSectionsV2(chatHeaderGalleryAssistants, {
      projectScoped: false,
      query: "dana",
      recentIds: []
    }).flatMap((section) => section.items.map((item) => item.name))).toEqual(["Meeting notes", "Sales brief"]);
  });
});

describe("Assistant byline", () => {
  it("names the viewer, the owner or the Project, never by Project", () => {
    expect(assistantBylineV2({ owned: true, ownerDisplayName: "Local Operator" })).toBe("by you");
    expect(assistantBylineV2({ owned: false, ownerDisplayName: "Dana Ivanova" })).toBe("by Dana Ivanova");
    expect(assistantBylineV2({ owned: true, ownerDisplayName: "Project", projectName: "Launch plan" }))
      .toBe("Project “Launch plan”");
    expect(assistantBylineV2({ owned: false, ownerDisplayName: "Project", projectName: null })).toBe("Project");
    expect(assistantBylineV2({ owned: false, ownerDisplayName: "Project", projectName: "  " })).toBe("Project");
  });
});

describe("Assistant picker v2", () => {
  it("is an anchored dialog that searches, moves by arrow keys and chooses", async () => {
    const { anchor, props } = renderPicker({ currentAssistantId: "assistant-hr" });
    const dialog = screen.getByRole("dialog", { name: "Choose an Assistant" });
    const search = within(dialog).getByRole("searchbox", { name: "Search Assistants" });
    await waitFor(() => expect(search).toHaveFocus());
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("assistant-picker-backdrop")).toHaveAttribute("data-layout", "popover");
    expect(dialog.style.left).toBe("520px");
    expect(dialog.style.top).toBe("46px");
    expect(within(dialog).getAllByRole("heading").map((heading) => heading.textContent))
      .toEqual(["Pinned", "Recent", "Featured", "Yours", "Shared"]);

    const current = within(dialog).getByTestId("assistant-picker-row-assistant-hr");
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toHaveTextContent("HR Helper");
    expect(current).toHaveTextContent("by you");
    const unavailable = within(dialog).getByTestId("assistant-picker-row-assistant-sales");
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveTextContent("Not available to you");
    expect(within(dialog).getByTestId("assistant-picker-row-assistant-jira")).toHaveTextContent("Needs attention");

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(current).toHaveFocus();
    fireEvent.keyDown(current, { key: "ArrowDown" });
    expect(within(dialog).getByTestId("assistant-picker-row-assistant-notes")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: "review" } });
    expect(within(dialog).getAllByRole("button", { name: /Code reviewer/u })).toHaveLength(1);
    fireEvent.click(within(dialog).getByTestId("assistant-picker-row-assistant-review"));
    expect(props.onSelect).toHaveBeenCalledWith("assistant-review");
    expect(dialog).not.toHaveTextContent("assistant-review");

    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByTestId("assistant-picker-empty")).toHaveTextContent("No Assistants match this search.");
    anchor.remove();
  });

  it("keeps Tab inside, closes on Escape and on an outside press, and browses Studio", async () => {
    const { anchor, props } = renderPicker();
    const dialog = screen.getByRole("dialog", { name: "Choose an Assistant" });
    await waitFor(() => expect(within(dialog).getByRole("searchbox")).toHaveFocus());

    const browse = within(dialog).getByRole("button", { name: "Browse all in Studio" });
    browse.focus();
    fireEvent.keyDown(browse, { key: "Tab" });
    expect(within(dialog).getByRole("searchbox")).toHaveFocus();

    fireEvent.click(browse);
    expect(props.onBrowse).toHaveBeenCalledOnce();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole("button", { name: "Close Assistant picker" })[0]!);
    expect(props.onClose).toHaveBeenCalledTimes(2);
    anchor.remove();
  });

  it("is a bottom sheet on phones and a flat Project list with its settings route", async () => {
    stubMobile(true);
    const { anchor } = renderPicker({
      assistants: chatHeaderGalleryProjectAssistants,
      projectScoped: true,
      recentIds: []
    });
    const dialog = screen.getByRole("dialog", { name: "Choose an Assistant" });
    // No caret in the search field, so no touch keyboard covers the list.
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByTestId("assistant-picker-backdrop")).toHaveAttribute("data-layout", "sheet");
    expect(dialog.getAttribute("style")).toBeNull();
    expect(within(dialog).queryAllByRole("heading")).toHaveLength(0);
    const projectList = within(dialog).getByRole("region", { name: "Project Assistants" });
    expect(projectList).toHaveTextContent("Code reviewer");
    expect(within(projectList).getByTestId("assistant-picker-row-assistant-review")).toHaveTextContent("Project “Launch plan”");
    expect(projectList).not.toHaveTextContent("by Project");
    expect(within(dialog).getByRole("button", { name: "Manage in Project settings" })).toBeVisible();
    anchor.remove();
  });

  it("opens on itself on a touch tablet and still moves by arrow keys", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      addEventListener: vi.fn(),
      matches: query === "(hover: none), (pointer: coarse)",
      media: query,
      removeEventListener: vi.fn()
    }));
    const { anchor } = renderPicker();
    const dialog = screen.getByRole("dialog", { name: "Choose an Assistant" });
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByTestId("assistant-picker-backdrop")).toHaveAttribute("data-layout", "popover");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(within(dialog).getByTestId("assistant-picker-row-assistant-hr")).toHaveFocus();
    anchor.remove();
  });

  it("puts the caret in the search field on a press anywhere in its band", async () => {
    const { anchor, props } = renderPicker();
    const dialog = screen.getByRole("dialog", { name: "Choose an Assistant" });
    const search = within(dialog).getByRole("searchbox", { name: "Search Assistants" });
    await waitFor(() => expect(search).toHaveFocus());
    within(dialog).getByTestId("assistant-picker-row-assistant-hr").focus();

    const band = search.closest("header")!;
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    band.querySelector("svg")!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(search).toHaveFocus();

    // The band's close control keeps its own press.
    const close = within(band).getByRole("button", { name: "Close Assistant picker" });
    expect(fireEvent.mouseDown(close)).toBe(true);
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalledOnce();
    anchor.remove();
  });

  it("asks for the bottom sheet on short touch screens too", () => {
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return { addEventListener: vi.fn(), matches: true, media: query, removeEventListener: vi.fn() };
    });
    const { anchor } = renderPicker();
    expect(screen.getByTestId("assistant-picker-backdrop")).toHaveAttribute("data-layout", "sheet");
    expect(queries.at(-1)).toMatch(/\(pointer: coarse\) and \(max-height: 30rem\)/u);
    anchor.remove();
  });

  it("returns focus to the selector when the opener left the page", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Change…";
    document.body.append(opener);
    opener.focus();
    const { anchor, unmount } = renderPicker();
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus());
    opener.remove();
    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    await waitFor(() => expect(anchor).toHaveFocus());
    anchor.remove();
  });
});
