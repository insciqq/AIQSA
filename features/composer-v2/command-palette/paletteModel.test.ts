import { describe, expect, it } from "vitest";
import {
  composerPaletteQuery,
  filterComposerPaletteEntries,
  opensComposerPalette,
  type ComposerPaletteEntry
} from "./paletteModel";

function entry(id: string, section: ComposerPaletteEntry["section"], label: string, extra: Partial<ComposerPaletteEntry> = {}): ComposerPaletteEntry {
  return { id, label, run: () => undefined, section, ...extra };
}

describe("composer palette trigger", () => {
  it("reads a command only while the whole draft is one", () => {
    expect(composerPaletteQuery("/")).toBe("");
    expect(composerPaletteQuery("/sum")).toBe("sum");
    expect(composerPaletteQuery("/meeting notes")).toBe("meeting notes");
    expect(composerPaletteQuery("/etc/hosts")).toBe("etc/hosts");
    expect(composerPaletteQuery("")).toBeNull();
    expect(composerPaletteQuery("sum")).toBeNull();
    expect(composerPaletteQuery("see /sum")).toBeNull();
    expect(composerPaletteQuery("/ sum")).toBeNull();
    expect(composerPaletteQuery("/\tsum")).toBeNull();
    expect(composerPaletteQuery("/sum\nmore")).toBeNull();
  });

  it("opens only for a slash typed into an empty draft", () => {
    expect(opensComposerPalette("", "/")).toBe(true);
    expect(opensComposerPalette("Hello", "Hello /")).toBe(false);
    expect(opensComposerPalette("/", "//")).toBe(false);
    expect(opensComposerPalette("/ ", "/")).toBe(false);
    expect(opensComposerPalette("", "/sum")).toBe(false);
  });
});

describe("composer palette filter", () => {
  const entries = [
    entry("fact", "skills", "Fact check", { keywords: ["Check the summary claims"] }),
    entry("weekly", "skills", "Weekly summary"),
    entry("summarize", "skills", "Summarize sources"),
    entry("assistant", "assistants", "Summit planner"),
    entry("model", "models", "GPT-5.2"),
    entry("base", "actions", "Finance 2026", { queryOnly: true }),
    entry("attach", "actions", "Attach files")
  ];

  it("lists every section in its fixed order without a filter, leaving out filter-only entries", () => {
    const groups = filterComposerPaletteEntries(entries, "");
    expect(groups.map((group) => group.label)).toEqual(["Skills", "Actions", "Models", "Assistants"]);
    expect(groups[1]!.entries.map((item) => item.id)).toEqual(["attach"]);
  });

  it("matches case-insensitively, prefix before word prefix before keyword, and drops empty sections", () => {
    const groups = filterComposerPaletteEntries(entries, "SUM");
    expect(groups.map((group) => group.id)).toEqual(["skills", "assistants"]);
    expect(groups[0]!.entries.map((item) => item.id)).toEqual(["summarize", "weekly", "fact"]);
    expect(groups[1]!.entries.map((item) => item.id)).toEqual(["assistant"]);
  });

  it("finds a filter-only entry by its name and returns nothing for an unknown filter", () => {
    expect(filterComposerPaletteEntries(entries, "fin").flatMap((group) => group.entries.map((item) => item.id)))
      .toEqual(["base"]);
    expect(filterComposerPaletteEntries(entries, "zzz")).toEqual([]);
  });

  it("keeps the builder's order between equal matches and matches inside a label", () => {
    const groups = filterComposerPaletteEntries([
      entry("b", "actions", "Turn on Workspace"),
      entry("a", "actions", "Workspace secrets"),
      entry("c", "actions", "Myworkspace")
    ], "workspace");
    expect(groups[0]!.entries.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});
