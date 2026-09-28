import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatIntroV2Gallery } from "@/app/ui-v2-fixture/_fixtures/ChatIntroV2Gallery";

describe("Blank chat intro gallery", () => {
  it("offers pinned then Featured Assistants and turns a click into the intro with starters", () => {
    render(<ChatIntroV2Gallery state="strip" />);
    const strip = screen.getByRole("group", { name: "Pinned and Featured Assistants" });
    // Without layout every pill fits; the browser keeps only what fits in two lines.
    expect(within(strip).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "HR Helper",
      "Meeting notes",
      "Quarterly procurement and compliance reviewer for EMEA suppliers",
      "Travel and expense policy assistant for field teams",
      "Onboarding buddy",
      "Code reviewer",
      "Research analyst",
      "Customer escalation summarizer for enterprise accounts",
      "SQL helper",
      "Release notes writer",
      "Brand voice editor",
      "Security questionnaire drafter",
      "Interview kit builder",
      "All Assistants…"
    ]);

    fireEvent.click(within(strip).getByRole("button", { name: "HR Helper" }));
    expect(screen.queryByTestId("assistant-strip")).toBeNull();
    expect(screen.getByTestId("assistant-blank-intro")).toHaveTextContent("By you");
    expect(within(screen.getByRole("group", { name: "Starter prompts" })).getAllByRole("button")).toHaveLength(4);
  });

  it("shows no strip without pinned or Featured Assistants", () => {
    render(<ChatIntroV2Gallery state="no-strip" />);
    expect(screen.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
    expect(screen.queryByTestId("assistant-strip")).toBeNull();
  });

  it("keeps the starters' space while a draft is typed", () => {
    render(<ChatIntroV2Gallery state="intro-long" />);
    expect(screen.getByTestId("assistant-blank-intro")).toHaveTextContent("By Dana Ivanova");
    expect(screen.getByTestId("assistant-blank-intro").querySelector(".v2-live-assistant-description")?.textContent?.length)
      .toBeGreaterThanOrEqual(400);
    // The longest starter keeps its whole text as its name, however it is cut on screen.
    const longest = within(screen.getByRole("group", { name: "Starter prompts" })).getAllByRole("button")[0]!;
    expect(longest).toHaveAccessibleName(/^Check this supplier contract .* any reviewer can verify\.$/u);
    expect(longest.textContent).toHaveLength(200);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Draft" } });
    expect(screen.getByTestId("assistant-starter-prompts")).toHaveAttribute("data-reserved");
  });

  it("shows the identity chip only where the Assistant changes", () => {
    render(<ChatIntroV2Gallery state="identity" />);
    expect(screen.getAllByTestId("answer-assistant-identity").map((chip) => chip.textContent))
      .toEqual(["HR Helper", "Code reviewer", "No Assistant"]);
  });
});
