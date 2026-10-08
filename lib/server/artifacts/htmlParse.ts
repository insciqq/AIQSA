import { defaultTreeAdapter, Parser, type DefaultTreeAdapterMap, type Token, type TreeAdapter } from "parse5";
import { ArtifactToolError } from "./errors";

type Document = DefaultTreeAdapterMap["document"];
type TextNode = DefaultTreeAdapterMap["textNode"];

/** Pieces joined per batch, so a long text never lives as one string per character. */
const PIECES_PER_BATCH = 1024;

/**
 * Collects the pieces of one text in order and joins them in bounded batches.
 * Appending a character at a time with `+=` builds a rope of about 32 bytes per
 * character, which a 20 MB inline script turns into most of a gigabyte.
 */
class TextPieces {
  private readonly batches: string[] = [];
  private pieces: string[];

  constructor(first: string) { this.pieces = [first]; }

  push(piece: string): void {
    this.pieces.push(piece);
    if (this.pieces.length === PIECES_PER_BATCH) { this.batches.push(this.pieces.join("")); this.pieces = []; }
  }

  text(): string {
    if (this.pieces.length) { this.batches.push(this.pieces.join("")); this.pieces = []; }
    return this.batches.length === 1 ? this.batches[0]! : this.batches.join("");
  }
}

/** The parse5 7.3 tokenizer members that accumulate a run of characters into one token. */
type CharacterTokenizer = {
  currentCharacterToken: Token.CharacterToken | null;
  _appendCharToCurrentCharacterToken(type: Token.TokenType, ch: string): void;
  _emitCurrentCharacterToken(nextLocation: Token.Location | null): void;
};

/**
 * Same tokens, with each token's characters collected in pieces and joined
 * once before the token reaches the tree builder; nothing reads them earlier.
 */
function collectCharacterRuns(tokenizer: CharacterTokenizer): void {
  const append = tokenizer._appendCharToCurrentCharacterToken.bind(tokenizer);
  const emit = tokenizer._emitCurrentCharacterToken.bind(tokenizer);
  let open: { token: Token.CharacterToken; pieces: TextPieces } | null = null;
  tokenizer._appendCharToCurrentCharacterToken = (type, ch) => {
    const token = tokenizer.currentCharacterToken;
    if (token?.type !== type) { append(type, ch); return; }
    if (open?.token !== token) open = { token, pieces: new TextPieces(token.chars) };
    open.pieces.push(ch);
  };
  tokenizer._emitCurrentCharacterToken = (nextLocation) => {
    const token = tokenizer.currentCharacterToken;
    if (token && open?.token === token) token.chars = open.pieces.text();
    open = null;
    emit(nextLocation);
  };
}

/** The default tree adapter, with adjacent text of one node joined after parsing instead of with `+=`. */
function textCollectingAdapter(): Readonly<{ adapter: TreeAdapter<DefaultTreeAdapterMap>; finish(): void }> {
  const pending = new Map<TextNode, TextPieces>();
  const append = (node: TextNode, text: string): void => {
    let pieces = pending.get(node);
    if (!pieces) pending.set(node, pieces = new TextPieces(node.value));
    pieces.push(text);
  };
  const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    insertText(parentNode, text) {
      const previous = parentNode.childNodes.at(-1);
      if (previous && defaultTreeAdapter.isTextNode(previous)) append(previous, text);
      else defaultTreeAdapter.insertText(parentNode, text);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      const previous = parentNode.childNodes[parentNode.childNodes.indexOf(referenceNode) - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) append(previous, text);
      else defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode);
    }
  };
  return { adapter, finish() { for (const [node, pieces] of pending) node.value = pieces.text(); } };
}

/**
 * Start tags one markup text may hold before parse5 builds its tree. A referenced
 * page can be 24 MiB, and parse5 keeps about 1.6 KB per element with source
 * locations: a million empty elements took 1.6 GB. Real pages, including a
 * spreadsheet exported as a 10,000-row HTML table, stay below this.
 */
export const ARTIFACT_HTML_MAX_START_TAGS = 250_000;

/** `<` followed by an ASCII letter: an upper bound of the start tags in the text. */
function startTagBound(html: string): number {
  let count = 0;
  for (let index = html.indexOf("<"); index !== -1; index = html.indexOf("<", index + 1)) {
    const next = html.charCodeAt(index + 1) | 0x20;
    if (next >= 0x61 && next <= 0x7a) count++;
  }
  return count;
}

/**
 * `parse5.parse` with the default tree adapter's result, in memory proportional
 * to the text instead of to its character count: a page with a 20 MB inline
 * script otherwise needs most of a gigabyte while it parses.
 */
export function parseArtifactHtml(html: string, options: Readonly<{ sourceCodeLocationInfo?: boolean; path?: string }> = {}): Document {
  if (startTagBound(html) > ARTIFACT_HTML_MAX_START_TAGS) {
    throw new ArtifactToolError("artifact_page_too_complex", { ...(options.path ? { path: options.path } : {}),
      hint: `This markup has more than ${ARTIFACT_HTML_MAX_START_TAGS.toLocaleString("en-US")} tags; split it into several pages, or convert a large table to a PDF or a smaller page in the Workspace.` });
  }
  const text = textCollectingAdapter();
  const parser = new Parser<DefaultTreeAdapterMap>({ sourceCodeLocationInfo: options.sourceCodeLocationInfo ?? false, treeAdapter: text.adapter });
  collectCharacterRuns(parser.tokenizer as unknown as CharacterTokenizer);
  parser.tokenizer.write(html, true);
  text.finish();
  return parser.document;
}
