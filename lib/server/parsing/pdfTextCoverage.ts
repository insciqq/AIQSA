import type { ParsedDocumentBlock } from "./types";

/** Native glyphs cannot establish fraction bars, scripts or mathematical
 * layout. Only readable prose may supply omitted text or be line-wrapped. */
export function nativeTextIsProse(text: string): boolean {
  if (/[\\{}^=<>|∂∫∑∏√≤≥≠≈±×÷⊕⊖⊗⊙∥↦↔→←⎧⎨⎩\uE000-\uF8FF]/u.test(text)) return false;
  const words = text.normalize("NFKC").match(/[\p{L}\p{M}]+/gu) ?? [];
  const wordLengths = words.map(word => [...word].length).filter(length => length >= 2);
  return words.some(word => [...word].length >= 4) ||
    wordLengths.length >= 2 && wordLengths.reduce((total, length) => total + length, 0) >= 6;
}

const MAX_SEQUENCE_TOKENS = 8_192;
const MAX_NATIVE_TOKENS = 256;
const MAX_COMPARISON_STEPS_PER_PAGE = 100_000;
const MAX_EXPANDED_TABLE_CELLS = 16_384;
const FORMAT_COMMANDS = new Set([
  "bar", "overline", "underline", "hat", "widehat", "tilde", "widetilde", "vec", "dot", "ddot",
  "mathbf", "mathbb", "mathcal", "mathfrak", "mathrm", "mathsf", "mathtt", "mathit", "boldsymbol",
  "text", "textrm", "textit", "textbf", "operatorname", "left", "right", "big", "Big", "bigg", "Bigg",
  "frac", "dfrac", "tfrac", "sqrt", "quad", "qquad", "displaystyle", "textstyle"
]);
const GREEK_NAMES: Readonly<Record<string, string>> = Object.freeze({
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta",
  θ: "theta", ϑ: "theta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi",
  ο: "omicron", π: "pi", ϖ: "pi", ρ: "rho", ϱ: "rho", σ: "sigma", ς: "sigma", τ: "tau",
  υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega"
});

/** Comparison only: native PDF extraction loses operators, accents and layout.
 * Operand coverage can reject a duplicate, never correct or rewrite Vision. */
function operands(text: string, layoutAware = false): readonly string[] {
  // NFKC otherwise fuses a superscript with its base before tokenization.
  // This is comparison-only; the original exponent and all output stay intact.
  const source = layoutAware ? text.replace(/([¹²³\u2070-\u209f]+)/gu, " $1 ") : text;
  const comparable = source.normalize("NFKC")
    .replace(/\\+([A-Za-z]+)/gu, (_match, command: string) =>
      FORMAT_COMMANDS.has(command) ? " " : ` ${command} `)
    .toLocaleLowerCase("und")
    .replace(/[α-ωϑϕϖϱϵ]/gu, character => ` ${GREEK_NAMES[character] ?? character} `)
    .replace(/(?<=\d)\s*\.\s*(?=\d)/gu, ".");
  if (!layoutAware) return comparable.match(/[\p{L}\p{M}]+|\p{N}+(?:\.\p{N}+)?/gu) ?? [];
  return (comparable.match(/[\p{L}\p{M}]+|[+−-]?\s*\p{N}+(?:\.\p{N}+)?/gu) ?? [])
    .map(token => token.replace(/\s+/gu, "").replace("−", "-"));
}

function anchored(tokens: readonly string[]): boolean {
  const words = tokens.filter(token => /\p{L}/u.test(token));
  return words.join("").length >= 6 || tokens.length >= 5 && new Set(words).size >= 2;
}

type PageCoverage = {
  prose: (readonly string[])[];
  sequences: (readonly string[])[];
  remainingSteps: number;
  headings: Set<string>;
  rows: (readonly (readonly string[])[])[];
};

function smallCapsKey(text: string): string | null {
  if (text.length > 300 || !/^[\p{Lu}\p{N}\s.,:;()&/'’–—-]+$/u.test(text) ||
    (text.match(/\p{Lu}/gu)?.length ?? 0) < 6) return null;
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

function represented(
  native: readonly string[],
  sequences: readonly (readonly string[])[],
  budget: PageCoverage
): boolean {
  if (native.length === 0 || native.length > MAX_NATIVE_TOKENS) return false;
  // Extra LaTeX commands or native-lost operands may occur only within a tight
  // local span. Never infer coverage from an unordered page-wide word bag.
  const maxSkipped = Math.min(8, Math.floor(native.length / 4));
  for (const model of sequences) {
    for (let start = 0; start < model.length; start += 1) {
      if (--budget.remainingSteps < 0) return false;
      if (model[start] !== native[0]) continue;
      let matched = 1;
      const end = Math.min(model.length, start + native.length + maxSkipped);
      for (let index = start + 1; index < end && matched < native.length; index += 1) {
        if (--budget.remainingSteps < 0) return false;
        if (model[index] === native[matched]) matched += 1;
      }
      if (matched === native.length) return true;
    }
  }
  return false;
}

function tableCellRows(block: ParsedDocumentBlock): readonly (readonly string[])[] {
  const table = block.table;
  if (!table || table.cells.some(cell => !Number.isSafeInteger(cell.rowSpan) || cell.rowSpan < 1 ||
    cell.row + cell.rowSpan > table.rowCount || cell.columnSpan !== 1) ||
    table.cells.reduce((total, cell) => total + cell.rowSpan, 0) > MAX_EXPANDED_TABLE_CELLS) return [];
  const rows = new Map<number, typeof table.cells[number][]>();
  for (const cell of table.cells) {
    // Expand only spans already present in the model-authored structure.
    // Repeated labels or empty native cells cannot create a span.
    for (let index = cell.row; index < cell.row + cell.rowSpan; index += 1) {
      const row = rows.get(index) ?? [];
      row.push(cell);
      rows.set(index, row);
    }
  }
  return [...rows.values()].map(row => row.sort((a, b) => a.column - b.column).map(cell => cell.text));
}

/** A native line may contain the beginning of a wrapped description and its
 * adjacent complete cell. Only an actual single model row proves that relation;
 * neither another row's label nor an arbitrary gap in prose is sufficient. */
function representedPartialRow(native: readonly string[], page: PageCoverage): boolean {
  if (native.length < 5 || native.length > MAX_NATIVE_TOKENS) return false;
  for (const row of page.rows) {
    for (let column = 0; column + 1 < row.length; column += 1) {
      if (--page.remainingSteps < 0) return false;
      const cell = row[column]!;
      let prefix = 0;
      while (prefix < native.length && prefix < cell.length) {
        if (--page.remainingSteps < 0) return false;
        if (native[prefix] !== cell[prefix]) break;
        prefix += 1;
      }
      if (prefix < 4 || prefix === native.length || prefix === cell.length ||
        native.slice(0, prefix).filter(token => /\p{L}/u.test(token)).join("").length < 12) continue;
      let position = prefix;
      let mismatched = false;
      for (let adjacent = column + 1; adjacent < row.length && !mismatched; adjacent += 1) {
        for (const token of row[adjacent]!) {
          if (--page.remainingSteps < 0) return false;
          if (native[position] !== token) { mismatched = true; break; }
          position += 1;
        }
        if (!mismatched && position === native.length) return true;
      }
    }
  }
  return false;
}

export function createNativeTextCoverage(
  blocks: readonly ParsedDocumentBlock[],
  options: Readonly<{ layoutAware?: boolean }> = {}
): (candidate: ParsedDocumentBlock) => boolean {
  const byPage = new Map<number, PageCoverage>();
  let previous: { page: number; headingPath: string; tokens: readonly string[] } | null = null;
  for (const block of blocks) {
    const prose = block.isTable || block.table || block.type === "table" ? [] : [operands(block.text, options.layoutAware)];
    const rows = tableCellRows(block);
    const sequences = [...prose, ...rows.map(row => operands(row.join("\t"), options.layoutAware))]
      .filter(tokens => tokens.length > 0 && tokens.length <= MAX_SEQUENCE_TOKENS);
    const headingPath = block.headingPath.join("\u0000");
    const adjacent = options.layoutAware && block.type === "paragraph" && block.page === block.pageEnd &&
      previous?.page === block.page && previous.headingPath === headingPath
      ? [...previous.tokens, ...(prose[0] ?? [])] : [];
    previous = options.layoutAware && block.type === "paragraph" && block.page === block.pageEnd &&
      prose[0] && prose[0].length <= MAX_SEQUENCE_TOKENS
      ? { page: block.page, headingPath, tokens: prose[0] } : null;
    for (let page = block.page; page <= block.pageEnd; page += 1) {
      const current: PageCoverage = byPage.get(page) ?? {
        prose: [], sequences: [], remainingSteps: MAX_COMPARISON_STEPS_PER_PAGE,
        headings: new Set(), rows: []
      };
      current.prose.push(...prose.filter(tokens => tokens.length <= MAX_SEQUENCE_TOKENS));
      current.sequences.push(...sequences);
      if (adjacent.length > 0 && adjacent.length <= MAX_SEQUENCE_TOKENS) current.sequences.push(adjacent);
      if (options.layoutAware) {
        const heading = prose.length ? smallCapsKey(block.text) : null;
        if (heading) current.headings.add(heading);
        current.rows.push(...rows.map(row => row.map(cell => operands(cell, true)))
          .filter(row => row.reduce((count, cell) => count + cell.length, 0) <= MAX_SEQUENCE_TOKENS));
      }
      byPage.set(page, current);
    }
  }
  return candidate => {
    const page = byPage.get(candidate.page);
    if (!page || candidate.pageEnd !== candidate.page) return false;
    const heading = options.layoutAware ? smallCapsKey(candidate.text) : null;
    if (heading && page.headings.has(heading)) return true;
    const tokens = operands(candidate.text, options.layoutAware);
    if (anchored(tokens) && represented(tokens, page.sequences, page)) return true;
    if (options.layoutAware && representedPartialRow(tokens, page)) return true;
    const table = candidate.table;
    if (!table || table.rowCount !== 1 || table.cells.length !== table.columnCount ||
      table.cells.some(cell => cell.row !== 0 || cell.rowSpan !== 1 || cell.columnSpan !== 1)) return false;
    const cells = table.cells.map(cell => operands(cell.text, options.layoutAware));
    // Native baseline groups can join independent prose columns. Require full
    // coverage of every cell; model table labels elsewhere prove no such match.
    return cells.some(anchored) && cells.every(cell => represented(cell, page.prose, page));
  };
}
