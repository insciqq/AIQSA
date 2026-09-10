export type JsonToken = Readonly<{
  kind: "key" | "string" | "number" | "literal" | "punctuation" | "space" | "invalid";
  offset: number;
  text: string;
}>;

/** Lexemes stay intact: formatting never round-trips numbers, keys or escapes through JS values. */
export function jsonTokens(text: string): JsonToken[] {
  const pattern = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]|[ \t\r\n]+|[\s\S]/gu;
  return [...text.matchAll(pattern)].map((match) => {
    const value = match[0];
    const offset = match.index;
    const kind: JsonToken["kind"] = /^[ \t\r\n]+$/u.test(value) ? "space"
      : value.startsWith('"') && value.length > 1 ? /^\s*:/u.test(text.slice(offset + value.length)) ? "key" : "string"
        : /^-?\d/u.test(value) ? "number"
          : /^(?:true|false|null)$/u.test(value) ? "literal"
            : /^[{}\[\],:]$/u.test(value) ? "punctuation" : "invalid";
    return { kind, offset, text: value };
  });
}

export type JsonValidation = Readonly<{ ok: true }> | Readonly<{
  column: number;
  line: number;
  message: string;
  offset: number;
  ok: false;
}>;

/** An iterative syntax walk gives the same location in every browser, without echoing draft values in errors. */
export function validateJsonParameters(text: string, label = "Default parameters"): JsonValidation {
  const fail = (offset: number, message: string): JsonValidation => {
    const before = text.slice(0, offset).split(/\r\n|\r|\n/u);
    return { column: before.at(-1)!.length + 1, line: before.length, message, offset, ok: false };
  };
  type Frame = { kind: "array" | "object"; state: "start" | "value" | "key" | "colon" | "comma" };
  const stack: Frame[] = [];
  const tokens = jsonTokens(text).filter((token) => token.kind !== "space");
  if (tokens[0]?.text !== "{") return fail(tokens[0]?.offset ?? 0, `${label} must be one JSON object.`);
  let rootStarted = false;
  for (const token of tokens) {
    const frame = stack.at(-1);
    if (rootStarted && !frame) return fail(token.offset, "Unexpected content after the JSON object.");
    if (frame) {
      const closing = frame.kind === "object" ? "}" : "]";
      if (token.text === closing && (frame.state === "start" || frame.state === "comma")) {
        stack.pop();
        continue;
      }
      if (frame.state === "comma") {
        if (token.text !== ",") return fail(token.offset, `Expected a comma or ${closing}.`);
        frame.state = frame.kind === "object" ? "key" : "value";
        continue;
      }
      if (frame.kind === "object" && (frame.state === "start" || frame.state === "key")) {
        if (token.kind !== "key" && token.kind !== "string") return fail(token.offset, "Expected a quoted property name.");
        frame.state = "colon";
        continue;
      }
      if (frame.state === "colon") {
        if (token.text !== ":") return fail(token.offset, "Expected a colon after the property name.");
        frame.state = "value";
        continue;
      }
      frame.state = "comma";
    }
    rootStarted = true;
    if (token.text === "{" || token.text === "[") {
      stack.push({ kind: token.text === "{" ? "object" : "array", state: "start" });
    } else if (!["key", "string", "number", "literal"].includes(token.kind)) {
      return fail(token.offset, "Expected a JSON value.");
    }
  }
  return stack.length ? fail(text.length, "The JSON object is unfinished.") : { ok: true };
}

/** Call only after validation. Whitespace-only edits also preserve duplicate property names. */
export function formatJsonParameters(text: string): string {
  const tokens = jsonTokens(text).filter((token) => token.kind !== "space");
  let depth = 0;
  let result = "";
  const newline = () => `\n${"  ".repeat(depth)}`;
  tokens.forEach((token, index) => {
    if (token.text === "{" || token.text === "[") {
      result += token.text;
      depth += 1;
      if (tokens[index + 1]?.text !== (token.text === "{" ? "}" : "]")) result += newline();
    } else if (token.text === "}" || token.text === "]") {
      depth -= 1;
      if (tokens[index - 1]?.text !== (token.text === "}" ? "{" : "[")) result += newline();
      result += token.text;
    } else if (token.text === ",") result += `,${newline()}`;
    else if (token.text === ":") result += ": ";
    else result += token.text;
  });
  return result;
}

export function indentJsonSelection(text: string, start: number, end: number, outdent: boolean) {
  if (!outdent && start === end) return { end: start, replacement: "  ", selectionEnd: start + 2, selectionStart: start + 2, start };
  const lineStart = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the next line's start does not include that line.
  const selectedEnd = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nextNewline = text.indexOf("\n", selectedEnd);
  const lineEnd = nextNewline < 0 ? text.length : nextNewline;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  let removed = 0;
  let firstRemoved = 0;
  const replacement = lines.map((line, index) => {
    if (!outdent) return `  ${line}`;
    const count = /^(?: {1,2}|\t)/u.exec(line)?.[0].length ?? 0;
    removed += count;
    if (index === 0) firstRemoved = count;
    return line.slice(count);
  }).join("\n");
  return {
    end: lineEnd,
    replacement,
    selectionEnd: outdent ? Math.max(lineStart, end - removed) : end + 2 * lines.length,
    selectionStart: outdent ? Math.max(lineStart, start - firstRemoved) : start + 2,
    start: lineStart
  };
}
