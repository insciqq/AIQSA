import postcss, { type AtRule, type Root } from "postcss";
import valueParser, { type Node as ValueNode } from "postcss-value-parser";
import { ArtifactToolError } from "./errors";
import { ARTIFACT_RESOURCE_LIMITS } from "./resourcePolicy";

export type ArtifactCssReference = {
  value: string;
  kind: "import" | "url";
  atRule?: AtRule;
  condition?: string;
  replace: (value: string) => void;
};
const invalid = (path: string): never => { throw new ArtifactToolError("artifact_external_style_unsupported", { path,
  hint: "Use valid static CSS with direct url() references and self-contained styles; browser compilation and computed resource URLs are unsupported." }); };

function unescapeCss(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|([\s\S]))/giu, (_match, hex: string | undefined, other: string | undefined) => {
    if (hex) { const code = Number.parseInt(hex, 16); return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd"; }
    return other === "\n" || other === "\r" || other === "\f" ? "" : other ?? "";
  });
}

function singleUrl(node: ValueNode, path: string): string {
  if (node.type === "string" && !node.unclosed) return unescapeCss(node.value);
  if (node.type !== "function" || unescapeCss(node.value).toLowerCase() !== "url" || node.unclosed) return invalid(path);
  const parts = node.nodes.filter(part => part.type !== "space" && part.type !== "comment");
  if (parts.length !== 1 || !["word", "string"].includes(parts[0]!.type) || "unclosed" in parts[0]! && parts[0]!.unclosed) return invalid(path);
  return unescapeCss(parts[0]!.value);
}
const quoteCss = (value: string) => value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/[\r\n\f]/gu, "");

/**
 * Bounds of one stylesheet text (a file, a `<style>` element or a style attribute) before
 * postcss builds its tree. The cost follows the nodes, about 1 KB each, not the bytes: 15 MiB
 * of tiny rules took 12 s and 3.7 GB. Statements count `{`, `}`, `;` and comment starts;
 * value tokens bound the nodes of the values parsed for url(). The minified full Tailwind 2
 * build (2.9 MB) has 98k statements and 172k value tokens, Bootstrap 5 11k and 8k; the
 * costliest shapes measured at these bounds take under 0.5 s and fit a 200 MB heap.
 */
export const ARTIFACT_CSS_LIMITS = Object.freeze({ maxBytes: ARTIFACT_RESOURCE_LIMITS.styleBytes, maxStatements: 150_000, maxValueTokens: 300_000 });
const tooLarge = (path: string): never => { throw new ArtifactToolError("artifact_stylesheet_too_large", { path,
  hint: `Split the stylesheet into several linked files, or minify it and leave out unused rules (a purged production build). Each stylesheet, <style> element or style attribute may have at most ${ARTIFACT_CSS_LIMITS.maxBytes / 1024 / 1024} MiB and ${ARTIFACT_CSS_LIMITS.maxStatements} braces, semicolons and comments.` }); };

/** Characters that open or close a postcss node; ones inside strings and comments only overcount. */
function cssStatements(source: string): number {
  let count = 0;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code === 0x7b || code === 0x7d || code === 0x3b || code === 0x2f && source.charCodeAt(index + 1) === 0x2a) count++;
  }
  return count;
}

/** One more than the characters that can end a postcss-value-parser node: a bound on its nodes. */
function valueTokens(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    // Whitespace and " ' ( ) , / :
    if (code === 0x20 || code >= 0x09 && code <= 0x0d || code === 0x22 || code === 0x27 || code === 0x28 || code === 0x29 ||
      code === 0x2c || code === 0x2f || code === 0x3a) count++;
  }
  return count;
}

/** Rules and values are parsed independently. Escaped selectors stay untouched. */
export function parseArtifactCss(source: string, path: string): { root: Root; references: ArtifactCssReference[]; text: () => string } {
  if (Buffer.byteLength(source) > ARTIFACT_CSS_LIMITS.maxBytes || cssStatements(source) > ARTIFACT_CSS_LIMITS.maxStatements) tooLarge(path);
  let root: Root;
  try { root = postcss.parse(source, { from: undefined }); } catch { return invalid(path); }
  const references: ArtifactCssReference[] = [];
  const pending: Array<() => void> = [];
  let tokens = 0;
  const parseValue = (value: string) => {
    tokens += valueTokens(value);
    if (tokens > ARTIFACT_CSS_LIMITS.maxValueTokens) tooLarge(path);
    return valueParser(value);
  };
  root.walkAtRules(rule => {
    const name = unescapeCss(rule.name).toLowerCase();
    if (name !== "import") return;
    const parsed = parseValue(rule.params);
    const first = parsed.nodes.find(node => node.type !== "space" && node.type !== "comment");
    if (!first) return invalid(path);
    references.push({ kind: "import", value: singleUrl(first, path), atRule: rule,
      condition: rule.params.slice(first.sourceEndIndex).trim(),
      replace(value) {
        const replacement = valueParser(`url("${quoteCss(value)}")`).nodes[0]!;
        parsed.nodes.splice(parsed.nodes.indexOf(first), 1, replacement);
      } });
    pending.push(() => { rule.params = valueParser.stringify(parsed.nodes); });
  });
  root.walkDecls(declaration => {
    // Only a function holds a reference; without one, only a comment can stringify differently.
    if (!declaration.value.includes("(") && !declaration.value.includes("/*")) return;
    const parsed = parseValue(declaration.value);
    const before = references.length;
    parsed.walk(node => {
      if (node.type !== "function") return;
      const name = unescapeCss(node.value).toLowerCase();
      if (name === "url") {
        const value = singleUrl(node, path);
        references.push({ kind: "url", value, replace(value) {
          node.value = "url";
          node.nodes = valueParser(`"${quoteCss(value)}"`).nodes;
        } });
        return false;
      }
      // Quoted image-set entries are fetch positions too; do not silently
      // accept external strings merely because they lack a url() wrapper.
      if (name === "image-set" || name === "-webkit-image-set") {
        for (const child of node.nodes) if (child.type === "string") {
          references.push({ kind: "url", value: unescapeCss(child.value), replace(value) { child.value = quoteCss(value); child.quote = '"'; } });
        }
      }
    });
    // Only a value with references keeps its tree until their replacements are written.
    if (references.length > before) pending.push(() => { declaration.value = valueParser.stringify(parsed.nodes); });
    else {
      const value = valueParser.stringify(parsed.nodes);
      if (value !== declaration.value) pending.push(() => { declaration.value = value; });
    }
  });
  return { root, references, text: () => { pending.forEach(write => write()); return root.toString(); } };
}

export function expandArtifactCssImport(reference: ArtifactCssReference, imported: string, path: string): void {
  if (!reference.atRule) return invalid(path);
  let condition = reference.condition ?? "";
  const wrappers: Array<{ name: string; params: string }> = [];
  const parsed = valueParser(condition).nodes.filter(node => node.type !== "comment" && node.type !== "space");
  let consumed = 0;
  for (const node of parsed) {
    const name = unescapeCss(node.value).toLowerCase();
    if (name === "layer" && (node.type === "function" || node.type === "word") && wrappers.length === 0) {
      wrappers.push({ name: "layer", params: node.type === "function" ? valueParser.stringify(node.nodes) : "" });
    } else if (name === "supports" && node.type === "function" && wrappers.every(item => item.name !== "supports")) {
      const supports = valueParser.stringify(node.nodes);
      wrappers.push({ name: "supports", params: /^\s*\(/u.test(supports) ? supports : `(${supports})` });
    } else break;
    consumed = node.sourceEndIndex;
  }
  condition = condition.slice(consumed).trim();
  if (condition) wrappers.push({ name: "media", params: condition });
  let text = imported;
  for (const wrapper of wrappers.reverse()) text = `@${wrapper.name}${wrapper.params ? ` ${wrapper.params}` : ""}{${text}}`;
  try { reference.atRule.replaceWith(postcss.parse(text, { from: undefined }).nodes); } catch { invalid(path); }
}
