import type { AcceptedWorkspaceSecret } from "./secrets/store";

export const WORKSPACE_ACTIVITY_SECRET_MIN_LENGTH = 8;
export const WORKSPACE_ACTIVITY_REDACTION = "•••";

/** Stateful because a poll can end in the middle of CSI, OSC or a string escape. */
class PlainTerminalText {
  private state: "text" | "escape" | "csi" | "string" | "string_escape" | "charset" = "text";

  push(value: string): string {
    let result = "";
    for (const character of value) {
      const code = character.codePointAt(0)!;
      if (this.state === "string") {
        if (character === "\x07" || character === "\x9c") this.state = "text";
        else if (character === "\x1b") this.state = "string_escape";
      } else if (this.state === "string_escape") {
        this.state = character === "\\" ? "text" : character === "\x1b" ? "string_escape" : "string";
      } else if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (character === "\x1b") this.state = "escape";
      } else if (this.state === "charset") {
        this.state = "text";
      } else if (this.state === "escape") {
        this.state = character === "[" ? "csi"
          : "]P^_X".includes(character) ? "string"
            : "()*+,-./".includes(character) ? "charset" : "text";
      } else if (character === "\x1b") {
        this.state = "escape";
      } else if (character === "\x9b") {
        this.state = "csi";
      } else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.state = "string";
      } else if (character === "\n" || character === "\r" || character === "\t" ||
        code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) {
        result += character;
      }
    }
    return result;
  }
}

export function plainWorkspaceActivityText(value: string): string {
  return new PlainTerminalText().push(value);
}

/** Bound public text without leaving an unmatched UTF-16 surrogate. */
export function clipWorkspaceActivityText(value: string, characters: number): string {
  const end = characters < value.length && /[\udc00-\udfff]/u.test(value[characters]!) ? characters - 1 : characters;
  return value.slice(0, end);
}

export function clipWorkspaceActivityBytes(value: string, bytes: number): string {
  let used = 0;
  let length = 0;
  for (const character of value) {
    used += Buffer.byteLength(character);
    if (used > bytes) break;
    length += character.length;
  }
  return value.slice(0, length);
}

function fileText(base64: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(base64, "base64"));
  } catch {
    return null;
  }
}

/** An exact delivered value and the name its placeholder shows; an unnamed value shows the bare redaction mark. */
export type WorkspaceSecretMatch = Readonly<{ name?: string; value: string }>;

/**
 * Exact accepted values only; this does not infer secrets from arbitrary prose.
 * An environment value is named by its variable, every other value by its secret.
 */
export function workspaceSecretMatches(secrets: readonly AcceptedWorkspaceSecret[]): WorkspaceSecretMatch[] {
  const matches: WorkspaceSecretMatch[] = [];
  for (const secret of secrets) {
    const value = secret.value;
    const named = (text: string) => ({ name: secret.name, value: text });
    switch (value.kind) {
      case "env": matches.push(...value.entries.map((entry) => ({ name: entry.name, value: entry.value }))); break;
      case "text": matches.push(named(value.text)); break;
      case "ssh_key": matches.push(named(value.privateKey), named(value.passphrase)); break;
      case "file": {
        const text = fileText(value.base64);
        if (text !== null) matches.push(named(text));
        break;
      }
      case "browser_session": {
        const text = fileText(value.base64);
        if (text === null) break;
        matches.push(named(text));
        // These are validated Playwright storage states, with named value fields.
        // Do not treat every string in an arbitrary file as a credential.
        const state = JSON.parse(text) as {
          cookies?: { value?: unknown }[];
          origins?: { localStorage?: { value?: unknown }[] }[];
        };
        for (const entry of [...state.cookies ?? [], ...state.origins?.flatMap((origin) => origin.localStorage ?? []) ?? []]) {
          if (typeof entry.value === "string") matches.push(named(entry.value));
        }
        break;
      }
    }
  }
  return matches;
}

export function workspaceActivitySecretValues(secrets: readonly AcceptedWorkspaceSecret[]): string[] {
  return workspaceSecretMatches(secrets).map((match) => match.value);
}

/**
 * `[secret:<NAME>]` with a display-safe name. A placeholder that would itself
 * contain a masked value falls back to the bare `[secret]`.
 */
export function workspaceSecretPlaceholder(name: string | undefined, values: readonly string[] = []): string {
  const safe = (name ?? "").replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64);
  const placeholder = safe ? `[secret:${safe}]` : "[secret]";
  return values.some((value) => value.length >= WORKSPACE_ACTIVITY_SECRET_MIN_LENGTH && placeholder.includes(value))
    ? "[secret]" : placeholder;
}

/** Exact values at or above the masking threshold, longest first, each with its replacement; the first name of a value wins. */
export function workspaceSecretReplacements(
  matches: readonly WorkspaceSecretMatch[],
  unnamed = WORKSPACE_ACTIVITY_REDACTION
): Readonly<{ replacement: string; value: string }>[] {
  const eligible = matches.filter((match) => match.value.length >= WORKSPACE_ACTIVITY_SECRET_MIN_LENGTH);
  const values = eligible.map((match) => match.value);
  const seen = new Set<string>();
  const result: { replacement: string; value: string }[] = [];
  for (const match of eligible) {
    if (seen.has(match.value)) continue;
    seen.add(match.value);
    result.push({ replacement: match.name === undefined ? unnamed : workspaceSecretPlaceholder(match.name, values), value: match.value });
  }
  return result.sort((left, right) => right.value.length - left.value.length);
}

/** Native literal matching avoids interpreting credentials as regular expressions. */
export function maskWorkspaceSecretPrefix(
  value: string,
  boundary: number,
  secrets: readonly Readonly<{ replacement: string; value: string }>[]
): { text: string; rest: string } {
  const positions = secrets.map((secret) => value.indexOf(secret.value));
  let cursor = 0;
  let text = "";
  while (cursor < boundary) {
    let selected = -1;
    for (let index = 0; index < secrets.length; index += 1) {
      if (positions[index]! >= 0 && (selected < 0 || positions[index]! < positions[selected]!)) selected = index;
    }
    if (selected < 0 || positions[selected]! >= boundary) {
      // Do not split a surrogate pair at the streaming boundary.
      if (boundary < value.length && /[\udc00-\udfff]/u.test(value[boundary]!)) boundary -= 1;
      text += value.slice(cursor, boundary);
      cursor = boundary;
      break;
    }
    const start = positions[selected]!;
    text += value.slice(cursor, start) + secrets[selected]!.replacement;
    cursor = start + secrets[selected]!.value.length;
    for (let index = 0; index < secrets.length; index += 1) {
      if (positions[index]! >= 0 && positions[index]! < cursor) positions[index] = value.indexOf(secrets[index]!.value, cursor);
    }
  }
  return { text, rest: value.slice(cursor) };
}

export class WorkspaceActivityText {
  private readonly matches: readonly WorkspaceSecretMatch[];
  private readonly secrets: readonly Readonly<{ replacement: string; value: string }>[];
  private readonly withheld: number;

  /** Named values render as `[secret:<NAME>]`, like masked command output; unnamed ones as the bare mark. */
  constructor(values: readonly (string | WorkspaceSecretMatch)[] = []) {
    this.matches = values.map((entry) => typeof entry === "string" ? { value: entry } : entry)
      .map((entry) => ({ ...entry, value: plainWorkspaceActivityText(entry.value) }));
    this.secrets = workspaceSecretReplacements(this.matches);
    this.withheld = this.secrets.reduce((maximum, secret) => Math.max(maximum, secret.value.length - 1), 0);
  }

  text(value: string): string {
    const plain = plainWorkspaceActivityText(value);
    return maskWorkspaceSecretPrefix(plain, plain.length, this.secrets).text;
  }

  withValues(values: readonly (string | WorkspaceSecretMatch)[]): WorkspaceActivityText {
    return new WorkspaceActivityText([...this.matches, ...values]);
  }

  /** Redact before the caller bounds its output buffer, including very long secrets. */
  stream(): { push(chunk: string, done?: boolean): string } {
    const terminal = new PlainTerminalText();
    let pending = "";
    let closed = false;
    return {
      push: (chunk, done = false) => {
        if (closed) throw new Error("workspace_activity_stream_closed");
        pending += terminal.push(chunk);
        const boundary = done ? pending.length : Math.max(0, pending.length - this.withheld);
        const projected = maskWorkspaceSecretPrefix(pending, boundary, this.secrets);
        pending = projected.rest;
        closed = done;
        return projected.text;
      }
    };
  }
}
