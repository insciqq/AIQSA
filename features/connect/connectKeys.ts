/**
 * What the human sends from the touch controls, as the bytes a terminal
 * keyboard would send. Every byte goes to the session's serial input queue;
 * nothing here types on its own.
 */

/** The terminal modes the program on screen switched on, as xterm.js reports them. */
export type ConnectTerminalModes = Readonly<{
  /** DECCKM: arrows send `ESC O A` instead of `ESC [ A`. */
  applicationCursorKeys: boolean;
  /** The program wants pasted text between `ESC [200~` and `ESC [201~`. */
  bracketedPaste: boolean;
}>;

export const CONNECT_KEYS = ["escape", "tab", "shift_tab", "up", "down", "right", "left", "ctrl_c", "enter"] as const;
export type ConnectKey = (typeof CONNECT_KEYS)[number];

const ESC = "\u001b";
const ARROW_FINALS = { down: "B", left: "D", right: "C", up: "A" } as const;
type ConnectArrow = keyof typeof ARROW_FINALS;

function isArrow(key: ConnectKey): key is ConnectArrow {
  return key in ARROW_FINALS;
}

/** The bytes of one key bar key; `ctrl` modifies the arrows like xterm (`ESC [1;5A`). */
export function connectKeySequence(key: ConnectKey, modes: ConnectTerminalModes, ctrl = false): string {
  if (isArrow(key)) {
    const final = ARROW_FINALS[key];
    if (ctrl) return `${ESC}[1;5${final}`;
    return modes.applicationCursorKeys ? `${ESC}O${final}` : `${ESC}[${final}`;
  }
  switch (key) {
    case "escape":
      return ESC;
    case "tab":
      return "\t";
    case "shift_tab":
      return `${ESC}[Z`;
    case "ctrl_c":
      return "\u0003";
    case "enter":
      return "\r";
  }
}

/** The control character of Ctrl held with `character`, or null when that pair has none. */
export function connectControlCharacter(character: string): string | null {
  if (character.length !== 1) return null;
  const code = character.charCodeAt(0);
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return String.fromCharCode(code & 0x1f);
  switch (character) {
    case " ":
    case "@":
    case "2":
      return "\u0000";
    case "[":
      return ESC;
    case "\\":
      return "\u001c";
    case "]":
      return "\u001d";
    case "^":
    case "6":
      return "\u001e";
    case "_":
    case "-":
      return "\u001f";
    case "?":
      return "\u007f";
    default:
      return null;
  }
}

/**
 * Text from the compose field as a paste followed by Enter: newlines become
 * carriage returns as in xterm's own paste, escape characters are dropped so
 * the text cannot end the bracket early, and the bracket is used only when
 * the program asked for it.
 */
export function connectComposeSequence(text: string, modes: ConnectTerminalModes): string {
  const body = text.replace(/\r?\n/gu, "\r").replaceAll(ESC, "");
  return `${modes.bracketedPaste ? `${ESC}[200~${body}${ESC}[201~` : body}\r`;
}

/** Keys of the answer strip when the agent's choices could not be read. */
export const CONNECT_FALLBACK_ANSWERS: readonly Readonly<{ data: string; label: string }>[] = [
  { data: "\r", label: "Enter" },
  { data: ESC, label: "Esc" },
  { data: "y", label: "y" },
  { data: "n", label: "n" }
];

/**
 * The touch input of one terminal: the key bar, the sticky Ctrl, the compose
 * field and the answer buttons, all sent through `send` (the session's input
 * queue). Ctrl stays armed for exactly one key, typed or tapped.
 */
export class ConnectTerminalInput {
  private ctrlArmed = false;

  constructor(private readonly options: Readonly<{
    modes(): ConnectTerminalModes;
    onCtrlChange?(armed: boolean): void;
    send(data: string): void;
  }>) {}

  get ctrl(): boolean {
    return this.ctrlArmed;
  }

  toggleCtrl(): void {
    this.setCtrl(!this.ctrlArmed);
  }

  /** A key bar key. */
  key(key: ConnectKey): void {
    const ctrl = this.ctrlArmed;
    this.setCtrl(false);
    this.options.send(connectKeySequence(key, this.options.modes(), ctrl && isArrow(key)));
  }

  /**
   * Keystrokes typed into the terminal or, while Ctrl is armed, into the
   * compose field: an armed Ctrl turns the first character into its control
   * character.
   */
  typed(data: string): void {
    if (!data) return;
    if (!this.ctrlArmed) {
      this.options.send(data);
      return;
    }
    this.setCtrl(false);
    const first = String.fromCodePoint(data.codePointAt(0)!);
    const control = connectControlCharacter(first);
    this.options.send(control === null ? data : control + data.slice(first.length));
  }

  /** Send in the compose field. */
  compose(text: string): void {
    this.setCtrl(false);
    this.options.send(connectComposeSequence(text, this.options.modes()));
  }

  /** An answer button: its key exactly as shown. */
  answer(data: string): void {
    this.setCtrl(false);
    this.options.send(data);
  }

  private setCtrl(armed: boolean): void {
    if (armed === this.ctrlArmed) return;
    this.ctrlArmed = armed;
    this.options.onCtrlChange?.(armed);
  }
}
