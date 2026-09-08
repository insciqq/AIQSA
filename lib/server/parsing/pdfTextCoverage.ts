import type { ParsedDocumentBlock } from "./types";

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
function operands(text: string): readonly string[] {
  const comparable = text.normalize("NFKC")
    .replace(/\\+([A-Za-z]+)/gu, (_match, command: string) =>
      FORMAT_COMMANDS.has(command) ? " " : ` ${command} `)
    .toLocaleLowerCase("und")
    .replace(/[α-ωϑϕϖϱϵ]/gu, character => ` ${GREEK_NAMES[character] ?? character} `)
    .replace(/(?<=\d)\s*\.\s*(?=\d)/gu, ".");
  return comparable.match(/[\p{L}\p{M}]+|\p{N}+(?:\.\p{N}+)?/gu) ?? [];
}

function anchored(tokens: readonly string[]): boolean {
  const words = tokens.filter(token => /\p{L}/u.test(token));
  return words.join("").length >= 6 || tokens.length >= 5 && new Set(words).size >= 2;
}

type PageCoverage = {
  prose: (readonly string[])[];
  sequences: (readonly string[])[];
  remainingSteps: number;
};

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

function tableRows(block: ParsedDocumentBlock): readonly string[] {
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
  return [...rows.values()].map(row => row.sort((a, b) => a.column - b.column).map(cell => cell.text).join("\t"));
}

export function createNativeTextCoverage(
  blocks: readonly ParsedDocumentBlock[]
): (candidate: ParsedDocumentBlock) => boolean {
  const byPage = new Map<number, PageCoverage>();
  for (const block of blocks) {
    const prose = block.isTable || block.table || block.type === "table" ? [] : [operands(block.text)];
    const sequences = [...prose, ...tableRows(block).map(operands)]
      .filter(tokens => tokens.length > 0 && tokens.length <= MAX_SEQUENCE_TOKENS);
    for (let page = block.page; page <= block.pageEnd; page += 1) {
      const current: PageCoverage = byPage.get(page) ?? {
        prose: [], sequences: [], remainingSteps: MAX_COMPARISON_STEPS_PER_PAGE
      };
      current.prose.push(...prose.filter(tokens => tokens.length <= MAX_SEQUENCE_TOKENS));
      current.sequences.push(...sequences);
      byPage.set(page, current);
    }
  }
  return candidate => {
    const page = byPage.get(candidate.page);
    if (!page || candidate.pageEnd !== candidate.page) return false;
    const tokens = operands(candidate.text);
    if (anchored(tokens) && represented(tokens, page.sequences, page)) return true;
    const table = candidate.table;
    if (!table || table.rowCount !== 1 || table.cells.length !== table.columnCount ||
      table.cells.some(cell => cell.row !== 0 || cell.rowSpan !== 1 || cell.columnSpan !== 1)) return false;
    const cells = table.cells.map(cell => operands(cell.text));
    // Native baseline groups can join independent prose columns. Require full
    // coverage of every cell; model table labels elsewhere prove no such match.
    return cells.some(anchored) && cells.every(cell => represented(cell, page.prose, page));
  };
}
