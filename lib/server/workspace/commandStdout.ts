/**
 * What a Workspace command printed, read from its stored or model-facing result, where the browser helper's step lines
 * are (`lib/contracts/browserStepLine.ts`). Each reading decodes a result's JSON once and never unescapes further, so an
 * escaped quote or newline a page printed stays text and starts no line.
 */

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stringsOf = (value: unknown): string[] => typeof value === "string" ? [value]
  : Array.isArray(value) ? value.flatMap(stringsOf) : isRecord(value) ? Object.values(value).flatMap(stringsOf) : [];

/**
 * A Workspace command result's `stdout`: the guest MCP server's envelope `{ ok, data: { stdout, … } }`, or a failed
 * command's `{ ok: false, error: { details: { stdout } } }` (both read the same way by `lib/server/workspace/operationFailure.ts`),
 * or a bare `{ stdout }`; null for anything else. Reading only the bare form once left every unattended sign-in failure
 * without its host.
 */
export function commandResultStdout(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const holder of [value.data, isRecord(value.error) ? value.error.details : undefined, value]) {
    if (isRecord(holder) && typeof holder.stdout === "string") return holder.stdout;
  }
  return null;
}

/**
 * What a stored command call's result (`{ content: [...] }`) printed to stdout: each JSON part's `stdout`, each text
 * part's when it is JSON, or the text part itself when it is no JSON. Other strings of the envelope (stderr, the command)
 * are never read.
 */
export function storedCommandStdout(result: unknown): readonly string[] {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content as unknown[] : [];
  return content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "json") return commandResultStdout(part.value) ?? [];
    if (part.type !== "text" || typeof part.text !== "string") return [];
    try {
      return commandResultStdout(JSON.parse(part.text)) ?? [];
    } catch {
      return [part.text];
    }
  });
}

const STDOUT_KEY = /"stdout":\s*"/u;
/** Characters a JSON string holds as they are, and whole escapes: the part of a cut string that still decodes. */
const JSON_STRING_BODY = /^(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*/u;

/**
 * What a result's model-facing text printed, as texts whose lines read as printed: every string of its JSON, decoded
 * once. An excerpt of a long result (`toolOutputExcerpt`, `lib/server/engine/toolResults.ts`) no longer parses, so its
 * `stdout` is decoded as far as the head keeps it whole, up to the excerpt's note; its tail starts anywhere in the JSON
 * and is not read. A text with no JSON is read as it is.
 */
export function printedResultTexts(output: string): readonly string[] {
  try {
    return stringsOf(JSON.parse(output));
  } catch {
    const key = STDOUT_KEY.exec(output);
    if (!key) return [output];
    const body = JSON_STRING_BODY.exec(output.slice(key.index + key[0].length))![0];
    return [JSON.parse(`"${body}"`) as string];
  }
}
