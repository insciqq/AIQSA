import { ComposerAssistantPicker } from "@/components/app-shell/ComposerAssistantPicker";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

const assistant: AssistantSummary = {
  archived: false,
  availability: { ok: true },
  avatar: {
    accents: [0, 4],
    backgroundShape: "circle",
    foregroundShape: "diamond",
    kind: "generated",
    paletteId: "ocean",
    recipeVersion: 1,
    rotations: [0, 2]
  },
  category: "research",
  description: "Reviews evidence with care.",
  fingerprint: {
    mcpServerCount: 0,
    modelLabel: "GPT-5.2",
    reasoningEffort: "medium",
    searchOptionCount: 1
  },
  id: "assistant-reviewer",
  name: "Evidence reviewer",
  owned: true,
  ownerDisplayName: "Owner",
  pinned: true,
  published: false,
  revisionNumber: 2,
  scope: { kind: "owner" },
  starterPrompts: [],
  updatedAt: "2026-08-09T12:00:00.000Z"
};

function Harness({ onClose }: Readonly<{ onClose(): void }>) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open assistant picker
      </button>
      {open ? (
        <ComposerAssistantPicker
          assistants={[assistant]}
          loading={false}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onCreateFromCurrentSetup={vi.fn()}
          onOpenLibrary={vi.fn()}
          onRemoveAssistant={null}
          onSelect={vi.fn()}
          recentIds={[]}
          selectedAssistantId={null}
        />
      ) : null}
    </>
  );
}

describe("ComposerAssistantPicker", () => {
  it("keeps Search as initial focus and closes through the visible canonical action", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "Open assistant picker" });

    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Use an assistant" });
    const close = screen.getByRole("button", { name: "Close assistant picker" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("assistant-picker-backdrop")).toBeVisible();
    expect(close).toHaveClass(
      "size-11",
      "sm:size-8",
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-left");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-right");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-top");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-bottom");
    await waitFor(() => expect(screen.getByLabelText("Search assistants")).toHaveFocus());

    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Use an assistant" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("retains Escape and backdrop dismissal through the same close callback", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "Open assistant picker" });

    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByLabelText("Search assistants")).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());

    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByTestId("assistant-picker-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
