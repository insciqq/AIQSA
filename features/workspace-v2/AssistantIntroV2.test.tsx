import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatHeaderGalleryAssistants } from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { AssistantIntroV2, AssistantStartersV2, clampTextToWordsV2, startersThatFitV2 } from "./AssistantIntroV2";

const [hr] = chatHeaderGalleryAssistants as [AssistantSummary];

describe("Assistant intro v2", () => {
  it("shows the avatar, name, description and who made it without a kicker", () => {
    render(<AssistantIntroV2 {...hr} owned={false} ownerDisplayName="Local Operator" />);
    const intro = screen.getByTestId("assistant-blank-intro");
    expect(within(intro).getByRole("heading", { level: 1 })).toHaveTextContent("HR Helper");
    expect(intro).toHaveTextContent("HR Helper for the chat header fixture.");
    expect(intro).toHaveTextContent("By Local Operator");
    expect(intro).not.toHaveTextContent(/^Assistant/u);
    expect(intro.querySelector("[data-testid='assistant-avatar']")).toHaveAttribute("width", "56");
  });

  it("says By you to the owner", () => {
    render(<AssistantIntroV2 {...hr} owned ownerDisplayName="Local Operator" />);
    expect(screen.getByTestId("assistant-blank-intro")).toHaveTextContent("By you");
    expect(screen.getByTestId("assistant-blank-intro")).not.toHaveTextContent("Local Operator");
  });

  it("shows the whole description as its title", () => {
    render(<AssistantIntroV2 {...hr} owned={false} ownerDisplayName="Local Operator" />);
    expect(screen.getByText("HR Helper for the chat header fixture.")).toHaveAttribute("title", "HR Helper for the chat header fixture.");
  });

  it("reads a Project's Assistant as the Project's", () => {
    const { rerender } = render(<AssistantIntroV2 {...hr} owned={false} ownerDisplayName="Project" projectName="Launch plan" />);
    expect(screen.getByTestId("assistant-blank-intro")).toHaveTextContent("Project “Launch plan”");
    expect(screen.getByTestId("assistant-blank-intro")).not.toHaveTextContent("By Project");
    rerender(<AssistantIntroV2 {...hr} owned={false} ownerDisplayName="Project" projectName={null} />);
    expect(screen.getByTestId("assistant-blank-intro").querySelector(".v2-live-assistant-by")).toHaveTextContent(/^Project$/u);
  });
});

describe("Assistant intro v2 clamped at a word", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cuts the name and the description after whole words to their clamped lines and keeps both whole for assistive technology", () => {
    const name = "Quarterly procurement and compliance reviewer for EMEA suppliers";
    const description = "Reviews supplier contracts, purchase orders and renewal notices against the regional procurement policy.";
    // Both are clamped to two 20 px lines; a line of the 300 px intro holds 30 characters.
    const realStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) =>
      element.matches(".v2-live-assistant-intro > h1, .v2-live-assistant-intro > .v2-live-assistant-description")
        ? { getPropertyValue: (property: string) => property === "-webkit-line-clamp" ? "2" : "", lineHeight: "20px", maxWidth: "none" } as unknown as CSSStyleDeclaration
        : realStyle(element, pseudo));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "assistant-blank-intro" ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const probe = this.getAttribute("aria-hidden") === "true" && this.parentElement?.dataset.testid === "assistant-blank-intro";
      const height = probe ? Math.ceil((this.textContent?.length ?? 0) / 30) * 20 : 0;
      return { bottom: height, height, left: 0, right: 0, toJSON: () => ({}), top: 0, width: 0, x: 0, y: 0 };
    });
    render(<AssistantIntroV2 {...hr} description={description} name={name} owned={false} ownerDisplayName="Local Operator" />);

    const intro = screen.getByTestId("assistant-blank-intro");
    const heading = within(intro).getByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName(name);
    expect(heading.querySelector("[aria-hidden='true']")).toHaveTextContent(/^Quarterly procurement and compliance reviewer for EMEA…$/u);
    const shown = intro.querySelector(".v2-live-assistant-description")!;
    expect(shown).toHaveAttribute("title", description);
    // "renewal notices…" would take a third line.
    expect(shown.querySelector("[aria-hidden='true']")).toHaveTextContent(/^Reviews supplier contracts, purchase orders and renewal…$/u);
    expect(shown.querySelector(".v2-sr-only")).toHaveTextContent(description);
    // The measuring copies are gone.
    expect(intro.children).toHaveLength(4);
  });
});

describe("clamp text to words", () => {
  const upTo = (length: number) => (candidate: string) => candidate.length <= length;

  it("keeps the whole text when it fits", () => {
    expect(clampTextToWordsV2("Plans the week", upTo(20))).toBeNull();
  });

  it("cuts after the last whole word that fits with the ellipsis, dropping the punctuation that ended it", () => {
    expect(clampTextToWordsV2("Reviews supplier contracts, purchase orders and renewal notices", upTo(30)))
      .toBe("Reviews supplier contracts…");
    expect(clampTextToWordsV2("Reviews supplier contracts, purchase orders and renewal notices", upTo(40)))
      .toBe("Reviews supplier contracts, purchase…");
  });

  it("cuts a first word too long for the room by characters", () => {
    expect(clampTextToWordsV2("Supercalifragilistic reviewer", upTo(6))).toBe("Super…");
    expect(clampTextToWordsV2("Supercalifragilistic", upTo(6))).toBe("Super…");
    expect(clampTextToWordsV2("Supercalifragilistic", upTo(0))).toBe("…");
  });
});

describe("Assistant starters v2", () => {
  const prompts = ["One", "Two", "Three", "Four", "Five"];

  it("offers up to four starters and sends the one clicked", () => {
    const onSend = vi.fn();
    render(<AssistantStartersV2 idle onSend={onSend} prompts={prompts} restoreFocus={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Starter prompts" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["One", "Two", "Three", "Four"]);
    fireEvent.click(within(group).getByRole("button", { name: "Three" }));
    expect(onSend).toHaveBeenCalledWith("Three");
  });

  it("keeps its space without offering a starter while a draft exists", () => {
    const { rerender } = render(<AssistantStartersV2 idle onSend={vi.fn()} prompts={prompts} restoreFocus={vi.fn()} />);
    rerender(<AssistantStartersV2 idle={false} onSend={vi.fn()} prompts={prompts} restoreFocus={vi.fn()} />);
    expect(screen.getByTestId("assistant-starter-prompts")).toHaveAttribute("data-reserved");
    expect(screen.queryByRole("button", { name: "One" })).toBeNull();
  });
});

describe("starters that fit", () => {
  const pill = (width: number, height = 32) => ({ height, width });
  const fit = (room: number, pills: { height: number; width: number }[]) =>
    startersThatFitV2({ available: 700, columnGap: 6, pills, room, rowGap: 6 });

  it("lets short starters share a line", () => {
    expect(fit(32, [pill(100), pill(150), pill(140)])).toBe(3);
  });

  it("starts the next line with a starter that does not fit and stops at the last line that fits", () => {
    expect(fit(70, [pill(400), pill(400), pill(400)])).toBe(2);
    expect(fit(108, [pill(400), pill(400), pill(400)])).toBe(3);
  });

  it("gives a starter wider than the row the row's width", () => {
    expect(fit(70, [pill(900), pill(100), pill(100)])).toBe(3);
    expect(fit(32, [pill(900), pill(100)])).toBe(1);
  });

  it("counts a two-line starter at its own height, and its line at the tallest pill", () => {
    // A two-line starter (44 px) alone on its line, then two short ones sharing the next.
    expect(fit(82, [pill(700, 44), pill(100), pill(100)])).toBe(3);
    expect(fit(81, [pill(700, 44), pill(100), pill(100)])).toBe(1);
    // Three two-line starters of 200 characters take 3 x 44 + 2 x 6 px.
    expect(fit(144, [pill(700, 44), pill(700, 44), pill(700, 44)])).toBe(3);
    expect(fit(143, [pill(700, 44), pill(700, 44), pill(700, 44)])).toBe(2);
    // A short starter beside a taller one makes no taller line.
    expect(fit(44, [pill(300, 44), pill(100)])).toBe(2);
  });

  it("offers nothing when not even one line fits", () => {
    expect(fit(20, [pill(100)])).toBe(0);
  });
});

describe("Assistant starters v2 in the blank chat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A phone on its side: a 390 px scroll area holding a 120 px intro and a
   * composer block that is 226 px high without the starters, so one 32 px
   * line of starters fits and a second would scroll the page.
   */
  let composerHeight = 226;

  function starters(idle: boolean) {
    return (
      <div data-testid="scroll">
        <div className="v2-conversation-orientation">
          <div data-testid="intro" />
          <div data-testid="composer">
            <AssistantStartersV2 idle={idle} onSend={vi.fn()} prompts={["One", "Two", "Three"]} restoreFocus={vi.fn()} />
          </div>
        </div>
      </div>
    );
  }

  function blankChat(scrollHeight = 390) {
    composerHeight = 226;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "assistant-starter-prompts" ? 700 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "scroll" ? scrollHeight : 0;
    });
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
      return [{}] as unknown as DOMRectList;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const size = this.dataset.testid === "intro" ? { height: 120, width: 700 }
        : this.dataset.testid === "composer" ? { height: composerHeight + 32, width: 700 }
          : this.dataset.testid === "assistant-starter-prompts" ? { height: 32, width: 700 }
            : this.matches("[data-testid='assistant-starter-prompts'] > button") ? { height: 32, width: 300 }
              : { height: 0, width: 0 };
      return { bottom: size.height, left: 0, right: size.width, toJSON: () => ({}), top: 0, x: 0, y: 0, ...size };
    });
    return render(starters(true));
  }

  it("offers only the starters that fit whole; the rest are neither shown, focusable nor announced", () => {
    blankChat();
    const group = screen.getByRole("group", { name: "Starter prompts" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["One", "Two"]);
    const left = screen.getByText("Three").closest("button")!;
    expect(left).toHaveAttribute("data-overflow");
    expect(left).toHaveAttribute("inert");
    expect(left).toHaveAttribute("tabindex", "-1");
  });

  it("keeps the room it reserved while a draft hides the row, and measures again once it is shown", () => {
    const { rerender } = blankChat();
    rerender(starters(false));
    // A taller draft leaves no line for starters; the hidden row keeps its count.
    composerHeight = 300;
    rerender(starters(false));
    expect(screen.getByText("Two").closest("button")).not.toHaveAttribute("data-overflow");

    rerender(starters(true));
    expect(screen.getByText("One").closest("button")).toHaveAttribute("data-overflow");
  });

  it("offers every starter where the blank chat has room for them", () => {
    blankChat(600);
    const group = screen.getByRole("group", { name: "Starter prompts" });
    expect(within(group).getAllByRole("button")).toHaveLength(3);
  });

  it("names a starter cut after two lines whole in its title and keeps its whole text as its name", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("v2-composer-indicator-label") && this.textContent === "Two" ? 60 : 0;
    });
    blankChat(600);
    expect(screen.getByRole("button", { name: "Two" })).toHaveAttribute("title", "Two");
    expect(screen.getByRole("button", { name: "One" })).not.toHaveAttribute("title");
  });
});
