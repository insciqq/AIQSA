import type { UiV2IconName } from "@/components/ui-v2";

/** The palette's groups, always in this order; empty groups are left out. */
export const COMPOSER_PALETTE_SECTIONS = [
  { id: "skills", label: "Skills" },
  { id: "actions", label: "Actions" },
  { id: "models", label: "Models" },
  { id: "assistants", label: "Assistants" }
] as const;

export type ComposerPaletteSectionId = typeof COMPOSER_PALETTE_SECTIONS[number]["id"];

/**
 * One `/` palette entry: a keyboard route into an action the composer, its
 * chips or the header selectors already offer, with that action's own
 * availability. The palette adds no actions of its own.
 *
 * A feature outside the composer registers entries of this shape through the
 * composer's `commandPaletteEntries` prop (for example a later answer review
 * command) without changing the palette.
 */
export type ComposerPaletteEntry = Readonly<{
  /** Unique within the palette, stable across renders. */
  id: string;
  section: ComposerPaletteSectionId;
  label: string;
  /** The second line: what the action does, or the state it is in. */
  detail?: string | null;
  /** Further text the filter matches after the label (a Skill's description, a model's provider). */
  keywords?: readonly string[];
  icon?: UiV2IconName;
  /** Draws a check: the value is chosen (a selected Knowledge base). */
  checked?: boolean;
  /** The value already in force (a pinned Skill, the current model): checked at full strength, cannot run. */
  current?: boolean;
  /** Listed dimmed with this reason instead of `detail`; cannot run. */
  disabledReason?: string | null;
  /** Listed only once the user types a filter (long catalogs such as Knowledge bases). */
  queryOnly?: boolean;
  run(): void;
}>;

export type ComposerPaletteGroup = Readonly<{
  id: ComposerPaletteSectionId;
  label: string;
  entries: readonly ComposerPaletteEntry[];
}>;

/** An entry the user can run now (not disabled and not the value in force). */
export function paletteEntryRunnable(entry: ComposerPaletteEntry): boolean {
  return !entry.disabledReason && !entry.current;
}

/**
 * The palette's filter text while the whole draft is a command, otherwise
 * null: the draft starts with `/`, the character after it is not white space
 * (`/ ` is ordinary text), and it stays on one line.
 */
export function composerPaletteQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const query = draft.slice(1);
  if (/^\s/u.test(query) || /[\r\n]/u.test(query)) return null;
  return query;
}

/** Only `/` typed into an empty draft opens the palette; `/` inside text never does. */
export function opensComposerPalette(previousDraft: string, nextDraft: string): boolean {
  return previousDraft === "" && nextDraft === "/";
}

/*
 * Match rank, lower first: the label starts with the filter, a word of the
 * label starts with it, the label contains it, a keyword starts with it, a
 * keyword contains it. Null when nothing matches.
 */
function matchRank(entry: ComposerPaletteEntry, needle: string): number | null {
  if (!needle) return entry.queryOnly ? null : 0;
  const label = entry.label.toLocaleLowerCase();
  if (label.startsWith(needle)) return 0;
  if (label.split(/[\s·:/()-]+/u).some((word) => word.startsWith(needle))) return 1;
  if (label.includes(needle)) return 2;
  const keywords = (entry.keywords ?? []).map((keyword) => keyword.toLocaleLowerCase());
  if (keywords.some((keyword) => keyword.startsWith(needle))) return 3;
  if (keywords.some((keyword) => keyword.includes(needle))) return 4;
  return null;
}

/**
 * Case-insensitive filtering, prefix matches before substring matches within
 * each section; ties keep the builder's order. Sections keep their fixed
 * order and empty ones are dropped.
 */
export function filterComposerPaletteEntries(
  entries: readonly ComposerPaletteEntry[],
  query: string
): ComposerPaletteGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const ranked = entries.flatMap((entry, order) => {
    const rank = matchRank(entry, needle);
    return rank === null ? [] : [{ entry, order, rank }];
  });
  return COMPOSER_PALETTE_SECTIONS.flatMap((section) => {
    const matches = ranked
      .filter(({ entry }) => entry.section === section.id)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map(({ entry }) => entry);
    return matches.length > 0 ? [{ id: section.id, label: section.label, entries: matches }] : [];
  });
}
