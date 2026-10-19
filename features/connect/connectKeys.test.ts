import { describe, expect, it, vi } from "vitest";
import {
  CONNECT_KEYS,
  ConnectTerminalInput,
  connectComposeSequence,
  connectControlCharacter,
  connectKeySequence,
  type ConnectTerminalModes
} from "./connectKeys";

const NORMAL: ConnectTerminalModes = { applicationCursorKeys: false, bracketedPaste: false };
const APPLICATION: ConnectTerminalModes = { applicationCursorKeys: true, bracketedPaste: true };

function input(modes: ConnectTerminalModes = NORMAL) {
  const sent: string[] = [];
  const ctrl: boolean[] = [];
  const current = { modes };
  const terminal = new ConnectTerminalInput({
    modes: () => current.modes,
    onCtrlChange: (armed) => ctrl.push(armed),
    send: (data) => sent.push(data)
  });
  return { ctrl, current, sent, terminal };
}

describe("connectKeySequence", () => {
  it("sends each key bar key as a terminal keyboard does", () => {
    expect(Object.fromEntries(CONNECT_KEYS.map((key) => [key, connectKeySequence(key, NORMAL)]))).toEqual({
      ctrl_c: "\u0003",
      down: "\u001b[B",
      enter: "\r",
      escape: "\u001b",
      left: "\u001b[D",
      right: "\u001b[C",
      shift_tab: "\u001b[Z",
      tab: "\t",
      up: "\u001b[A"
    });
  });

  it("follows the application cursor mode for the arrows only", () => {
    expect(["up", "down", "right", "left"].map((key) => connectKeySequence(key as "up", APPLICATION)))
      .toEqual(["\u001bOA", "\u001bOB", "\u001bOC", "\u001bOD"]);
    expect(connectKeySequence("escape", APPLICATION)).toBe("\u001b");
    expect(connectKeySequence("enter", APPLICATION)).toBe("\r");
  });

  it("modifies arrows with Ctrl like xterm", () => {
    expect(connectKeySequence("up", APPLICATION, true)).toBe("\u001b[1;5A");
    expect(connectKeySequence("left", NORMAL, true)).toBe("\u001b[1;5D");
  });
});

describe("connectControlCharacter", () => {
  it("maps letters of either case and the usual symbols", () => {
    expect(connectControlCharacter("c")).toBe("\u0003");
    expect(connectControlCharacter("C")).toBe("\u0003");
    expect(connectControlCharacter("a")).toBe("\u0001");
    expect(connectControlCharacter("z")).toBe("\u001a");
    expect(connectControlCharacter("[")).toBe("\u001b");
    expect(connectControlCharacter(" ")).toBe("\u0000");
    expect(connectControlCharacter("?")).toBe("\u007f");
    expect(connectControlCharacter("é")).toBeNull();
    expect(connectControlCharacter("1")).toBeNull();
  });
});

describe("connectComposeSequence", () => {
  it("pastes in brackets when the program asked for it, then presses Enter", () => {
    expect(connectComposeSequence("fix the test", APPLICATION)).toBe("\u001b[200~fix the test\u001b[201~\r");
  });

  it("sends raw text and Enter otherwise", () => {
    expect(connectComposeSequence("ls -la", NORMAL)).toBe("ls -la\r");
  });

  it("turns newlines into carriage returns and drops escape characters", () => {
    expect(connectComposeSequence("one\ntwo\r\nthree", NORMAL)).toBe("one\rtwo\rthree\r");
    expect(connectComposeSequence("a\u001b[201~b", APPLICATION)).toBe("\u001b[200~a[201~b\u001b[201~\r");
  });
});

describe("ConnectTerminalInput", () => {
  it("sends key bar keys in the terminal's current mode", () => {
    const { current, sent, terminal } = input();
    terminal.key("up");
    current.modes = APPLICATION;
    terminal.key("up");
    terminal.key("shift_tab");
    terminal.key("ctrl_c");
    expect(sent).toEqual(["\u001b[A", "\u001bOA", "\u001b[Z", "\u0003"]);
  });

  it("keeps Ctrl armed for exactly one typed key", () => {
    const { ctrl, sent, terminal } = input();
    terminal.toggleCtrl();
    expect(terminal.ctrl).toBe(true);
    terminal.typed("r");
    terminal.typed("r");
    expect(sent).toEqual(["\u0012", "r"]);
    expect(ctrl).toEqual([true, false]);
  });

  it("applies Ctrl to the first character of a longer chunk only", () => {
    const { sent, terminal } = input();
    terminal.toggleCtrl();
    terminal.typed("dx");
    terminal.toggleCtrl();
    terminal.typed("😀a");
    expect(sent).toEqual(["\u0004x", "😀a"]);
  });

  it("uses Ctrl with an arrow and drops it for other keys", () => {
    const { sent, terminal } = input(APPLICATION);
    terminal.toggleCtrl();
    terminal.key("right");
    terminal.toggleCtrl();
    terminal.key("tab");
    terminal.typed("a");
    expect(sent).toEqual(["\u001b[1;5C", "\t", "a"]);
  });

  it("toggles Ctrl off on a second tap", () => {
    const { ctrl, sent, terminal } = input();
    terminal.toggleCtrl();
    terminal.toggleCtrl();
    terminal.typed("c");
    expect(sent).toEqual(["c"]);
    expect(ctrl).toEqual([true, false]);
  });

  it("sends compose text as one paste with Enter, and answers exactly", () => {
    const { sent, terminal } = input(APPLICATION);
    terminal.toggleCtrl();
    terminal.compose("run the tests");
    terminal.answer("2");
    expect(sent).toEqual(["\u001b[200~run the tests\u001b[201~\r", "2"]);
    expect(terminal.ctrl).toBe(false);
  });

  it("sends nothing for an empty chunk", () => {
    const send = vi.fn();
    const terminal = new ConnectTerminalInput({ modes: () => NORMAL, send });
    terminal.typed("");
    expect(send).not.toHaveBeenCalled();
  });
});
