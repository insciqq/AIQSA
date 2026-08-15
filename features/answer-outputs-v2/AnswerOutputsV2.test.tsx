import { fireEvent, render, screen } from "@testing-library/react";
import type { ThreadArtifactSummary } from "@/lib/contracts/chats";
import { describe, expect, it } from "vitest";
import { AnswerOutputsV2 } from "./AnswerOutputsV2";

const artifact: ThreadArtifactSummary = {
  citations: [{
    index: 1,
    source: "Research notes",
    title: "Cross-language retrieval",
    url: "https://example.com/retrieval"
  }],
  knowledgeCitations: [{
    baseName: "Engineering handbook",
    fileName: "retrieval-policy.pdf",
    handle: "K1.1",
    page: 18
  }],
  reasoningText: ["**Compared sources** without exposing the query."],
  sources: [{
    rank: 1,
    snippet: "Bounded safe snippet.",
    title: "Cross-language retrieval",
    url: "https://example.com/retrieval"
  }]
};

describe("answer outputs v2", () => {
  it("shows only safe Sources, Reasoning, and optional Assistant identity", () => {
    render(
      <AnswerOutputsV2
        artifact={artifact}
        identitySlot={<span>Quarterly analyst · revision 3</span>}
        showReasoning
      />
    );

    expect(screen.getByText("Quarterly analyst · revision 3")).toBeVisible();
    fireEvent.click(screen.getByText("Sources"));
    expect(screen.getByRole("link", { name: "Cross-language retrieval" })).toBeVisible();
    expect(screen.getByText("retrieval-policy.pdf")).toBeVisible();
    expect(screen.getByText("Engineering handbook · page 18")).toBeVisible();
    expect(screen.getByTestId("answer-reasoning").textContent).not.toContain("**");

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("private generated query");
    expect(text).not.toContain("Private Search route");
    expect(text).not.toContain("private-route-id");
    expect(text).not.toContain("private-call-id");
    expect(text).not.toContain("private-argument");
    expect(text).not.toContain("private-result");
    expect(text).not.toMatch(/invocation|threshold|candidate|Run details|Answer evidence/iu);
  });

  it("renders no placeholder when there is no output", () => {
    const { container } = render(
      <AnswerOutputsV2 artifact={null} showReasoning={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
