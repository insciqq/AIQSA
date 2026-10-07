export type TextLineDiffLine = Readonly<{ kind: "context" | "add" | "del" | "gap"; text: string }>;
export type TextLineDiff = Readonly<{ lines: readonly TextLineDiffLine[]; truncated: boolean }>;

type Op = Readonly<{ kind: "eq" | "add" | "del"; text: string }>;

/** Myers' shortest edit script over lines, or null beyond `maxEdits` (memory O(D²)). */
function editScript(a: readonly string[], b: readonly string[], maxEdits: number): Op[] | null {
  const n = a.length, m = b.length;
  const trace: Int32Array[] = [];
  let end: { d: number } | null = null;
  for (let d = 0; d <= Math.min(maxEdits, n + m); d += 1) {
    const prev = trace[d - 1];
    const current = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && prev![k - 1 + d - 1]! < prev![k + 1 + d - 1]!)) x = prev![k + 1 + d - 1]!;
      else x = prev![k - 1 + d - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      current[k + d] = x;
      if (x >= n && y >= m) { end = { d }; break; }
    }
    trace.push(current);
    if (end) break;
  }
  if (!end) return null;
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = end.d; d > 0; d -= 1) {
    const prev = trace[d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1]! < prev[k + 1 + d - 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: "eq", text: a[x - 1]! }); x -= 1; y -= 1; }
    if (down) { ops.push({ kind: "add", text: b[y - 1]! }); y -= 1; } else { ops.push({ kind: "del", text: a[x - 1]! }); x -= 1; }
  }
  while (x > 0 && y > 0) { ops.push({ kind: "eq", text: a[x - 1]! }); x -= 1; y -= 1; }
  return ops.reverse();
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A bounded unified line diff for review cards: changed lines with
 * `context` lines around them, `gap` between distant hunks, at most
 * `maxLines` lines of at most `maxLineLength` characters. Null when the
 * inputs are too large or too different to diff cheaply.
 */
export function boundedTextLineDiff(before: string, after: string, options: Readonly<{
  context?: number; maxLines: number; maxLineLength: number; maxInputLines?: number; maxEdits?: number;
}>): TextLineDiff | null {
  const context = options.context ?? 3;
  const a = splitLines(before), b = splitLines(after);
  if (a.length + b.length > (options.maxInputLines ?? 40_000)) return null;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const middle = editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), options.maxEdits ?? 1_000);
  if (!middle) return null;
  const ops: Op[] = [...a.slice(0, prefix).map((text) => ({ kind: "eq" as const, text })), ...middle,
    ...a.slice(a.length - suffix).map((text) => ({ kind: "eq" as const, text }))];
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === "eq") return;
    for (let near = Math.max(0, index - context); near <= Math.min(ops.length - 1, index + context); near += 1) keep[near] = true;
  });
  const lines: TextLineDiffLine[] = [];
  let truncated = false;
  const clip = (text: string) => text.length > options.maxLineLength ? `${text.slice(0, options.maxLineLength - 1)}…` : text;
  const push = (line: TextLineDiffLine) => {
    if (lines.length >= options.maxLines) { truncated = true; return false; }
    lines.push(line);
    return true;
  };
  let skipped = false;
  for (let index = 0; index < ops.length; index += 1) {
    if (!keep[index]) { skipped = true; continue; }
    if (skipped && lines.length > 0 && !push({ kind: "gap", text: "" })) break;
    skipped = false;
    const op = ops[index]!;
    if (!push({ kind: op.kind === "eq" ? "context" : op.kind, text: clip(op.text) })) break;
  }
  return { lines, truncated };
}
