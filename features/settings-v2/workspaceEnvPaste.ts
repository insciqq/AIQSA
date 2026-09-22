export type WorkspaceEnvEntry = Readonly<{ name: string; value: string }>;
export const WORKSPACE_ENV_ENTRY_LIMIT = 64;
export const WORKSPACE_ENV_PASTE_CHARACTER_LIMIT = 128 * 1024;

type Result = Readonly<{
  entries: readonly WorkspaceEnvEntry[];
  added: number;
  replaced: number;
  skipped: number;
  tooLarge: boolean;
}>;

/** Local text parsing only: values are never evaluated, expanded or persisted. */
export function mergeWorkspaceEnvPaste(text: string, existing: readonly WorkspaceEnvEntry[]): Result {
  if (text.length > WORKSPACE_ENV_PASTE_CHARACTER_LIMIT) return { entries: existing, added: 0, replaced: 0, skipped: 0, tooLarge: true };
  const lines = text.split("\n");
  const parsed = new Map<string, string>();
  let skipped = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trimStart().replace(/^export[ \t]+/u, "");
    if (!line.trim() || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const name = line.slice(0, equals).trim();
    if (equals < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) { skipped++; continue; }
    let source = line.slice(equals + 1).trimStart();
    const quote = source[0];
    if (quote !== "'" && quote !== '"') { parsed.set(name, source.trim()); continue; }
    let value = "", closed = false;
    for (let cursor = 1; ; cursor++) {
      if (cursor >= source.length) {
        if (lineIndex + 1 >= lines.length) break;
        value += "\n";
        source = lines[++lineIndex];
        cursor = -1;
        continue;
      }
      const character = source[cursor];
      if (character === quote) {
        const tail = source.slice(cursor + 1).trim();
        closed = !tail || tail.startsWith("#");
        break;
      }
      if (quote === '"' && character === "\\" && cursor + 1 < source.length) {
        const escaped = source[++cursor];
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
        value += escapes[escaped] ?? `\\${escaped}`;
      } else value += character;
    }
    if (closed) parsed.set(name, value);
    else skipped++;
  }
  const entries = existing.map(entry => ({ ...entry }));
  while (entries.length && !entries.at(-1)!.name && !entries.at(-1)!.value) entries.pop();
  let added = 0, replaced = 0;
  for (const [name, value] of parsed) {
    const found = entries.findIndex(entry => entry.name === name);
    if (found >= 0) { entries[found] = { name, value }; replaced++; }
    else if (entries.length < WORKSPACE_ENV_ENTRY_LIMIT) { entries.push({ name, value }); added++; }
    else skipped++;
  }
  return { entries: entries.length ? entries : [{ name: "", value: "" }], added, replaced, skipped, tooLarge: false };
}
