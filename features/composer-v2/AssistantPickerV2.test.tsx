import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { AssistantPickerV2 } from "./AssistantPickerV2";

describe("Assistant picker v2", () => {
  it("groups safe summaries, searches locally, and routes selection without exposing ids", async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(
      <AssistantPickerV2
        assistants={composerGalleryConfig.assistants}
        loading={false}
        onClose={onClose}
        onCreateFromCurrentSetup={vi.fn()}
        onManage={vi.fn()}
        onSelect={onSelect}
        recentIds={[]}
        selectedAssistantId={null}
      />
    );

    const search = screen.getByRole("searchbox", { name: "Search assistants" });
    await waitFor(() => expect(search).toHaveFocus());
    const pinned = screen.getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("button", { name: /Research editor/ })).toBeVisible();

    fireEvent.change(search, { target: { value: "Research" } });
    fireEvent.click(within(pinned).getByRole("button", { name: /Research editor/ }));
    expect(onSelect).toHaveBeenCalledWith(composerGalleryConfig.assistants[0]?.id);
    expect(screen.getByRole("dialog", { name: "Use an assistant" })).not.toHaveTextContent(
      composerGalleryConfig.assistants[0]?.id ?? "assistant-id"
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Use an assistant" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
