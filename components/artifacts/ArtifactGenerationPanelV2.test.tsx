import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactGenerationPanelV2 } from "./ArtifactGenerationPanelV2";
import type { ArtifactGenerationDraft } from "./artifactGenerationState";

describe("artifact code in flight", () => {
  it("renders code as inert text, follows new fragments and stops following when the user reads earlier code", () => {
    const draft: ArtifactGenerationDraft = { draftId: "draft", title: "Counter", status: "pending", files: [{ index: 0, path: "index.html", text: "<script>window.bad=1</script>", byteSize: 27 }] };
    const { rerender } = render(<ArtifactGenerationPanelV2 draft={draft} compact={false} />);
    const code = screen.getByLabelText("index.html");
    expect(code).toHaveTextContent("<script>window.bad=1</script>");
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    Object.defineProperty(code, "scrollHeight", { value: 500, configurable: true });
    rerender(<ArtifactGenerationPanelV2 draft={{ ...draft, files: [{ ...draft.files[0], text: "<p>More</p>" }] }} compact={false} />);
    expect(code.scrollTop).toBe(500);
    fireEvent.wheel(code, { deltaY: -100 });
    code.scrollTop = 10;
    rerender(<ArtifactGenerationPanelV2 draft={{ ...draft, files: [{ ...draft.files[0], text: "<p>Later</p>" }] }} compact />);
    expect(code.scrollTop).toBe(10);
    expect(screen.getByRole("button", { name: "Follow code" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Follow code" }));
    expect(code.scrollTop).toBe(500);
    expect(screen.getByRole("button", { name: "Close artifact" })).toBeVisible();
  });
});
