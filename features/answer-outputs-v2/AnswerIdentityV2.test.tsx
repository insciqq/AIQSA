import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AssistantAvatarRecipe, AssistantIdentity } from "@/lib/contracts/assistants";
import { AnswerIdentityChipV2, answerIdentityV2, previousVisibleAnswersV2 } from "./AnswerIdentityV2";

const ocean: AssistantAvatarRecipe = {
  accents: [1],
  backgroundShape: "circle",
  foregroundShape: "ring",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 1]
};
const analyst: AssistantIdentity = { avatar: ocean, name: "Quarterly analyst" };
const reviewer: AssistantIdentity = { avatar: { ...ocean, paletteId: "plum" }, name: "Code reviewer" };

function answer(id: string, assistantIdentity?: AssistantIdentity | null) {
  return { id, role: "assistant", ...(assistantIdentity !== undefined ? { assistantIdentity } : {}) };
}

describe("Answer identity v2", () => {
  it("leads the first answer of a branch only when it has an Assistant", () => {
    expect(answerIdentityV2({ assistantIdentity: analyst }, null))
      .toEqual({ avatar: ocean, kind: "assistant", label: "Quarterly analyst" });
    expect(answerIdentityV2({ assistantIdentity: null }, null)).toBeNull();
  });

  it("stays hidden while the snapshot matches the previous visible answer", () => {
    expect(answerIdentityV2({ assistantIdentity: analyst }, { assistantIdentity: { ...analyst, avatar: { ...ocean } } })).toBeNull();
    expect(answerIdentityV2({ assistantIdentity: null }, { assistantIdentity: null })).toBeNull();
  });

  it("shows wherever the name or the avatar changes, including to and from no Assistant", () => {
    expect(answerIdentityV2({ assistantIdentity: reviewer }, { assistantIdentity: analyst })?.label).toBe("Code reviewer");
    expect(answerIdentityV2(
      { assistantIdentity: { ...analyst, avatar: { ...ocean, accents: [1, 4] } } },
      { assistantIdentity: analyst }
    )?.kind).toBe("assistant");
    expect(answerIdentityV2({ assistantIdentity: null }, { assistantIdentity: analyst }))
      .toEqual({ kind: "none", label: "No Assistant" });
    expect(answerIdentityV2({ assistantIdentity: analyst }, { assistantIdentity: null })?.label).toBe("Quarterly analyst");
  });

  it("waits for a live answer's snapshot instead of guessing a change", () => {
    expect(answerIdentityV2({}, { assistantIdentity: analyst })).toBeNull();
    expect(answerIdentityV2({}, null)).toBeNull();
  });

  it("compares each answer with the previous known answer of the branch, skipping questions", () => {
    const messages = [
      { id: "q1", role: "user" },
      answer("a1", analyst),
      { id: "q2", role: "user" },
      answer("a2", analyst),
      answer("a3", null),
      answer("live")
    ];
    const previous = previousVisibleAnswersV2(messages);
    expect(previous.get("a1")).toBeNull();
    expect(previous.get("a2")?.id).toBe("a1");
    expect(previous.get("a3")?.id).toBe("a2");
    expect(previous.get("live")?.id).toBe("a3");
    expect(previous.has("q2")).toBe(false);
    expect(messages.filter((message) => message.role === "assistant")
      .map((message) => answerIdentityV2(message, previous.get(message.id) ?? null)?.label ?? null))
      .toEqual(["Quarterly analyst", null, "No Assistant", null]);
  });

  it("renders the Assistant's avatar and name, or the neutral change to no Assistant", () => {
    const { rerender } = render(<AnswerIdentityChipV2 identity={{ avatar: ocean, kind: "assistant", label: "Quarterly analyst" }} />);
    const chip = screen.getByTestId("answer-assistant-identity");
    expect(chip).toHaveTextContent("Quarterly analyst");
    expect(chip).toHaveAttribute("data-identity", "assistant");
    expect(chip.querySelector("[data-testid='assistant-avatar']")).not.toBeNull();

    rerender(<AnswerIdentityChipV2 identity={{ kind: "none", label: "No Assistant" }} />);
    expect(screen.getByTestId("answer-assistant-identity")).toHaveTextContent("No Assistant");
    expect(screen.getByTestId("answer-assistant-identity")).toHaveAttribute("data-identity", "none");
  });
});
