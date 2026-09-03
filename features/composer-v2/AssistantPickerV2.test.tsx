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
    const researchEditor = within(pinned).getByRole("button", { name: /Research editor/ });
    expect(researchEditor).toBeVisible();
    expect(researchEditor).toHaveTextContent("Knowledge · 2");

    fireEvent.change(search, { target: { value: "Research" } });
    fireEvent.click(within(pinned).getByRole("button", { name: /Research editor/ }));
    expect(onSelect).toHaveBeenCalledWith(composerGalleryConfig.assistants[0]?.id);
    expect(screen.getByRole("dialog", { name: "Use an assistant" })).not.toHaveTextContent(
      composerGalleryConfig.assistants[0]?.id ?? "assistant-id"
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Use an assistant" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps create, repair, and Library actions separate from Assistant removal", async () => {
    const create = vi.fn();
    const manage = vi.fn();
    const repair = vi.fn();
    const base = composerGalleryConfig.assistants[0]!;
    render(
      <AssistantPickerV2
        assistants={[{
          ...base,
          availability: {
            dependencies: [{ kind: "mcp", name: "GitHub" }],
            ok: false,
            reason: "tools_access"
          },
          id: "assistant-unavailable",
          pinned: false
        }]}
        loading={false}
        onClose={vi.fn()}
        onCreateFromCurrentSetup={create}
        onManage={manage}
        onSelect={vi.fn()}
        onUnavailableAction={repair}
        recentIds={[]}
        selectedAssistantId={null}
      />
    );

    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search assistants" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: /Create from current setup/u }));
    expect(create).toHaveBeenCalledOnce();
    expect(screen.getByTestId("assistant-picker-actions")).toHaveTextContent(
      "Use applies to your next message only."
    );
    fireEvent.click(screen.getByRole("button", { name: /Manage in Library/u }));
    expect(manage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Fix in Settings…" }));
    expect(repair).toHaveBeenCalledWith("assistant-unavailable", "mcp-settings");
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
});
