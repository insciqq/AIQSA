import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HeaderModelSelectorV2 } from "@/features/workspace-v2/WorkspaceHeaderV2";
import { composerGalleryConfig } from "@/app/ui-v2-fixture/_fixtures/ComposerV2Gallery";
import { ComposerV2, type ComposerV2Layer, type ComposerV2LayerController } from "./ComposerV2";

type Review = Parameters<typeof ComposerV2>[0]["answerReview"];

/** The header model selector as the shell renders it, opening the composer's model layer. */
function HeaderAndComposer({ answerReview, review }: Readonly<{
  answerReview: Review;
  review?: Readonly<{ count: number; label: string; state: "on" | "unavailable" }> | null;
}>) {
  const controller = useRef<ComposerV2LayerController | null>(null);
  const [layer, setLayer] = useState<ComposerV2Layer>(null);
  return (
    <>
      <HeaderModelSelectorV2 selector={{
        expanded: layer === "model",
        family: "openai",
        label: "OpenAI",
        name: "GPT-5.2",
        onToggle: (anchor) => controller.current?.toggle("model", anchor),
        review
      }} />
      <ComposerV2 answerReview={answerReview} config={composerGalleryConfig} draft="" layerController={controller}
        onDraftChange={vi.fn()} onLayerChange={setLayer} onSelectModel={vi.fn()} selectedModelId="gpt-5.2"
        selectedProvider="openai-work" />
    </>
  );
}

describe("answer review in the model picker and the header chip", () => {
  it("shows the review glyph with its reviewers' count and label in the header model chip", () => {
    render(<HeaderAndComposer answerReview={null} review={{ count: 2, label: "Review: GPT-5, Gemini, up to 3 rounds", state: "on" }} />);
    const trigger = screen.getByTestId("header-model-trigger");
    const glyph = within(trigger).getByTestId("header-model-review");
    expect(glyph).toHaveAttribute("data-state", "on");
    expect(glyph).toHaveTextContent("2");
    expect(trigger).toHaveAccessibleName(/Review: GPT-5, Gemini, up to 3 rounds/u);
    expect(trigger).toHaveAttribute("title", "Choose model · Review: GPT-5, Gemini, up to 3 rounds");
  });

  it("shows no glyph while review is off", () => {
    render(<HeaderAndComposer answerReview={null} review={null} />);
    expect(screen.queryByTestId("header-model-review")).toBeNull();
  });

  it("opens the review settings from the picker's row and closes the picker", () => {
    const onOpen = vi.fn();
    render(<HeaderAndComposer answerReview={{ onOpen, summary: "On · 1 reviewer · up to 3 rounds" }} />);
    fireEvent.click(screen.getByTestId("header-model-trigger"));
    const picker = screen.getByRole("dialog", { name: "Choose model" });
    const row = within(picker).getByTestId("composer-v2-model-answer-review");
    expect(row).toHaveTextContent("Answer review");
    expect(row).toHaveTextContent("On · 1 reviewer · up to 3 rounds");
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
  });

  it("disables the row with its reason where review is unavailable", () => {
    render(<HeaderAndComposer answerReview={{ disabledReason: "Review is off while Agent is on.", onOpen: vi.fn(), summary: "On" }} />);
    fireEvent.click(screen.getByTestId("header-model-trigger"));
    const picker = screen.getByRole("dialog", { name: "Choose model" });
    expect(within(picker).getByTestId("composer-v2-model-answer-review")).toBeDisabled();
    expect(within(picker).getByTestId("composer-v2-model-answer-review-reason")).toHaveTextContent("Review is off while Agent is on.");
  });
});
