import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chatHeaderGalleryAssistants,
  chatHeaderGalleryBound,
  chatHeaderGalleryCurrent
} from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import { AssistantBindingNoticeV2, assistantBindingNoticeCopyV2 } from "./AssistantBindingNoticeV2";

const [hr, , , , jira, sales] = chatHeaderGalleryAssistants;

function handlers() {
  return {
    onChooseAnother: vi.fn(),
    onContinueWithout: vi.fn(),
    onOpenInStudio: vi.fn(),
    onRestore: vi.fn()
  };
}

describe("Assistant binding notice v2", () => {
  it("names the owner's missing dependency with Open in Studio and blocks nothing else", () => {
    const actions = handlers();
    render(<AssistantBindingNoticeV2 current={chatHeaderGalleryCurrent("unavailable-owner")} pending={false} {...actions} />);

    const notice = screen.getByTestId("assistant-binding-notice");
    expect(within(notice).getByRole("status")).toHaveTextContent(
      "Jira MCP isn't available.Fix the Assistant or continue without it."
    );
    expect(within(notice).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Open in Studio", "Choose another", "Continue without the Assistant"]);
    fireEvent.click(within(notice).getByRole("button", { name: "Open in Studio" }));
    expect(actions.onOpenInStudio).toHaveBeenCalledWith("assistant-jira");
    fireEvent.click(within(notice).getByRole("button", { name: "Choose another" }));
    expect(actions.onChooseAnother).toHaveBeenCalledOnce();
    fireEvent.click(within(notice).getByRole("button", { name: "Continue without the Assistant" }));
    expect(actions.onContinueWithout).toHaveBeenCalledOnce();
  });

  it("never shows a consumer a dependency name, even when a projection carries one", () => {
    const leaked = chatHeaderGalleryBound(sales!, {
      availability: { dependencies: [{ kind: "mcp", name: "Private CRM" }], ok: false, reason: "tools_access" }
    });
    render(<AssistantBindingNoticeV2 current={leaked} pending={false} {...handlers()} />);

    const notice = screen.getByTestId("assistant-binding-notice");
    expect(notice).toHaveTextContent("This Assistant isn't available to you right now.");
    expect(notice).not.toHaveTextContent("Private CRM");
    expect(within(notice).queryByRole("button", { name: "Open in Studio" })).toBeNull();
  });

  it("uses its own sentences for archived, deleted and unresolved Assistants", () => {
    expect(assistantBindingNoticeCopyV2(chatHeaderGalleryCurrent("archived-owner")))
      .toEqual({ action: "restore", detail: null, headline: "You archived this Assistant." });
    expect(assistantBindingNoticeCopyV2(chatHeaderGalleryCurrent("archived-consumer")))
      .toEqual({ action: null, detail: null, headline: "This Assistant was archived by its owner." });
    expect(assistantBindingNoticeCopyV2(chatHeaderGalleryCurrent("deleted")))
      .toEqual({ action: null, detail: null, headline: "This Assistant was deleted." });
    expect(assistantBindingNoticeCopyV2({ blockReason: "x", scope: "chat", state: "unavailable" })?.headline)
      .toBe("This Assistant isn't available to you right now.");
    expect(assistantBindingNoticeCopyV2({ blockReason: "x", reason: "archived", scope: "chat", state: "unavailable" }))
      .toEqual({ action: null, detail: null, headline: "This Assistant was archived by its owner." });
    expect(assistantBindingNoticeCopyV2(chatHeaderGalleryBound(jira!, {
      availability: {
        dependencies: [{ kind: "mcp", name: "Jira MCP" }, { kind: "mcp", name: "GitHub" }],
        ok: false,
        reason: "tools_access"
      }
    }))?.headline).toBe("Jira MCP and GitHub aren't available.");
    expect(assistantBindingNoticeCopyV2(chatHeaderGalleryBound(jira!, {
      availability: { dependencies: [{ kind: "mcp", name: "Required MCP tools" }], ok: false, reason: "tools_access" }
    }))?.headline).toBe("The Assistant's MCP tools aren't available.");
    expect(assistantBindingNoticeCopyV2(chatHeaderGalleryBound(hr!))).toBeNull();
    expect(assistantBindingNoticeCopyV2(null)).toBeNull();
  });

  it("restores an owner's archived Assistant and holds every choice while an update runs", () => {
    const actions = handlers();
    const { rerender } = render(
      <AssistantBindingNoticeV2 current={chatHeaderGalleryCurrent("archived-owner")} pending={false} {...actions} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(actions.onRestore).toHaveBeenCalledWith("assistant-hr");

    rerender(<AssistantBindingNoticeV2 current={chatHeaderGalleryCurrent("archived-owner")} pending {...actions} />);
    for (const button of within(screen.getByTestId("assistant-binding-notice")).getAllByRole("button")) {
      // Held, not disabled: a pressed choice keeps focus while the action runs.
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toBeEnabled();
      fireEvent.click(button);
    }
    expect(actions.onRestore).toHaveBeenCalledOnce();
    expect(actions.onChooseAnother).not.toHaveBeenCalled();
    expect(actions.onContinueWithout).not.toHaveBeenCalled();

    rerender(<AssistantBindingNoticeV2 current={chatHeaderGalleryCurrent("deleted")} pending={false} {...actions} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Choose another", "Continue without the Assistant"]);
  });

  describe("focus after a choice", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Presses a choice, lets its action run and end with `after`, and reports where focus went. */
    function pressAndSettle(state: Parameters<typeof chatHeaderGalleryCurrent>[0], choice: string, after: ReturnType<typeof chatHeaderGalleryCurrent>) {
      vi.useFakeTimers();
      const actions = handlers();
      const restoreFocus = vi.fn();
      const current = chatHeaderGalleryCurrent(state);
      const { rerender } = render(
        <AssistantBindingNoticeV2 current={current} pending={false} restoreFocus={restoreFocus} {...actions} />
      );
      const button = screen.getByRole("button", { name: choice });
      button.focus();
      fireEvent.click(button);
      rerender(<AssistantBindingNoticeV2 current={current} pending restoreFocus={restoreFocus} {...actions} />);
      expect(button).toHaveFocus();
      rerender(<AssistantBindingNoticeV2 current={after} pending={false} restoreFocus={restoreFocus} {...actions} />);
      act(() => { vi.runAllTimers(); });
      return { button, restoreFocus };
    }

    it("moves to the message field when Restore makes the chat usable", () => {
      const { restoreFocus } = pressAndSettle("archived-owner", "Restore", chatHeaderGalleryBound(hr!));
      expect(screen.queryByTestId("assistant-binding-notice")).toBeNull();
      expect(restoreFocus).toHaveBeenCalledOnce();
    });

    it("stays on Restore when it fails and the notice stays", () => {
      const { button, restoreFocus } = pressAndSettle("archived-owner", "Restore", chatHeaderGalleryCurrent("archived-owner"));
      expect(button).toHaveFocus();
      expect(restoreFocus).not.toHaveBeenCalled();
    });

    it("moves to the message field after Continue without the Assistant", () => {
      const { restoreFocus } = pressAndSettle("deleted", "Continue without the Assistant", null);
      expect(restoreFocus).toHaveBeenCalledOnce();
    });

    it("moves to the message field once another Assistant is chosen", () => {
      // The picker returns focus to Choose another; the choice then removes the notice.
      const { restoreFocus } = pressAndSettle("unavailable-consumer", "Choose another", chatHeaderGalleryBound(hr!));
      expect(restoreFocus).toHaveBeenCalledOnce();
    });
  });
});
