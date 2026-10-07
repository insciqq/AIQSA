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
    // Beside the link the row keeps 136 px after the two short names: the long name's
    // 142 px minimum does not fit, so it and every later pill are left out.
    expect(fit(366, measured, minimums)).toEqual({ count: 2, limits: [null, null] });
    expect(fit(660, measured, minimums)).toEqual({ count: 3, limits: [null, null, null] });
    expect(fit(740, measured, minimums)).toEqual({ count: 3, limits: [null, null, null] });
    // At 780 px the second long name keeps its minimum and is shortened to the 150 px left.
    expect(fit(780, measured, minimums)).toEqual({ count: 4, limits: [null, null, null, 150] });
  });

  it("keeps thirteen short names in one row with the link last", () => {
    const short = Array.from({ length: 13 }, () => 100);
    expect(fit(366, short)).toEqual({ count: 2, limits: unchanged(2) });
    expect(fit(660, short)).toEqual({ count: 5, limits: unchanged(5) });
    expect(fit(740, short)).toEqual({ count: 5, limits: unchanged(5) });
  });

  it("shortens thirteen long names only down to their minimum and leaves out the rest", () => {
    const long = Array.from({ length: 13 }, () => 263);
    const minimums = long.map(() => LONG_MIN);
    expect(fit(366, long, minimums)).toEqual({ count: 1, limits: [243] });
    expect(fit(660, long, minimums)).toEqual({ count: 2, limits: unchanged(2) });
    expect(fit(740, long, minimums)).toEqual({ count: 2, limits: unchanged(2) });
  });

  it("keeps order: a pill that does not fit even shortened ends the row, and a later shorter one is left out too", () => {
    // 136 px remain beside the link after the first pill.
    expect(fit(366, [101, 200, 20], [101, LONG_MIN, 20])).toEqual({ count: 1, limits: [null] });
    // A long pill whose minimum fits there is shortened to the room.
    expect(fit(366, [101, 200, 20], [101, 120, 20])).toEqual({ count: 2, limits: [null, 136] });
    // One pixel short of the minimum: the pill is left out, not cut to a stump.
    expect(fit(366, [101, 200], [101, 137])).toEqual({ count: 1, limits: [null] });
  });

  it("shortens a pill wider than the strip to the room beside the link", () => {
    expect(fit(400, [400], [LONG_MIN])).toEqual({ count: 1, limits: [277] });
  });

  it("never shortens a short name: it is left out whole", () => {
    expect(fit(366, [101, 150], [101, 150])).toEqual({ count: 1, limits: [null] });
  });
});

describe("Assistant strip v2", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves out the pills past one row so they are neither focusable nor announced", () => {
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
    // 358 px less the 100 px link keep one 170 px pill.
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["one", "All Assistants…"]);
    const overflow = screen.getByText("two").closest("button")!;
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
    // Without the stylesheet the gap is 0: the row keeps 500 - 100 px beside the link.
    // Names are 6 px a character, pills 40 px wider than their names.
    const LONG = "Travel and expense policy assistant for field teams";
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "assistant-strip" ? 500 : 0;
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
    // After the 160 px first pill the long name (346 px) keeps 240 px beside the link,
    // above its 148 px minimum (40 px, then sixteen characters and the ellipsis at 6 px a character).
    const items = ["Code reviewer helper", LONG, "four"].map((id) => assistant(id, { pinned: true }));
    render(<AssistantStripV2 idle items={items} {...handlers} />);

    const long = screen.getByRole("button", { name: LONG });
    expect(long).toHaveStyle({ maxWidth: "240px" });
    expect(long).toHaveAttribute("title", LONG);
    expect(screen.getByRole("button", { name: "Code reviewer helper" })).not.toHaveAttribute("title");
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
