// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fail, ok } from "microsandbox-mcp/dist/utils/response.js";
import { formatExecOutput } from "microsandbox-mcp/dist/utils/exec-output.js";
import { limitText } from "microsandbox-mcp/dist/utils/output.js";
import type { AcceptedWorkspaceSecret } from "./secrets/store";
import { workspaceSecretMatches } from "./activityText";
import { WorkspaceSecretOutputMask } from "./secretOutput";
import type { WorkspaceToolResult } from "./runtime";

const TOKEN = "tok-Synthetic-0123456789";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nc3ludGhldGljLWtleS1ib2R5\"quoted\"\n-----END OPENSSH PRIVATE KEY-----\n";

function secret(name: string, value: AcceptedWorkspaceSecret["value"]): AcceptedWorkspaceSecret {
  return { id: name, versionId: `${name}-revision`, name, description: "", value };
}

const mask = new WorkspaceSecretOutputMask(workspaceSecretMatches([
  secret("Env bundle", { kind: "env", entries: [{ name: "MY_TOKEN", value: TOKEN }, { name: "SHORT", value: "1234567" }] }),
  secret("Deploy key", { kind: "ssh_key", privateKey: KEY, passphrase: "pass-phrase-value" }),
  secret("Notes", { kind: "text", text: "text-secret-value" }),
  secret("Config", { kind: "file", originalName: "config.ini", base64: Buffer.from("file-secret-value").toString("base64") }),
  secret("Browser", { kind: "browser_session", originalName: "state.json",
    base64: Buffer.from(JSON.stringify({ cookies: [{ value: "cookie-secret-value" }], origins: [] })).toString("base64") })
]));

function shell(stdout: string, stderr = "", maxBytes = 128 * 1_024): WorkspaceToolResult {
  const exec = formatExecOutput({ code: 0, stderr: () => stderr, stdout: () => stdout, success: true } as never, maxBytes);
  return { content: ok(exec.data, { truncated: exec.truncated }).content, exitCode: 0, status: "complete" };
}

function text(result: WorkspaceToolResult): string {
  return result.content.map((entry) => entry.text ?? JSON.stringify(entry.value)).join("");
}

function envelope(result: WorkspaceToolResult) {
  return JSON.parse(result.content[0]!.text!) as { data: Record<string, unknown> };
}

describe("Workspace secret output masking", () => {
  it.each([
    [TOKEN, "[secret:MY_TOKEN]"],
    [KEY, "[secret:Deploy_key]"],
    ["pass-phrase-value", "[secret:Deploy_key]"],
    ["text-secret-value", "[secret:Notes]"],
    ["file-secret-value", "[secret:Config]"],
    ["cookie-secret-value", "[secret:Browser]"]
  ])("replaces an exact delivered value of every kind (%#)", (value, placeholder) => {
    const output = mask.result(shell(`before ${value} after\n`, `err ${value}`), 128 * 1_024);
    expect(output.masked).toBe(true);
    expect(text(output.result)).not.toContain(value.trim().slice(0, 12));
    expect(envelope(output.result).data).toMatchObject({ stdout: `before ${placeholder} after\n`, stderr: `err ${placeholder}` });
  });

  it("keeps the official envelope layout and leaves unrelated output and short values untouched", () => {
    const original = shell("ordinary 1234567 output\n");
    const output = mask.result(original, 128 * 1_024);
    expect(output).toEqual({ masked: false, result: original });
    const masked = mask.result(shell(`${TOKEN}\n`), 128 * 1_024).result.content[0]!.text!;
    expect(masked).toBe(shell("[secret:MY_TOKEN]\n").content[0]!.text);
  });

  it("returns the same result without any delivered values", () => {
    const original = shell(`${TOKEN}\n`);
    expect(new WorkspaceSecretOutputMask([]).result(original, 1_024)).toEqual({ masked: false, result: original });
  });

  it.each(Array.from({ length: TOKEN.length - 1 }, (_, index) => index + 1))(
    "masks a value split at character %i across poll events and polls", (split) => {
      const poll = (events: string[]) => ({
        content: ok({ events: events.map((data, index) => ({ index, event: { kind: "stdout", data } })), done: false }).content,
        status: "complete" as const
      });
      for (const chunks of [[[`a ${TOKEN.slice(0, split)}`, `${TOKEN.slice(split)} b`]], [[`a ${TOKEN.slice(0, split)}`], [`${TOKEN.slice(split)} b`]]]) {
        const joined = chunks.map((events) => text(mask.result(poll(events), 128 * 1_024).result)).join("");
        // Fragments under four characters carry negligible information and stay.
        for (const part of [TOKEN.slice(0, split), TOKEN.slice(split)]) {
          if (part.length >= 4) expect(joined).not.toContain(part);
        }
        expect(joined).toContain("[secret:MY_TOKEN]");
      }
    });

  it("masks a value cut by the guest output bound and by the result byte bound", () => {
    const cut = mask.result(shell(`${"x".repeat(20)}${TOKEN}`, "", 30), 128 * 1_024);
    expect(envelope(cut.result).data.stdout).toBe(`${"x".repeat(20)}[secret:MY_TOKEN]`);
    expect(cut.masked).toBe(true);
    const full = shell(`${"x".repeat(20)}${KEY}`).content[0]!.text!;
    const bytes = full.indexOf("BEGIN OPENSSH") + 20;
    const output = mask.result({ content: [{ text: full.slice(0, bytes), type: "text" }], status: "complete", truncated: true }, 128 * 1_024);
    expect(text(output.result)).not.toContain("BEGIN OPENSSH");
    expect(text(output.result)).toMatch(/\[secret:Deploy_key\]$/u);
    expect(output.result.truncated).toBe(true);
  });

  it("masks escaped multi-line values and both sides of a head+tail omission", () => {
    const escaped = JSON.stringify({ ok: true, data: { stdout: `${KEY}tail`, stderr: `a${TOKEN}` } }).slice(0, -5);
    const unparsed = mask.result({ content: [{ text: escaped, type: "text" }], status: "complete", truncated: true }, 128 * 1_024);
    expect(text(unparsed.result)).not.toContain("c3ludGhldGljLWtleS1ib2R5");
    expect(text(unparsed.result)).not.toContain(TOKEN.slice(0, 8));
    const omitted = JSON.stringify({ ok: false, error: { code: "workspace_command_failed", message: "failed" },
      data: { exitCode: 1, stdout: "", stderr: `head ${TOKEN.slice(0, 10)}\n… [1000 bytes omitted] …\n${TOKEN.slice(15)} tail`, truncated: true } });
    const failed = mask.result({ content: [{ text: omitted, type: "text" }], status: "error" }, 128 * 1_024);
    expect(envelope(failed.result).data.stderr).toBe("head [secret:MY_TOKEN]\n… [1000 bytes omitted] …\n[secret:MY_TOKEN] tail");
  });

  it("does not mask JSON keys, short or punctuation-only fragments at boundaries", () => {
    const output = mask.result(shell(`ok ${TOKEN.slice(0, 3)}`, `-----\n`), 128 * 1_024);
    expect(output.masked).toBe(false);
    const failure = mask.result({ content: fail("exec_failed", "boom", { details: { stdout: `${TOKEN}` } }).content, status: "error" }, 1_024);
    expect(text(failure.result)).toContain("\"details\"");
    expect(text(failure.result)).not.toContain(TOKEN);
  });

  it("never grows a text entry beyond the output bound", () => {
    const growing = new WorkspaceSecretOutputMask([{ name: "A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME", value: "short-v1" }]);
    const original = shell("short-v1 ".repeat(200));
    const bound = Buffer.byteLength(original.content[0]!.text!);
    const output = growing.result(original, bound);
    expect(Buffer.byteLength(text(output.result))).toBeLessThanOrEqual(bound);
    expect(text(output.result)).not.toContain("short-v1");
    expect(output.result.truncated).toBe(true);
  });

  it("masks structured JSON content and read file contents", () => {
    const read = { content: ok({ path: "/workspace/secrets/.environment.json", encoding: "utf8",
      content: JSON.stringify({ MY_TOKEN: TOKEN }) }).content, status: "complete" as const };
    expect(text(mask.result(read, 128 * 1_024).result)).not.toContain(TOKEN);
    const structured = mask.result({ content: [{ type: "json", value: { nested: [{ value: TOKEN }] } }], status: "complete" }, 1_024);
    expect(structured.result.content[0]!.value).toEqual({ nested: [{ value: "[secret:MY_TOKEN]" }] });
    expect(structured.masked).toBe(true);
  });

  it("falls back to a bare placeholder when a name would reveal a value", () => {
    const named = new WorkspaceSecretOutputMask([{ name: "token-value-1", value: "token-value" }]);
    expect(envelope(named.result(shell("token-value"), 1_024).result).data.stdout).toBe("[secret]");
  });
});
