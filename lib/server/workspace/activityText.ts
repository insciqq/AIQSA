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

/** Exact accepted values only; this does not infer secrets from arbitrary prose. */
export function workspaceActivitySecretValues(secrets: readonly AcceptedWorkspaceSecret[]): string[] {
  const values: string[] = [];
  for (const secret of secrets) {
    const value = secret.value;
    switch (value.kind) {
      case "env": values.push(...value.entries.map((entry) => entry.value)); break;
      case "text": values.push(value.text); break;
      case "ssh_key": values.push(value.privateKey, value.passphrase); break;
      case "file": {
        const text = fileText(value.base64);
        if (text !== null) values.push(text);
        break;
      }
      case "browser_session": {
        const text = fileText(value.base64);
        if (text === null) break;
        values.push(text);
        // These are validated Playwright storage states, with named value fields.
        // Do not treat every string in an arbitrary file as a credential.
        const state = JSON.parse(text) as {
          cookies?: { value?: unknown }[];
          origins?: { localStorage?: { value?: unknown }[] }[];
        };
        for (const entry of [...state.cookies ?? [], ...state.origins?.flatMap((origin) => origin.localStorage ?? []) ?? []]) {
          if (typeof entry.value === "string") values.push(entry.value);
        }
        break;
      }
    }
  }
  return values;
}

/** Native literal matching avoids interpreting credentials as regular expressions. */
function maskPrefix(value: string, boundary: number, secrets: readonly string[]): { text: string; rest: string } {
  const positions = secrets.map((secret) => value.indexOf(secret));
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
    text += value.slice(cursor, start) + WORKSPACE_ACTIVITY_REDACTION;
    cursor = start + secrets[selected]!.length;
    for (let index = 0; index < secrets.length; index += 1) {
      if (positions[index]! >= 0 && positions[index]! < cursor) positions[index] = value.indexOf(secrets[index]!, cursor);
    }
  }
  return { text, rest: value.slice(cursor) };
}

export class WorkspaceActivityText {
  private readonly secrets: readonly string[];
  private readonly withheld: number;

  constructor(values: readonly string[] = []) {
    this.secrets = [...new Set(values.map(plainWorkspaceActivityText)
      .filter((value) => value.length >= WORKSPACE_ACTIVITY_SECRET_MIN_LENGTH))]
      .sort((left, right) => right.length - left.length);
    this.withheld = this.secrets.reduce((maximum, value) => Math.max(maximum, value.length - 1), 0);
  }

  text(value: string): string {
    const plain = plainWorkspaceActivityText(value);
    return maskPrefix(plain, plain.length, this.secrets).text;
  }

  withValues(values: readonly string[]): WorkspaceActivityText {
    return new WorkspaceActivityText([...this.secrets, ...values]);
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
        const projected = maskPrefix(pending, boundary, this.secrets);
        pending = projected.rest;
        closed = done;
        return projected.text;
      }
    };
  }
}
