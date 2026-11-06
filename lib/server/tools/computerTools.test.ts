// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_TOOL_NAMES } from "@/lib/contracts/computer";
import { createFakeComputerOps, type ComputerOpCall } from "../connect/computerPort";
import type { FrozenComputerBinding } from "./computerBinding";
import {
  COMPUTER_TOOL_EFFECTS,
  COMPUTER_TOOL_LIMITS,
  ComputerOpError,
  computerActivityFacts,
  computerEngineTools,
  computerToolCallMs,
  computerToolDefinitions,
  COMPUTER_NO_TOOL_TIME,
  executeComputerTool,
  prepareComputerCall
} from "./computerTools";
import type { ModelToolCall } from "./types";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const RUN = "1679091c-5a88-4faf-afb5-e6087eb1b2dc";
const binding: FrozenComputerBinding = { arch: "amd64", cwd: "C:\\Users\\ivan\\Reports", deviceId: DEVICE, name: "DESKTOP-7Q2",
  online: true, os: "windows" };

const call = (name: string, args: Record<string, unknown>): ModelToolCall => ({ arguments: args, id: `call-${name}`, name });
const signal = () => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe("computer tool definitions", () => {
  it("offers the eight tools, strict, of capability computer, with the effects D-05 names", () => {
    const tools = computerToolDefinitions("windows");
    expect(tools.map((tool) => tool.name)).toEqual([...COMPUTER_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool).toMatchObject({ capability: "computer", strict: true });
      const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    }
    expect(Object.entries(COMPUTER_TOOL_EFFECTS).filter(([, effects]) => effects === "none").map(([name]) => name).sort())
      .toEqual(["computer_glob", "computer_grep", "computer_job_output", "computer_read"]);
    expect(Object.entries(COMPUTER_TOOL_EFFECTS).filter(([, effects]) => effects === "external").map(([name]) => name).sort())
      .toEqual(["computer_edit", "computer_job_stop", "computer_shell", "computer_write"]);
  });

  it("describes the shell by the computer's OS alone, the same text for every turn", () => {
    const shell = (os: "darwin" | "linux" | "windows") => computerToolDefinitions(os).find((tool) => tool.name === "computer_shell")!.description;
    expect(shell("windows")).toContain("PowerShell");
    expect(shell("darwin")).toContain("login shell on their macOS computer");
    expect(shell("linux")).toContain("login shell on their Linux computer");
    // A login shell reads no interactive rc file, so the description never promises the terminal's PATH.
    expect(shell("darwin")).toContain("not interactive files such as ~/.zshrc");
    expect(shell("linux")).not.toContain("as in their terminal");
    expect(JSON.stringify(computerToolDefinitions("windows"))).toBe(JSON.stringify(computerToolDefinitions("windows")));
    const edit = computerToolDefinitions("linux").find((tool) => tool.name === "computer_edit")!.description;
    expect(edit).toContain("Read the file with computer_read in this conversation first");
  });

  it("bounds a command by its longest timeout and its reply, and the rest by a minute", () => {
    expect(computerToolCallMs("computer_shell")).toBe(600_000 + COMPUTER_TOOL_LIMITS.shellReplyMs);
    expect(computerToolCallMs("computer_read")).toBe(60_000);
  });
});

describe("computer call preparation", () => {
  it("fills the defaults and the frozen folder, and leaves the folder out of job operations", () => {
    expect(prepareComputerCall("computer_shell", { background: null, command: "dir", timeoutSeconds: null }, "~"))
      .toEqual({ args: { background: false, command: "dir", cwd: "~", timeoutSeconds: 120 }, op: "shell",
        timeoutMs: 120_000 + COMPUTER_TOOL_LIMITS.shellReplyMs });
    expect(prepareComputerCall("computer_grep", { context: null, glob: null, ignoreCase: null, mode: null, path: null, pattern: "TODO" }, "~"))
      .toMatchObject({ args: { context: 0, cwd: "~", ignoreCase: false, mode: "files", pattern: "TODO" }, op: "grep", timeoutMs: 60_000 });
    expect(prepareComputerCall("computer_job_stop", { jobId: "job-abc123" }, "~")).toEqual({ args: { jobId: "job-abc123" }, op: "job_stop",
      timeoutMs: 60_000 });
  });

  it("names a missing or invalid argument instead of sending anything", () => {
    expect(prepareComputerCall("computer_read", { limit: null, offset: null }, "~")).toBe("path");
    expect(prepareComputerCall("computer_read", { limit: 5000, offset: null, path: "a.txt" }, "~")).toBe("limit");
    expect(prepareComputerCall("computer_shell", { background: null, command: "", timeoutSeconds: null }, "~")).toBe("command");
    expect(prepareComputerCall("computer_shell", { background: null, command: "x\u0000y", timeoutSeconds: null }, "~")).toBe("command");
    expect(prepareComputerCall("computer_job_output", { jobId: "not a job", waitSeconds: null }, "~")).toBe("jobId");
  });

  it("never waits past the turn's tool time: a command and a wait shorten to fit", () => {
    const shell = prepareComputerCall("computer_shell", { background: false, command: "build", timeoutSeconds: 600 }, "~", 75_000);
    expect(shell).toMatchObject({ args: { timeoutSeconds: 60 }, timeoutMs: 75_000 });
    const wait = prepareComputerCall("computer_job_output", { jobId: "job-abc123", waitSeconds: 30 }, "~", 12_000);
    expect(wait).toMatchObject({ args: { waitSeconds: 7 }, timeoutMs: 12_000 });
    expect(prepareComputerCall("computer_read", { limit: null, offset: null, path: "a" }, "~", -5)).toMatchObject({
      timeoutMs: COMPUTER_TOOL_LIMITS.minCallMs });
  });

  it("sends no command the turn's tool time would stop at once", () => {
    const command = { background: false, command: "build", timeoutSeconds: 600 };
    const floorMs = COMPUTER_TOOL_LIMITS.shellReplyMs + COMPUTER_TOOL_LIMITS.minShellSeconds * 1_000;
    expect(prepareComputerCall("computer_shell", command, "~", floorMs)).toMatchObject({
      args: { timeoutSeconds: COMPUTER_TOOL_LIMITS.minShellSeconds }, timeoutMs: floorMs });
    expect(prepareComputerCall("computer_shell", command, "~", floorMs - 1)).toBe(COMPUTER_NO_TOOL_TIME);
    expect(prepareComputerCall("computer_shell", command, "~", 0)).toBe(COMPUTER_NO_TOOL_TIME);
    // A short command that fits as asked runs as asked.
    expect(prepareComputerCall("computer_shell", { ...command, timeoutSeconds: 2 }, "~", floorMs - 1)).toMatchObject({
      args: { timeoutSeconds: 2 } });
  });
});

describe("a computer call", () => {
  const context = (ops = createFakeComputerOps(), timeLeftMs?: () => number) =>
    ({ binding, ops, runId: RUN, ...(timeLeftMs ? { timeLeftMs } : {}), userId: USER });

  it("sends the run, the frozen device and folder, a bounded timeout and the call's signal, and shows a command's result", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ ok: true, result: { durationMs: 1_234, exitCode: 2, stderr: "warn\n", stderrBytes: 5, stdout: "Привет\n",
      stdoutBytes: 13, truncated: false } }, "shell");
    const result = await executeComputerTool(context(ops, () => 30_000), call("computer_shell",
      { background: null, command: "Get-ChildItem", timeoutSeconds: null }), signal());
    expect(ops.calls).toEqual([expect.objectContaining({ aborted: false, args: { background: false, command: "Get-ChildItem",
      cwd: binding.cwd, timeoutSeconds: 15 }, deviceId: DEVICE, op: "shell", runId: RUN, timeoutMs: 30_000, userId: USER })]);
    expect(result).toMatchObject({ rawPreview: { computer: { exitCode: 2 } }, status: "complete" });
    expect(result.content[0]).toEqual({ text: "Exit code: 2 (1.2 s)\nstdout:\nПривет\nstderr:\nwarn", type: "text" });
  });

  it("numbers a file's lines and says where to read on", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ ok: true, result: { content: "first\r\nsecond\r\n", encoding: "windows-1251", lineEnding: "crlf", startLine: 3,
      totalLines: 10, truncated: true } }, "read");
    const result = await executeComputerTool(context(ops), call("computer_read", { limit: 2, offset: 3, path: "notes.txt" }), signal());
    expect(result.content[0]).toEqual({ type: "text", text: "notes.txt: lines 3-4 of 10 (windows-1251, crlf line endings)\n" +
      "     3\tfirst\n     4\tsecond\nLines 5-10 are not shown: read on with offset 5." });
  });

  it("answers a failure nothing was sent for, or one the device decided, as an ordinary error", async () => {
    const ops = createFakeComputerOps();
    const offline = await executeComputerTool(context(ops), call("computer_shell", { background: null, command: "ls", timeoutSeconds: null }),
      signal());
    expect(offline).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "connect_device_offline" } }] });
    ops.enqueue({ code: "computer_edit_no_match", ok: false, sent: true }, "edit");
    const edit = await executeComputerTool(context(ops), call("computer_edit",
      { newString: "b", oldString: "a", path: "x.txt", replaceAll: null }), signal());
    expect(edit).toMatchObject({ status: "error", content: [{ value: { error: "computer_edit_no_match" } }] });
    const invalid = await executeComputerTool(context(ops), call("computer_write", { path: "x.txt" }), signal());
    expect(invalid).toMatchObject({ status: "error", content: [{ value: { error: "tool_arguments_invalid" } }] });
    expect(ops.calls).toHaveLength(2);
    // The device refused text the file's encoding cannot hold: nothing was written, so the outcome is known.
    ops.enqueue({ code: "computer_text_unencodable" as never, ok: false, sent: true }, "write");
    const unencodable = await executeComputerTool(context(ops), call("computer_write", { content: "€", path: "legacy.txt" }), signal());
    expect(unencodable).toMatchObject({ status: "error", content: [{ value: { error: "computer_text_unencodable",
      message: expect.stringContaining("cannot be written in this file's encoding") } }] });
  });

  it("refuses a command with too little tool time left before sending it, as an ordinary error", async () => {
    const ops = createFakeComputerOps();
    const result = await executeComputerTool(context(ops, () => 12_000), call("computer_shell",
      { background: null, command: "npm test", timeoutSeconds: null }), signal());
    expect(result).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "tool_time_exhausted",
      message: expect.stringContaining("nothing was sent") } }] });
    expect(ops.calls).toEqual([]);
  });

  it("leaves a call with effects that may have run to the batch as an unknown outcome, and a read to its retries", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ code: "connect_device_disconnected", ok: false, sent: true }, "shell");
    const shell = executeComputerTool(context(ops), call("computer_shell", { background: null, command: "rm -r out", timeoutSeconds: null }),
      signal());
    await expect(shell).rejects.toMatchObject({ code: "connect_device_disconnected", timedOut: false, transient: false });
    ops.enqueue({ code: "connect_device_disconnected", ok: false, sent: true }, "read");
    const read = executeComputerTool(context(ops), call("computer_read", { limit: null, offset: null, path: "a" }), signal());
    await expect(read).rejects.toBeInstanceOf(ComputerOpError);
    await expect(read).rejects.toMatchObject({ transient: true });
    // A read that reached its time limit is reported, not tried again.
    ops.enqueue({ code: "computer_timeout", ok: false, sent: true }, "grep");
    await expect(executeComputerTool(context(ops), call("computer_grep", { context: null, glob: null, ignoreCase: null, mode: null,
      path: null, pattern: "x" }), signal())).resolves.toMatchObject({ status: "error", content: [{ value: { error: "computer_timeout" } }] });
  });

  it("maps the engine's own deadline to computer_timeout and a command's to an unknown outcome that timed out", async () => {
    vi.useFakeTimers();
    const ops = createFakeComputerOps();
    ops.enqueue(() => new Promise(() => undefined), "shell");
    const pending = executeComputerTool(context(ops, () => 21_000), call("computer_shell",
      { background: null, command: "sleep 100", timeoutSeconds: null }), signal());
    const settled = expect(pending).rejects.toMatchObject({ code: "computer_timeout", timedOut: true });
    await vi.advanceTimersByTimeAsync(21_000 + COMPUTER_TOOL_LIMITS.graceMs);
    await settled;
    expect(ops.calls[0]).toMatchObject({ aborted: true, args: { timeoutSeconds: 6 }, timeoutMs: 21_000 });
  });

  it("ends with the run's own abort when Stop or the turn's deadline stops it", async () => {
    const ops = createFakeComputerOps();
    let seen: ComputerOpCall | null = null;
    ops.enqueue((sent) => {
      seen = sent;
      return new Promise(() => undefined);
    }, "shell");
    const stop = new AbortController();
    const pending = executeComputerTool(context(ops), call("computer_shell", { background: null, command: "sleep 100", timeoutSeconds: null }),
      stop.signal);
    await vi.waitFor(() => expect(seen).not.toBeNull());
    stop.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
    expect(ops.calls[0]!.aborted).toBe(true);
  });
});

describe("computer steps", () => {
  it("names the command's first line, a path or a pattern, and a command's exit code once known", () => {
    expect(computerActivityFacts("computer_shell", { command: "  \n npm test -- --watch=false\nsecond" })).toEqual({
      summary: "npm test -- --watch=false" });
    expect(computerActivityFacts("computer_read", { path: "C:\\Users\\ivan\\a.txt" })).toEqual({ summary: "C:\\Users\\ivan\\a.txt" });
    expect(computerActivityFacts("computer_shell", { command: "ls" }, { rawPreview: { computer: { exitCode: 0 } } }))
      .toEqual({ exitCode: 0, summary: "ls" });
    expect(computerActivityFacts("computer_shell", { command: "ls" }, { rawPreview: { computer: { exitCode: 1.5 } } }))
      .toEqual({ summary: "ls" });
    expect(computerActivityFacts("sandbox_exec", { command: "ls" })).toEqual({});
  });

  it("registers each tool as a computer step named after the computer", () => {
    const tools = computerEngineTools({ binding, runId: RUN, serverName: "DESKTOP-7Q2", userId: USER });
    expect(tools.map((tool) => [tool.definition.name, tool.effects])).toEqual(COMPUTER_TOOL_NAMES.map((name) => [name, COMPUTER_TOOL_EFFECTS[name]]));
    expect(tools[0]!.activity(call("computer_shell", { command: "dir" }))).toEqual({ origin: "computer", serverName: "DESKTOP-7Q2",
      summary: "dir", toolName: "computer_shell" });
  });
});
