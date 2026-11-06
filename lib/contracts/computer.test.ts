import { decodeThreadToolActivity, isThreadToolActivityOrigin } from "./chats";
import {
  COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH,
  COMPUTER_ERROR_CODES,
  COMPUTER_ERROR_HTTP_STATUS,
  COMPUTER_FAILURE_CODES,
  COMPUTER_MAX_CWD_LENGTH,
  COMPUTER_REFUSALS,
  COMPUTER_SEND_FIELD,
  COMPUTER_TOOL_NAMES,
  COMPUTER_TOOL_OPS,
  computerActivitySummary,
  connectComputerDirsPath,
  connectComputerRecentDirsPath,
  connectComputerStatPath,
  decodeChatComputerBinding,
  decodeComputerSendField,
  decodeConnectComputerDirsResponse,
  decodeConnectComputerErrorResponse,
  decodeConnectComputerEventsStreamEvent,
  decodeConnectComputerListResponse,
  decodeConnectComputerRecentDirsResponse,
  decodeConnectComputerStatResponse,
  isComputerExitCode,
  isComputerToolName
} from "./computer";
import { CONNECT_OPS } from "./connect";

const DEVICE_ID = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";

describe("computer send field", () => {
  it("tells absent, an explicit none and a binding apart", () => {
    expect(COMPUTER_SEND_FIELD).toBe("computer");
    expect(decodeComputerSendField(undefined)).toBeUndefined();
    expect(decodeComputerSendField(null)).toBeNull();
    expect(decodeComputerSendField({ deviceId: DEVICE_ID, cwd: "C:\\Users\\ivan\\Документы" }))
      .toEqual({ cwd: "C:\\Users\\ivan\\Документы", deviceId: DEVICE_ID });
    expect(decodeComputerSendField({ cwd: "~", deviceId: DEVICE_ID })).toEqual({ cwd: "~", deviceId: DEVICE_ID });
  });

  it("refuses malformed, oversize and control-character bindings", () => {
    const at = (cwd: unknown, extra: Record<string, unknown> = {}) => decodeComputerSendField({ cwd, deviceId: DEVICE_ID, ...extra });
    expect(at("a".repeat(COMPUTER_MAX_CWD_LENGTH))).not.toBe("invalid");
    expect(at("😀".repeat(COMPUTER_MAX_CWD_LENGTH))).not.toBe("invalid");
    expect(at("a".repeat(COMPUTER_MAX_CWD_LENGTH + 1))).toBe("invalid");
    expect(at("/home/ivan\u0000/x")).toBe("invalid");
    expect(at("/home/ivan\n")).toBe("invalid");
    expect(at("/home/\u009bivan")).toBe("invalid");
    expect(at("")).toBe("invalid");
    expect(at("   ")).toBe("invalid");
    expect(at(42)).toBe("invalid");
    expect(at("~", { name: "laptop" })).toBe("invalid");
    expect(decodeComputerSendField({ cwd: "~" })).toBe("invalid");
    expect(decodeComputerSendField({ cwd: "~", deviceId: DEVICE_ID.toUpperCase() })).toBe("invalid");
    expect(decodeComputerSendField({ cwd: "~", deviceId: "laptop" })).toBe("invalid");
    expect(decodeComputerSendField(true)).toBe("invalid");
    expect(decodeComputerSendField([DEVICE_ID, "~"])).toBe("invalid");
    expect(decodeComputerSendField("~")).toBe("invalid");
    expect(decodeChatComputerBinding(null)).toBeNull();
  });
});

describe("computer tools and codes", () => {
  it("maps every tool to a device op", () => {
    expect(Object.keys(COMPUTER_TOOL_OPS).sort()).toEqual([...COMPUTER_TOOL_NAMES].sort());
    for (const op of Object.values(COMPUTER_TOOL_OPS)) expect(CONNECT_OPS).toContain(op);
    expect(isComputerToolName("computer_shell")).toBe(true);
    expect(isComputerToolName("workspace_shell")).toBe(false);
  });

  it("gives each route refusal a status", () => {
    expect(COMPUTER_FAILURE_CODES.every((code) => (COMPUTER_ERROR_CODES as readonly string[]).includes(code))).toBe(true);
    expect(Object.values(COMPUTER_REFUSALS)).toContain("computer_unavailable_here");
    expect(Object.keys(COMPUTER_ERROR_HTTP_STATUS).sort()).toEqual([...COMPUTER_ERROR_CODES].sort());
    expect(new Set(COMPUTER_ERROR_CODES).size).toBe(COMPUTER_ERROR_CODES.length);
  });
});

describe("computer answer steps", () => {
  it("cuts a summary to one bounded line", () => {
    expect(computerActivitySummary("\n  Get-ChildItem *.docx\nWrite-Output done")).toBe("Get-ChildItem *.docx");
    expect(computerActivitySummary("echo\u001b[31m red")).toBe("echo[31m red");
    expect(computerActivitySummary(" \n\t\n")).toBeNull();
    const long = computerActivitySummary("ж".repeat(COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH + 10))!;
    expect(Array.from(long)).toHaveLength(COMPUTER_ACTIVITY_SUMMARY_MAX_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("decodes computer steps with their summary and exit code, and drops them elsewhere", () => {
    expect(isThreadToolActivityOrigin("computer")).toBe(true);
    const activity = decodeThreadToolActivity({
      calls: [
        { exitCode: 3221225477, origin: "computer", round: 1, status: "complete", summary: "npm test", toolName: "computer_shell" },
        { origin: "computer", round: 1, status: "error", summary: "line\nbreak", toolName: "computer_read" },
        { exitCode: 1.5, origin: "computer", round: 2, status: "complete", toolName: "computer_shell" },
        { exitCode: 2, origin: "workspace", round: 2, status: "complete", summary: "ls", toolName: "workspace_shell" }
      ]
    });
    expect(activity?.calls).toEqual([
      { exitCode: 3221225477, origin: "computer", round: 1, status: "complete", summary: "npm test", toolName: "computer_shell" },
      { origin: "computer", round: 1, status: "error", toolName: "computer_read" },
      { origin: "computer", round: 2, status: "complete", toolName: "computer_shell" },
      { origin: "workspace", round: 2, status: "complete", toolName: "workspace_shell" }
    ]);
    expect(isComputerExitCode(-1)).toBe(true);
    expect(isComputerExitCode(4294967296)).toBe(false);
  });
});

describe("computer browser wire", () => {
  const computer = {
    id: DEVICE_ID,
    name: "DESKTOP-7Q2",
    os: "windows",
    arch: "amd64",
    online: true,
    lastSeenAt: "2026-11-06T10:15:30.123Z",
    clientVersion: "0.5.0",
    info: {
      osVersion: "Windows 11 Pro 23H2",
      home: "C:\\Users\\ivan",
      shell: { kind: "powershell", name: "Windows PowerShell", version: "5.1.22621.4391" }
    }
  };
  const offline = { ...computer, id: "c4ca4238-a0b9-4382-8dcc-509a6f75849b", info: undefined, lastSeenAt: null, online: false, os: "linux" };
  delete (offline as { info?: unknown }).info;

  it("decodes the computer list and refuses foreign shapes", () => {
    expect(decodeConnectComputerListResponse({ computers: [computer, offline] })).toEqual({ computers: [computer, offline] });
    expect(decodeConnectComputerListResponse({ computers: [] })).toEqual({ computers: [] });
    expect(decodeConnectComputerListResponse({ computers: [computer, computer] })).toBeNull();
    expect(decodeConnectComputerListResponse({ computers: [{ ...computer, sessions: [] }] })).toBeNull();
    expect(decodeConnectComputerListResponse({ computers: [{ ...computer, os: "freebsd" }] })).toBeNull();
    expect(decodeConnectComputerListResponse({ computers: [{ ...computer, info: { ...computer.info, home: "ivan" } }] })).toBeNull();
    expect(decodeConnectComputerListResponse({ devices: [] })).toBeNull();
  });

  it("decodes the folder picker's responses", () => {
    expect(decodeConnectComputerRecentDirsResponse({ dirs: ["C:\\Users\\ivan\\Desktop"], home: "C:\\Users\\ivan" })).not.toBeNull();
    expect(decodeConnectComputerDirsResponse({ dirs: ["Documents"], parent: null, path: "/", truncated: false })).not.toBeNull();
    expect(decodeConnectComputerStatResponse({ exists: false })).toEqual({ exists: false });
    expect(decodeConnectComputerStatResponse({ exists: true })).toBeNull();
    expect(decodeConnectComputerErrorResponse({ code: "computer_path_not_found" })).toEqual({ code: "computer_path_not_found" });
    expect(decodeConnectComputerErrorResponse({ code: "connect_not_found" })).toEqual({ code: "connect_not_found" });
    expect(decodeConnectComputerErrorResponse({ code: "nope" })).toBeNull();
  });

  it("decodes the device-list stream with computers", () => {
    expect(decodeConnectComputerEventsStreamEvent("device", JSON.stringify({ computer }))).toEqual({ data: { computer }, event: "device" });
    expect(decodeConnectComputerEventsStreamEvent("devices", JSON.stringify({ computers: [offline] })))
      .toEqual({ data: { computers: [offline] }, event: "devices" });
    expect(decodeConnectComputerEventsStreamEvent("closed", JSON.stringify({ code: "connect_disabled" }))).not.toBeNull();
    expect(decodeConnectComputerEventsStreamEvent("ping", "{}")).toEqual({ data: {}, event: "ping" });
    expect(decodeConnectComputerEventsStreamEvent("devices", "not json")).toBeNull();
  });

  it("builds the browser routes with encoded segments and queries", () => {
    expect(connectComputerRecentDirsPath(DEVICE_ID)).toBe(`/api/connect/devices/${DEVICE_ID}/recent-dirs`);
    expect(connectComputerDirsPath(DEVICE_ID, "C:\\Users\\ivan & co")).toBe(
      `/api/connect/devices/${DEVICE_ID}/dirs?path=C%3A%5CUsers%5Civan%20%26%20co`
    );
    expect(connectComputerStatPath("../x", "~")).toBe("/api/connect/devices/..%2Fx/stat?path=~");
  });
});
