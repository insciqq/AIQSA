import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatHeaderGalleryAssistants } from "@/app/ui-v2-fixture/_fixtures/ChatHeaderV2Gallery";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import {
  ASSISTANT_STRIP_MIN_CHARACTERS,
  AssistantStripV2,
  assistantStripFitV2,
  assistantStripItemsV2,
  assistantStripMinPillWidthV2
} from "./AssistantStripV2";

const [base] = chatHeaderGalleryAssistants as [AssistantSummary];

function assistant(id: string, overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return { ...base, id, name: id, owned: false, pinned: false, ...overrides };
}

function strip(props: Partial<Parameters<typeof AssistantStripV2>[0]> = {}) {
  const handlers = { onChoose: vi.fn(), onOpenPicker: vi.fn(), restoreFocus: vi.fn() };
  const items = [assistant("HR Helper", { pinned: true }), assistant("Code reviewer", { featured: true, featuredOrder: 0 })];
  return { handlers, items, element: <AssistantStripV2 idle items={items} {...handlers} {...props} /> };
}

describe("Assistant strip items v2", () => {
  it("offers up to five pinned, then Featured in Featured order, each once and never a recent", () => {
    const list = [
      assistant("featured-late", { featured: true, featuredOrder: 3 }),
      ...["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => assistant(id, { pinned: true })),
      assistant("pinned-and-featured", { featured: true, featuredOrder: 0, pinned: true }),
      assistant("featured-first", { featured: true, featuredOrder: 1 }),
      assistant("recent-only")
    ];
    expect(assistantStripItemsV2(list).map((item) => item.id))
      .toEqual(["p1", "p2", "p3", "p4", "p5", "featured-first", "featured-late"]);
  });

  it("leaves out archived and unavailable Assistants", () => {
    const list = [
      assistant("archived", { archived: true, pinned: true }),
      assistant("unavailable", { availability: { ok: false, reason: "tools_access" }, featured: true, featuredOrder: 0 }),
      assistant("usable", { featured: true, featuredOrder: 1 })
    ];
    expect(assistantStripItemsV2(list).map((item) => item.id)).toEqual(["usable"]);
    expect(assistantStripItemsV2([assistant("recent-only")])).toEqual([]);
  });
});

describe("Assistant strip minimum pill width v2", () => {
  it("keeps sixteen characters and the ellipsis (two characters wide) at the name's average character width", () => {
    expect(ASSISTANT_STRIP_MIN_CHARACTERS).toBe(16);
    // 51 characters 306 px wide (6 px each), capped at 224 px in a 260 px pill: 36 px of avatar and padding.
    expect(assistantStripMinPillWidthV2({ characters: 51, labelWidth: 306, natural: 260, naturalLabelWidth: 224 }))
      .toBe(36 + (16 + 2) * 6);
  });

  it("never shortens a name of sixteen characters or fewer, one no longer than sixteen and the ellipsis, nor one it could not measure", () => {
    expect(assistantStripMinPillWidthV2({ characters: 16, labelWidth: 96, natural: 132, naturalLabelWidth: 96 })).toBe(132);
    expect(assistantStripMinPillWidthV2({ characters: 18, labelWidth: 108, natural: 144, naturalLabelWidth: 108 })).toBe(144);
    expect(assistantStripMinPillWidthV2({ characters: 40, labelWidth: 0, natural: 120, naturalLabelWidth: 0 })).toBe(120);
  });
});

describe("Assistant strip fit v2", () => {
  const gap = 6;
  const linkWidth = 117;
  /** A long name keeps 142 px when shortened (its measured minimum). */
  const LONG_MIN = 142;
  /** Names of sixteen characters or fewer are never shortened: their minimum is their width. */
  const fit = (available: number, widths: readonly number[], minimums: readonly number[] = widths) =>
    assistantStripFitV2({ available, gap, linkWidth, minimums, widths });
  const unchanged = (count: number) => Array.from({ length: count }, () => null);

  it("shortens a long pill only where it keeps sixteen characters, and leaves out a stump (390 x 844 measurement)", () => {
    // HR Helper, Meeting notes, the long procurement name, another long name, Onboarding buddy.
    const measured = [101, 128, 260, 259, 140];
    const minimums = [101, 128, LONG_MIN, LONG_MIN, 140];
    // The first row keeps 125 px beside the short names, below the long name's minimum:
    // it starts the second row, shortened to the 243 px beside the link, and the rest are left out.
    expect(fit(366, measured, minimums)).toEqual({ count: 3, limits: [null, null, 243] });
    expect(fit(660, measured, minimums)).toEqual({ count: 5, limits: [null, null, null, 153, null] });
    expect(fit(740, measured, minimums)).toEqual({ count: 5, limits: [null, null, null, 233, null] });
  });

  it("keeps thirteen short names in two rows with the link last", () => {
    const short = Array.from({ length: 13 }, () => 100);
    expect(fit(366, short)).toEqual({ count: 5, limits: unchanged(5) });
    expect(fit(660, short)).toEqual({ count: 11, limits: unchanged(11) });
    expect(fit(740, short)).toEqual({ count: 12, limits: unchanged(12) });
  });

  it("shortens thirteen long names only down to their minimum and leaves out the rest", () => {
    const long = Array.from({ length: 13 }, () => 263);
    const minimums = long.map(() => LONG_MIN);
    expect(fit(366, long, minimums)).toEqual({ count: 2, limits: [null, 243] });
    expect(fit(660, long, minimums)).toEqual({ count: 4, limits: unchanged(4) });
    expect(fit(740, long, minimums)).toEqual({ count: 5, limits: [null, null, 202, null, null] });
  });

  it("starts the second row with a pill that does not fit even shortened, and leaves out the rest", () => {
    // The first row keeps 60 px, below the minimum: the next pill wraps whole.
    expect(fit(366, [300, 200, 200], [LONG_MIN, LONG_MIN, LONG_MIN])).toEqual({ count: 2, limits: [null, null] });
    // Beside the link the second row keeps 243 px: a longer pill is shortened to it.
    expect(fit(366, [300, 260], [LONG_MIN, LONG_MIN])).toEqual({ count: 2, limits: [null, 243] });
    expect(fit(366, [300, 90, 200, 100], [LONG_MIN, 90, LONG_MIN, 100])).toEqual({ count: 3, limits: [null, null, 147] });
    // 141 px beside the link is one pixel short of the minimum: the pill is left out, not cut to a stump.
    expect(fit(366, [300, 96, 200], [LONG_MIN, 96, LONG_MIN])).toEqual({ count: 2, limits: [null, null] });
  });

  it("caps a pill wider than the strip at the strip's width", () => {
    expect(fit(200, [260], [LONG_MIN])).toEqual({ count: 1, limits: [200] });
  });

  it("never shortens a short name: it wraps or is left out whole", () => {
    expect(fit(366, [300, 120, 250], [LONG_MIN, 120, 250])).toEqual({ count: 2, limits: [null, null] });
  });
});

describe("Assistant strip v2", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves out the pills past two lines so they are neither focusable nor announced", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "assistant-strip" ? 358 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-strip-all") ? 100
        : this.hasAttribute("data-strip-item") ? this.textContent === "long" ? 300 : 170 : 0;
      return { bottom: 0, height: 0, left: 0, right: width, toJSON: () => ({}), top: 0, width, x: 0, y: 0 };
    });
    const { handlers } = strip();
    const items = ["one", "two", "three", "four", "five"].map((id) => assistant(id, { pinned: true }));
    render(<AssistantStripV2 idle items={items} {...handlers} />);

    const group = screen.getByRole("group", { name: "Pinned and Featured Assistants" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["one", "two", "three", "All Assistants…"]);
    const overflow = screen.getByText("four").closest("button")!;
    expect(overflow).toHaveAttribute("data-overflow");
    expect(overflow).toHaveAttribute("inert");
    expect(overflow).toHaveAttribute("tabindex", "-1");
  });

  it("chooses an Assistant in one click and opens the picker from its last item", () => {
    const { element, handlers } = strip();
    render(element);
    const group = screen.getByRole("group", { name: "Pinned and Featured Assistants" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["HR Helper", "Code reviewer", "All Assistants…"]);
    fireEvent.click(within(group).getByRole("button", { name: "Code reviewer" }));
    expect(handlers.onChoose).toHaveBeenCalledWith("Code reviewer");
    fireEvent.click(within(group).getByRole("button", { name: "All Assistants…" }));
    expect(handlers.onOpenPicker).toHaveBeenCalledOnce();
  });

  it("shortens a long pill to the room beside the link, names it whole in its title, and leaves out the rest", () => {
    // Without the stylesheet the gap is 0: the second row keeps 358 - 100 px.
    // Names are 6 px a character, pills 40 px wider than their names.
    const LONG = "Travel and expense policy assistant for field teams";
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "assistant-strip" ? 358 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("v2-composer-indicator-label") ? (this.textContent?.length ?? 0) * 6 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = (this.textContent?.length ?? 0) * 6;
      const width = this.hasAttribute("data-strip-all") ? 100
        : this.hasAttribute("data-strip-item") ? name + 40
          : this.classList.contains("v2-composer-indicator-label") ? name : 0;
      return { bottom: 0, height: 0, left: 0, right: width, toJSON: () => ({}), top: 0, width, x: 0, y: 0 };
    });
    const { handlers } = strip();
    // 160 + 142 px fill the first row; the long name (346 px) keeps 258 px beside the link,
    // above its 148 px minimum (40 px, then sixteen characters and the ellipsis at 6 px a character).
    const items = ["Code reviewer helper", "Meeting notes kit", LONG, "four"].map((id) => assistant(id, { pinned: true }));
    render(<AssistantStripV2 idle items={items} {...handlers} />);

    const long = screen.getByRole("button", { name: LONG });
    expect(long).toHaveStyle({ maxWidth: "258px" });
    expect(long).toHaveAttribute("title", LONG);
    expect(screen.getByRole("button", { name: "Meeting notes kit" })).not.toHaveAttribute("title");
    expect(screen.getByText("four").closest("button")).toHaveAttribute("data-overflow");
    expect(screen.getByText("four").closest("button")).not.toHaveAttribute("title");
  });

  it("keeps its space hidden while the user types and never appears late over a draft", () => {
    const { element, handlers, items } = strip({ idle: false });
    const { rerender } = render(element);
    expect(screen.queryByTestId("assistant-strip")).toBeNull();

    rerender(<AssistantStripV2 idle items={items} {...handlers} />);
    const row = screen.getByTestId("assistant-strip");
    expect(row).not.toHaveAttribute("data-reserved");
    expect(row).not.toHaveAttribute("aria-hidden");

    rerender(<AssistantStripV2 idle={false} items={items} {...handlers} />);
    expect(screen.getByTestId("assistant-strip")).toHaveAttribute("data-reserved");
    expect(screen.getByTestId("assistant-strip")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("assistant-strip")).toHaveAttribute("inert");
    expect(screen.queryByRole("group", { name: "Pinned and Featured Assistants" })).toBeNull();
  });

  it("hands focus back to the composer when a choice removes it", () => {
    vi.useFakeTimers();
    try {
      const { element, handlers } = strip();
      const { rerender } = render(element);
      screen.getByRole("button", { name: "HR Helper" }).focus();
      rerender(<></>);
      act(() => { vi.runAllTimers(); });
      expect(handlers.restoreFocus).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
