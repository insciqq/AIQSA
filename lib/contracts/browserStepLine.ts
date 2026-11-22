/**
 * The step line the Workspace browser helper prints for each action (`step_line` in
 * `ops/workspace-guest/python/aiqsa/browser/_format.py`), the one reading of it every consumer shares:
 *
 *     [browser #3] click: button "Add to cart" @ www.saucedemo.com/inventory.html
 *     [browser #3 · shop-amazon] open: through proxy KZ1 (KZ) @ shop.kz/
 *
 * The number, a sub-agent's name after it, the action, then an optional `: target` and an optional ` @ where`. The guest
 * cleans every part to one line (no CR, U+2028 or U+2029 in it) and prints `where` as host and path with no white space or
 * quote, so a ` @ ` followed by a quote stood inside a quoted name from the page, never before the where. Only an action
 * prints a step line at a line's start: the guest indents page text that would read as one, after a newline and after the
 * other breaks too. What a line shows is a hint read from a command's own output, never authority.
 */
export type BrowserStepLine = Readonly<{
  action: string;
  /** The sub-agent whose browser took the step. */
  agent?: string;
  /** The host of the where, with its port as printed (`Accounts.Example.com:443`). */
  host?: string;
  /** The line as printed, without what follows a line break or trailing white space. */
  line: string;
  number: number;
  /** Not read `withinJson`. */
  target?: string;
  /** Host and path as printed (`127.0.0.1:8080/a%20b`); not read `withinJson`. */
  where?: string;
}>;

export type BrowserStepReading = Readonly<{
  /**
   * Research's looser reading of text whose JSON strings it did not decode, or decoded only roughly
   * (`lib/server/research/quoteCheck.ts`, `lib/server/research/sources.ts`): a step line may also start right after a `"`
   * or an escaped newline (`\n`) and ends at one too (or at an escaped `\r`), and anything may follow its host, such as the
   * string's closing quote. Only the line's last ` @ ` before a host names one, and its target and where are not read. A
   * page that fakes a line this way earns at most a check that could not be made, which the research checks accept.
   */
  withinJson?: true;
}>;

const HEAD = String.raw`\[browser #(\d{1,5})(?: · ([^\]\n]{1,64}))?\] ([a-z_]{1,20})`;
const HOST = String.raw`[^\s/@"]+`;
const EXACT = new RegExp(String.raw`^${HEAD}(?:: (.*?))?(?: @ (${HOST})(\/[^\s"]*)?)?$`, "u");
const IN_JSON = new RegExp(String.raw`^${HEAD}(?![a-z_])(?:.* @ (${HOST}))?`, "u");
const PREFIX = "[browser #";
const LINE_BREAK = /[\n\r\u2028\u2029]/gu;
const JSON_LINE_BREAK = /[\n\r\u2028\u2029]|\\[nr]/gu;
/** Where a step line may start in text read `withinJson`. */
const JSON_LINE_START = /(?<=^|[\n"]|\\n)\[browser #/gu;

/** The text from `from` up to its first line break of any kind, without trailing white space. */
function lineAt(text: string, from: number, lineBreak: RegExp = LINE_BREAK): string {
  const breaks = new RegExp(lineBreak);
  breaks.lastIndex = from;
  const end = breaks.exec(text)?.index ?? text.length;
  return text.slice(from, end).trimEnd();
}

function exactStep(line: string): BrowserStepLine | null {
  const match = EXACT.exec(line);
  if (!match) return null;
  const [, number, agent, action, target, host, path] = match;
  return { action: action!, ...(agent ? { agent } : {}), ...(host ? { host, where: host + (path ?? "") } : {}), line,
    number: Number(number), ...(target ? { target } : {}) };
}

function jsonStep(line: string): BrowserStepLine | null {
  const match = IN_JSON.exec(line);
  if (!match) return null;
  const [, number, agent, action, host] = match;
  return { action: action!, ...(agent ? { agent } : {}), ...(host ? { host } : {}), line, number: Number(number) };
}

/** The step line `text` starts with, read up to its first line break; null when its first line is no step line. */
export function parseBrowserStepLine(text: string): BrowserStepLine | null {
  return text.startsWith(PREFIX) ? exactStep(lineAt(text, 0)) : null;
}

/** The step lines of a text, in order: each line that is one from its start, read up to its first line break. */
export function browserStepLines(text: string, reading: BrowserStepReading = {}): BrowserStepLine[] {
  if (!text.includes(PREFIX)) return [];
  if (!reading.withinJson) return text.split("\n").flatMap((line) => parseBrowserStepLine(line) ?? []);
  const steps: BrowserStepLine[] = [];
  let readUntil = 0;
  for (const start of text.matchAll(new RegExp(JSON_LINE_START))) {
    if (start.index < readUntil) continue;
    const line = lineAt(text, start.index, JSON_LINE_BREAK);
    const step = jsonStep(line);
    if (!step) continue;
    steps.push(step);
    readUntil = start.index + line.length;
  }
  return steps;
}
