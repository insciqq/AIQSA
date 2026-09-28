import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogModel } from "@/components/app-shell/types";
import {
  chatHeaderGalleryAssistants,
  chatHeaderGalleryBound,
  chatHeaderGalleryCurrent
} from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import {
  HeaderAssistantSelectorV2,
  headerAssistantFitV2,
  headerModelProvenanceV2,
  saveChatSetupReasonV2,
  type HeaderAssistantSelectorActionsV2
} from "./HeaderAssistantSelectorV2";

function actions(overrides: Partial<HeaderAssistantSelectorActionsV2> = {}): HeaderAssistantSelectorActionsV2 {
  return {
    canSaveChatSetup: false,
    continueWithout: vi.fn(),
    copyLink: vi.fn(),
    current: null,
    editById: vi.fn(),
    openPicker: false,
    pending: false,
    remove: vi.fn(),
    restore: vi.fn(),
    saveChatSetup: vi.fn(),
    setPickerOpen: vi.fn(),
    ...overrides
  };
}

function renderSelector(assistant: HeaderAssistantSelectorActionsV2) {
  const triggerRef = createRef<HTMLButtonElement>() as { current: HTMLButtonElement | null };
  render(<HeaderAssistantSelectorV2 assistant={assistant} triggerRef={triggerRef} />);
  return { trigger: screen.getByTestId("header-assistant-selector"), triggerRef };
}

const models = [
  { displayName: "Gemini 3.8 Flash", modelId: "gemini-3.8-flash" }
] as CatalogModel[];

describe("Header Assistant selector v2", () => {
  it("is a quiet icon without an Assistant that opens the picker", () => {
    const assistant = actions();
    const { trigger, triggerRef } = renderSelector(assistant);

    expect(triggerRef.current).toBe(trigger);
    expect(trigger).toHaveAccessibleName("Choose an Assistant");
    expect(trigger).toHaveAttribute("data-tooltip", "Choose an Assistant");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("data-state", "empty");
    expect(trigger).toHaveTextContent("");
    fireEvent.click(trigger);
    expect(assistant.setPickerOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the chosen Assistant and its menu for the owner", () => {
    const current = chatHeaderGalleryBound(chatHeaderGalleryAssistants[0]!, { modelOrigin: "chat" });
    const assistant = actions({ canSaveChatSetup: true, current });
    const { trigger } = renderSelector(assistant);

    expect(trigger).toHaveAccessibleName("Assistant: HR Helper");
    expect(trigger).toHaveTextContent("HR Helper");
    expect(trigger).toHaveAttribute("data-state", "chosen");
    expect(trigger).toHaveAttribute("data-fit", "label");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Assistant" });
    expect(within(menu).getByTestId("header-assistant-menu-head")).toHaveTextContent("HR Helper · by you");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Change…",
      "Edit Assistant",
      "Save chat setup to Assistantmodel changed for this chat",
      "Copy link",
      "Remove for this chatapplies to the next messages"
    ]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: /Save chat setup/u }));
    expect(assistant.saveChatSetup).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }));
    expect(assistant.copyLink).toHaveBeenCalledWith("assistant-hr");

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Change…" }));
    expect(assistant.setPickerOpen).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove for this chat/u }));
    expect(assistant.remove).toHaveBeenCalledOnce();
  });

  it("offers a consumer no owner actions and holds changes while an update is pending", () => {
    const current = chatHeaderGalleryBound(chatHeaderGalleryAssistants[1]!);
    renderSelector(actions({ current, pending: true }));

    fireEvent.click(screen.getByTestId("header-assistant-selector"));
    const menu = screen.getByRole("menu", { name: "Assistant" });
    expect(within(menu).getByTestId("header-assistant-menu-head")).toHaveTextContent("Code reviewer · by Local Operator");
    expect(within(menu).queryByRole("menuitem", { name: "Edit Assistant" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /Save chat setup/u })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Change…" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Remove for this chat/u })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toBeEnabled();
  });

  it.each([
    ["unavailable-owner", "Assistant unavailable: Jira desk", "Assistant unavailable", "Unavailable", ["Choose another…", "Edit Assistant", "Continue without the Assistant"]],
    ["unavailable-consumer", "Assistant unavailable: Sales brief", "Assistant unavailable", "Unavailable", ["Choose another…", "Continue without the Assistant"]],
    ["archived-owner", "Assistant archived: HR Helper", "Assistant archived", "Archived", ["Choose another…", "Edit Assistant", "Restore", "Continue without the Assistant"]],
    ["archived-consumer", "Assistant archived", "Assistant archived", "Archived", ["Choose another…", "Continue without the Assistant"]],
    ["deleted", "Assistant deleted", "Assistant deleted", "Deleted", ["Choose another…", "Continue without the Assistant"]]
  ] as const)("reads a blocking %s binding with the error outline", (state, name, label, word, items) => {
    const assistant = actions({ current: chatHeaderGalleryCurrent(state) });
    const { trigger } = renderSelector(assistant);

    expect(trigger).toHaveAccessibleName(name);
    // The whole label shows where it fits; the state word alone is the
    // narrower form, and neither is ever cut.
    expect(trigger).toHaveAttribute("data-fit", "label");
    expect([...trigger.querySelectorAll("[data-label]")].map((form) => [form.getAttribute("data-label"), form.textContent]))
      .toEqual([["label", label], ["word", word]]);
    expect(trigger).toHaveAttribute("data-state", "blocked");
    fireEvent.click(trigger);
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
    fireEvent.click(screen.getByRole("menuitem", { name: "Continue without the Assistant" }));
    expect(assistant.continueWithout).toHaveBeenCalledOnce();
  });

  describe("focus after a way out of a blocked binding", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function blockedSelector(state: Parameters<typeof chatHeaderGalleryCurrent>[0]) {
      vi.useFakeTimers();
      const focusComposer = vi.fn();
      const triggerRef = createRef<HTMLButtonElement>() as { current: HTMLButtonElement | null };
      const assistant = actions({ current: chatHeaderGalleryCurrent(state) });
      const view = render(<HeaderAssistantSelectorV2 assistant={assistant} focusComposer={focusComposer} triggerRef={triggerRef} />);
      const settle = (next: Partial<HeaderAssistantSelectorActionsV2>) => {
        view.rerender(
          <HeaderAssistantSelectorV2 assistant={{ ...assistant, ...next }} focusComposer={focusComposer} triggerRef={triggerRef} />
        );
        act(() => { vi.runAllTimers(); });
      };
      return { assistant, focusComposer, settle, trigger: screen.getByTestId("header-assistant-selector") };
    }

    it.each([
      ["Restore", "archived-owner", /^Restore/u],
      ["Continue without the Assistant", "deleted", /^Continue without the Assistant/u],
      ["Choose another…", "unavailable-consumer", /^Choose another…/u]
    ] as const)("moves to the message field once %s makes the chat usable", (_name, state, item) => {
      const { focusComposer, settle, trigger } = blockedSelector(state);
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
      expect(trigger).toHaveFocus();

      settle({ current: chatHeaderGalleryBound(chatHeaderGalleryAssistants[0]!) });
      expect(focusComposer).toHaveBeenCalledOnce();
    });

    it("stays on the selector when Restore fails and the binding still blocks", () => {
      const { assistant, focusComposer, settle, trigger } = blockedSelector("archived-owner");
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("menuitem", { name: /^Restore/u }));
      expect(assistant.restore).toHaveBeenCalledWith("assistant-hr");

      settle({ current: chatHeaderGalleryCurrent("archived-owner"), pending: true });
      settle({ current: chatHeaderGalleryCurrent("archived-owner"), pending: false });
      expect(trigger).toHaveFocus();
      expect(focusComposer).not.toHaveBeenCalled();
    });

    it("leaves focus alone when the binding stops blocking without a way out from its menu", () => {
      const { focusComposer, settle, trigger } = blockedSelector("archived-owner");
      trigger.focus();
      settle({ current: chatHeaderGalleryBound(chatHeaderGalleryAssistants[0]!) });
      expect(focusComposer).not.toHaveBeenCalled();
    });
  });

  it("reads a Project's Assistant as the Project's, with only Change and Remove", () => {
    const current = chatHeaderGalleryCurrent("project-menu");
    // Even an Assistant the member owns is managed in Project settings here.
    const assistant = actions({ canSaveChatSetup: true, current: current?.state === "bound" ? { ...current, owned: true } : current });
    const { trigger } = renderSelector(assistant);

    expect(trigger).toHaveAccessibleName("Assistant: Code reviewer");
    expect(trigger).toHaveAttribute("data-state", "chosen");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Assistant" });
    expect(within(menu).getByTestId("header-assistant-menu-head")).toHaveTextContent("Code reviewer · Project “Launch plan”");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Change…",
      "Remove for this chatapplies to the next messages"
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Change…" }));
    expect(assistant.setPickerOpen).toHaveBeenCalledWith(true);
  });

  it("offers an unavailable Project binding another Project Assistant or none", () => {
    const assistant = actions({ current: chatHeaderGalleryCurrent("project-unavailable"), restore: undefined });
    fireEvent.click(renderSelector(assistant).trigger);

    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Choose another…", "Continue without the Assistant"]);
  });

  it("shows the widest form whose label fits the room the header leaves it", () => {
    // A chosen name may shorten to its minimum; a blocking label never shortens.
    const name = [{ fit: "label", minimum: 41 }] as const;
    const blocked = [{ fit: "label", minimum: 140 }, { fit: "word", minimum: 78 }] as const;
    expect(headerAssistantFitV2({ chrome: 68, labels: name, room: 172 })).toBe("label");
    expect(headerAssistantFitV2({ chrome: 68, labels: name, room: 109 })).toBe("label");
    expect(headerAssistantFitV2({ chrome: 68, labels: name, room: 108 })).toBe("icon");
    expect(headerAssistantFitV2({ chrome: 68, labels: blocked, room: 248 })).toBe("label");
    expect(headerAssistantFitV2({ chrome: 68, labels: blocked, room: 172 })).toBe("word");
    expect(headerAssistantFitV2({ chrome: 68, labels: blocked, room: 140 })).toBe("icon");
    expect(headerAssistantFitV2({ chrome: 68, labels: [], room: 500 })).toBe("icon");
  });

  it("says why the chat setup can or cannot be saved", () => {
    const current = chatHeaderGalleryBound(chatHeaderGalleryAssistants[0]!, { changedRows: ["model", "search", "tools"] });
    expect(saveChatSetupReasonV2(current, true)).toBe("model, Search and MCP changed for this chat");
    expect(saveChatSetupReasonV2({ ...current, scope: "composer" }, false)).toBe("Available after the first message");
    expect(saveChatSetupReasonV2({ ...current, changedRows: [] }, false)).toBe("Nothing changed for this chat");
  });
});

describe("Header model provenance", () => {
  const hr = chatHeaderGalleryAssistants[0]!;

  it("marks the Assistant's model, locks a fixed one and names the recommendation after a change", () => {
    expect(headerModelProvenanceV2(null, "DeepSeek V4.1 Flash", models))
      .toEqual({ fromAssistant: false, locked: false, title: "Choose model" });
    expect(headerModelProvenanceV2(chatHeaderGalleryBound(hr), "Gemini 3.8 Flash", models))
      .toEqual({ fromAssistant: true, locked: false, title: "Gemini 3.8 Flash · recommended by HR Helper" });
    expect(headerModelProvenanceV2(chatHeaderGalleryBound(hr, { modelPolicy: "fixed" }), "Gemini 3.8 Flash", models))
      .toEqual({ fromAssistant: true, locked: true, title: "Gemini 3.8 Flash · fixed by HR Helper" });
    // A fixed model's button opens the picker unless the Assistant blocks sending.
    expect(headerModelProvenanceV2(
      { ...chatHeaderGalleryBound(hr, { modelPolicy: "fixed" }), blockReason: "This Assistant was archived by its owner." },
      "Gemini 3.8 Flash",
      models
    )).toEqual({ blocked: true, fromAssistant: true, locked: true, title: "Nothing is sent until you choose." });
    expect(headerModelProvenanceV2(chatHeaderGalleryBound(hr, { modelOrigin: "chat" }), "Claude Sonnet 5", models))
      .toEqual({ fromAssistant: false, locked: false, title: "Changed for this chat · HR Helper starts with Gemini 3.8 Flash" });
    expect(headerModelProvenanceV2(chatHeaderGalleryBound(hr, { modelOrigin: "chat" }), "Claude Sonnet 5", []).title)
      .toBe("Changed for this chat");
    expect(headerModelProvenanceV2(chatHeaderGalleryBound(hr, { modelOrigin: "fallback" }), "DeepSeek V4.1 Flash", models))
      .toEqual({ fromAssistant: false, locked: false, title: "HR Helper's model isn't available to you; using your default" });
    expect(headerModelProvenanceV2(chatHeaderGalleryCurrent("deleted"), "DeepSeek V4.1 Flash", models).fromAssistant)
      .toBe(false);
  });

  it("names the Project default when the Project does not provide the Assistant's model", () => {
    expect(headerModelProvenanceV2(chatHeaderGalleryCurrent("project-fallback"), "DeepSeek V4.1 Flash", models)).toEqual({
      fromAssistant: false,
      locked: false,
      title: "Code reviewer's model isn't available in this Project; using the Project default"
    });
  });
});
