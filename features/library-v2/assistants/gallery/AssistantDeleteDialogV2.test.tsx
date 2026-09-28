import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantDeleteDialogView } from "@/components/assistants/libraryViewContracts";
import { AssistantDeleteDialogV2 } from "./AssistantDeleteDialogV2";

function dialogView(overrides: Partial<AssistantDeleteDialogView> = {}): AssistantDeleteDialogView {
  return {
    assistantId: "assistant-1",
    consequences: {
      audiences: { groupNames: ["Support team"], installation: true },
      chatCount: 38,
      hiddenProjectCount: 1,
      pendingListingRequest: true,
      projects: [{ isDefault: true, name: "People Ops" }, { isDefault: false, name: "Sales" }],
      version: 4
    },
    error: null,
    name: "HR Helper",
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    onRetry: vi.fn(),
    state: "ready",
    ...overrides
  };
}

describe("Assistant delete dialog", () => {
  it("names the Assistant and lists every consequence before Delete", () => {
    const view = dialogView();
    render(<AssistantDeleteDialogV2 view={view} />);
    const dialog = screen.getByRole("dialog", { name: "Delete “HR Helper”?" });
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "It stops being available to everyone in this installation.",
      "It is unshared from the group Support team.",
      "The pending request to list it for everyone is withdrawn.",
      "Projects stop using it: People Ops (its default Assistant), Sales, 1 other Project.",
      "38 chats keep their messages and show that the Assistant was deleted."
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(view.onConfirm).toHaveBeenCalledOnce();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(view.onCancel).toHaveBeenCalledOnce();
  });

  it("says when nothing else changes", () => {
    render(<AssistantDeleteDialogV2 view={dialogView({
      consequences: {
        audiences: { groupNames: [], installation: false },
        chatCount: 1,
        hiddenProjectCount: 0,
        pendingListingRequest: false,
        projects: [],
        version: 2
      }
    })} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent))
      .toEqual(["1 chat keeps its messages and shows that the Assistant was deleted."]);
  });

  it("waits for the consequences and keeps Delete off until they arrive", () => {
    render(<AssistantDeleteDialogV2 view={dialogView({ consequences: null, state: "loading" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking what deleting it changes…");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("keeps the dialog open while deleting", () => {
    const view = dialogView({ state: "deleting" });
    render(<AssistantDeleteDialogV2 view={view} />);
    const dialog = screen.getByRole("dialog", { name: "Delete “HR Helper”?" });
    expect(within(dialog).getByRole("button", { name: "Delete" })).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(view.onCancel).not.toHaveBeenCalled();
  });

  it("shows why the consequences could not load and retries", () => {
    const view = dialogView({ consequences: null, error: "Server unavailable.", state: "error" });
    render(<AssistantDeleteDialogV2 view={view} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Server unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(view.onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
});
