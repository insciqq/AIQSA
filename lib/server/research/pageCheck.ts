import { defaultTreeAdapter, type DefaultTreeAdapterMap } from "parse5";
import type { ArtifactSource } from "../../contracts/artifacts";
import type { ResearchEvidenceRecord } from "../../contracts/research";
import { parseArtifactHtml } from "../artifacts/htmlParse";
import type { ArtifactService } from "../artifacts/service";
import { extractFetchUrls, normalizeFetchUrl } from "../webFetch/urls";
import type { ResearchPagePort, ResearchPortFactories, ResearchPageVerdict } from "./ports";
import { claimFigures, figuresNotIn, normalizeQuotedText, type ClaimFigure } from "./quoteCheck";

const BLOCKS = new Set(["address", "article", "aside", "blockquote", "br", "caption", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "text", "th", "tr", "ul"]);
const OMIT_TEXT = new Set(["head", "style", "template", "title"]);
const LISTED = 8;
const QUOTED_CHARACTERS = 240;

/** `claimFigures` bounds one claim. A page can have many: keep reading after its last figure, including in one long paragraph. */
function* pageFigures(text: string): Generator<ClaimFigure> {
  let rest = normalizeQuotedText(text);
  while (rest) {
    const figures = claimFigures(rest);
    if (figures.length === 0) return;
    let end = 0;
    for (const figure of figures) {
      end = rest.indexOf(figure.text, end) + figure.text.length;
      yield figure;
    }
    rest = rest.slice(end);
  }
}

/**
 * JSON strings hold figures as written. A numeric value may instead carry an explicit `unit`, `units` or `currency` on its object or an enclosing
 * series (including a values array). Bare numbers stay bare; field names such as `price` never invent a currency. No chart code is evaluated.
 */
function jsonText(text: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("research_page_data_unreadable"); }
  const texts: string[] = [];
  const pending: { value: unknown; unit: string | null }[] = [{ unit: null, value: parsed }];
  while (pending.length) {
    const { value, unit } = pending.pop()!;
    if (typeof value === "string") {
      texts.push(unit && /^\d+(?:[.,\s'’]\d+)*$/u.test(value.trim()) ? `${value} ${unit}` : value);
    } else if (typeof value === "number" && unit) {
      texts.push(`${value} ${unit}`);
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push({ unit, value: item });
    } else if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      const explicit = [object.unit, object.units, object.currency].find((entry) => typeof entry === "string");
      const inherited = typeof explicit === "string" ? explicit : unit;
      for (const [key, item] of Object.entries(object)) {
        texts.push(key);
        pending.push({ unit: inherited, value: item });
      }
    }
  }
  return texts;
}

/** Links the artifact viewer permits to leave the page; local paths and fragments have no external destination. */
function externalLink(href: string): string | null {
  const value = href.trim();
  if (/^mailto:/iu.test(value)) {
    try { return new URL(value).href; } catch { throw new Error("research_page_link_unreadable"); }
  }
  if (!/^(?:https?:|\/\/)/iu.test(value)) return null;
  const normalized = normalizeFetchUrl(value.startsWith("//") ? `https:${value}` : value);
  if (!normalized) throw new Error("research_page_link_unreadable");
  return normalized;
}

function linksIn(text: string): readonly string[] {
  return [...extractFetchUrls(text), ...(text.match(/mailto:[^\s<>"'`)\]]+/giu) ?? []).flatMap((link) => externalLink(link) ?? [])];
}

/** Static text, with cell/block boundaries kept apart and inline text joined; scripts, styles, attributes and comments contribute no figures. */
function readPage(html: string): Readonly<{ texts: readonly string[]; links: ReadonlySet<string> }> {
  const texts: string[] = [];
  const links = new Set<string>();
  let pieces: string[] = [];
  const flush = () => { if (pieces.length) texts.push(pieces.join("")); pieces = []; };
  type Node = DefaultTreeAdapterMap["node"];
  const pending: { node: Node | null; visible: boolean }[] = [{ node: parseArtifactHtml(html), visible: true }];
  while (pending.length) {
    const { node, visible } = pending.pop()!;
    if (!node) { flush(); continue; }
    if (defaultTreeAdapter.isTextNode(node)) { if (visible) pieces.push(node.value); continue; }
    let shown = visible;
    if (defaultTreeAdapter.isElementNode(node)) {
      const attr = (name: string) => node.attrs.find((attribute) => attribute.name === name)?.value;
      if (node.tagName === "a") {
        const link = externalLink(attr("href") ?? "");
        if (link) links.add(link);
      }
      if (node.tagName === "script") {
        if (attr("type")?.trim().toLowerCase() === "application/json") {
          texts.push(...jsonText(node.childNodes.filter(defaultTreeAdapter.isTextNode).map((child) => child.value).join("")));
        }
        continue;
      }
      shown = visible && !OMIT_TEXT.has(node.tagName) && attr("hidden") === undefined;
      if (BLOCKS.has(node.tagName)) { flush(); pending.push({ node: null, visible: shown }); }
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push({ node: node.childNodes[index]!, visible: shown });
    }
  }
  flush();
  return { links, texts };
}

/** Only evidence content, never ids, timestamps or the rest of a stored page that the report did not cite. */
function recordTexts(record: ResearchEvidenceRecord): readonly string[] {
  switch (record.kind) {
    case "finding": return [record.claim, record.quote, record.url];
    case "dataset": return [record.claim, record.url, record.dataset.method, record.dataset.leftOut, String(record.dataset.sampleSize),
      ...record.dataset.counts.map(({ count, label }) => `${count} ${label}`), ...record.dataset.examples.flatMap(({ quote, url }) => [quote, url])];
    case "not_found": return [record.reason];
    case "unreachable": return [record.reason, record.target];
  }
}

/** Bounded data-only feedback: no page prose, model instructions or excerpts of the private report. */
function mismatch(figures: readonly string[], links: readonly string[]): ResearchPageVerdict {
  const quote = (value: string) => JSON.stringify(value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, QUOTED_CHARACTERS));
  const list = (values: readonly string[]) => [...new Set(values)].slice(0, LISTED).map(quote).join(", ");
  const parts = [figures.length ? `Figures absent from the report, its caveats and cited records: ${list(figures)}.` : "",
    links.length ? `Links absent from the report, its caveats and cited records: ${list(links)}.` : ""].filter(Boolean);
  return parts.length ? { kind: "mismatch", message: parts.join(" ") } : { kind: "pass" };
}

/** Owner-authorized, immutable source reads. An incomplete read throws, so `writeResearchPage` keeps the answer and omits the page. */
export function createResearchPageCheck(artifacts: Readonly<{
  source(input: Parameters<ArtifactService["source"]>[0]): Promise<ArtifactSource | null>;
}>): NonNullable<ResearchPortFactories["page"]> {
  return (run, { evidence }): ResearchPagePort => ({
    async check({ page, report, caveats, recordIds = [], signal }) {
      signal.throwIfAborted();
      const source = await artifacts.source({ artifactId: page.artifactId, ownerUserId: run.userId, versionId: page.versionId });
      signal.throwIfAborted();
      const entry = source?.files.find((file) => file.path === page.entrypoint);
      if (source?.versionId !== page.versionId || !entry || entry.mimeType !== "text/html" || entry.text === undefined || entry.truncated) {
        throw new Error("research_page_source_unreadable");
      }
      const cited = new Set(recordIds);
      const records = cited.size ? await evidence.records(signal) : [];
      signal.throwIfAborted();
      const allowed = [report, ...caveats, ...records.filter((record) => cited.has(record.id) || record.supersedes !== null && cited.has(record.supersedes)).flatMap(recordTexts)];
      const links = new Set(allowed.flatMap(linksIn));
      const read = readPage(entry.text);
      const figures = new Map(read.texts.flatMap((text) => [...pageFigures(text)]).map((figure) => [figure.text, figure]));
      return mismatch(figuresNotIn([...figures.values()], allowed.join("\n\n")).map(({ text }) => text), [...read.links].filter((link) => !links.has(link)));
    }
  });
}
