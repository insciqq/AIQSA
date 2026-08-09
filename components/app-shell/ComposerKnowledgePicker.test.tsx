import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseSummary } from "@/lib/contracts/knowledge";
import { ComposerKnowledgePicker } from "./ComposerKnowledgePicker";

function base(id: string, name: string, archived = false): KnowledgeBaseSummary {
  return {
    activeGeneration: {
      chunkingProfileVersion: 1,
      embeddingDeployment: null,
      embeddingDeploymentId: null,
      id: `generation-${id}`,
      indexedContentRevision: 1,
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    },
    archived,
    contentRevision: 1,
    description: `${name} documents`,
    id,
    name,
    owned: true,
    ownerDisplayName: "Owner",
    published: false,
    scope: { kind: "owner" },
    updatedAt: "2026-08-08T12:00:00.000Z",
    version: 1
  };
}

function Harness({ onChange }: { onChange(value: string[]): void }) {
  const [selected, setSelected] = useState(["missing-base", "archived"]);
  return (
    <ComposerKnowledgePicker
      bases={[base("active", "Policies"), base("archived", "Old handbook", true)]}
      dataError={null}
      dataState="ready"
      disabled={false}
      id="knowledge-test"
      onChange={(value) => {
        setSelected(value);
        onChange(value);
      }}
      onRetry={() => {}}
      selectedBaseIds={selected}
      source="assistant"
    />
  );
}

describe("ComposerKnowledgePicker", () => {
  it("retains unavailable selections and exposes the complete Assistant plan", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: /Knowledge: Unavailable retained base, Old handbook \(unavailable\). Assistant exact plan/ });
    expect(trigger).toHaveTextContent("0 active · 2 unavailable");
    fireEvent.click(trigger);

    expect(screen.getByText("Unavailable base")).toBeVisible();
    expect(screen.getByText("Archived · selection retained")).toBeVisible();
    expect(screen.getByText(/Changing this exact plan removes the Assistant/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", {
      name: "Remove unavailable retained Knowledge base, order 1"
    }));
    expect(onChange).toHaveBeenCalledWith(["archived"]);
  });

  it("enforces the three-base ceiling while preserving visible order", () => {
    const onChange = vi.fn();
    render(
      <ComposerKnowledgePicker
        bases={[
          base("one", "One"),
          base("two", "Two"),
          base("three", "Three"),
          base("four", "Four")
        ]}
        dataError={null}
        dataState="ready"
        disabled={false}
        id="knowledge-ceiling"
        onChange={onChange}
        onRetry={() => {}}
        selectedBaseIds={["one", "two", "three"]}
        source="explicit"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Knowledge: One, Two, Three/ }));
    expect(screen.getByLabelText("Order 1")).toHaveTextContent("#1");
    expect(screen.getByLabelText("Order 2")).toHaveTextContent("#2");
    expect(screen.getByLabelText("Order 3")).toHaveTextContent("#3");
    expect(screen.getByRole("button", { name: /Four/ })).toBeDisabled();
  });

  it("shows a load error with retry instead of reporting a true empty state", () => {
    const onRetry = vi.fn();
    render(
      <ComposerKnowledgePicker
        bases={[]}
        dataError="Knowledge catalog is unavailable."
        dataState="error"
        disabled={false}
        id="knowledge-error"
        onChange={() => {}}
        onRetry={onRetry}
        selectedBaseIds={[]}
        source="off"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Knowledge off/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Knowledge catalog is unavailable.");
    expect(screen.queryByText("No Knowledge bases are available.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps non-modal outside dismissal and the compact safe-area touch recipe", async () => {
    render(
      <div>
        <ComposerKnowledgePicker
          bases={[base("active", "Policies")]}
          dataError={null}
          dataState="ready"
          disabled={false}
          id="knowledge-geometry"
          onChange={vi.fn()}
          onRetry={vi.fn()}
          selectedBaseIds={[]}
          source="off"
        />
        <button type="button">Outside Knowledge picker</button>
      </div>
    );
    const trigger = screen.getByRole("button", { name: /Knowledge off/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Choose Knowledge bases" });
    const close = within(dialog).getByRole("button", { name: "Close Knowledge picker" });

    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-left");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-right");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-top");
    expect(dialog.className).toContain("--composer-picker-safe-area-inset-bottom");
    expect(close).toHaveClass(
      "size-11",
      "sm:size-8",
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside Knowledge picker" }));

    expect(screen.queryByRole("dialog", { name: "Choose Knowledge bases" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
