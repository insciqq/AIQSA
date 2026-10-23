// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSecretValue } from "@/lib/contracts/workspaceSecrets";
import type { RunSecretEntry, RunSecretSource } from "../workspace/secrets/runSecrets";
import type { AcceptedWorkspaceSecret } from "../workspace/secrets/store";
import { WorkspaceSecretError } from "../workspace/secrets/validation";
import { READ_SECRET_TOOL_NAME, executeReadSecret, readSecretTool } from "./readSecret";
import type { ToolExecutionResult } from "./types";

const ids = (index: number) => `10000000-0000-4000-8000-00000000000${index}`;

function secret(index: number, name: string, value: WorkspaceSecretValue, description = ""): AcceptedWorkspaceSecret {
  return { description, id: ids(index), name, value, versionId: `20000000-0000-4000-8000-00000000000${index}` };
}

const SECRETS = [
  secret(1, "GitLab", { entries: [{ name: "GITLAB_TOKEN", value: "glpat-synthetic" }, { name: "GITLAB_URL", value: "https://git.example" }], kind: "env" }, "Work GitLab"),
  secret(2, "Notes", { kind: "text", text: "synthetic text secret" }),
  secret(3, "Deploy key", { kind: "ssh_key", passphrase: "", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----\n" }),
  secret(4, "Config", { base64: Buffer.from("token = synthetic\n").toString("base64"), kind: "file", originalName: "config.ini" }),
  secret(5, "Shop", { base64: Buffer.from("{\"cookies\":[]}").toString("base64"), kind: "browser_session", originalName: "shop.example.json" }),
  secret(6, "Binary", { base64: Buffer.from([0, 255, 1]).toString("base64"), kind: "file", originalName: "blob.bin" }),
  secret(7, "API_KEY", { entries: [{ name: "API_KEY", value: "synthetic-api-key" }], kind: "env" })
];

function entry(value: AcceptedWorkspaceSecret): RunSecretEntry {
  return { description: value.description, envNames: value.value.kind === "env" ? value.value.entries.map((item) => item.name) : [],
    kind: value.value.kind, name: value.name, valueId: value.versionId };
}

function source(secrets: readonly AcceptedWorkspaceSecret[] = SECRETS): RunSecretSource & { read: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => secrets.map(entry)),
    read: vi.fn(async ({ valueId }: { valueId: string }) => secrets.find((item) => item.versionId === valueId)!)
  };
}

const context = { runId: "run_1", userId: "user_1" };
const call = (name: unknown) => ({ arguments: { name }, id: "call_secret", name: READ_SECRET_TOOL_NAME });
const value = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;

describe("read_secret", () => {
  it("declares no effects and needs neither approval nor the VM", () => {
    expect(readSecretTool).toMatchObject({ effects: "none", name: "read_secret", needsApproval: false, requiresVm: false });
  });

  it.each([
    ["GitLab", { description: "Work GitLab", kind: "env", name: "GitLab", values: { GITLAB_TOKEN: "glpat-synthetic", GITLAB_URL: "https://git.example" } }],
    ["GITLAB_TOKEN", { kind: "env", name: "GitLab", value: "glpat-synthetic", variable: "GITLAB_TOKEN" }],
    ["gitlab_url", { kind: "env", name: "GitLab", value: "https://git.example", variable: "GITLAB_URL" }],
    ["notes", { kind: "text", name: "Notes", value: "synthetic text secret" }],
    ["Deploy key", { kind: "ssh_key", name: "Deploy key", privateKey: expect.stringContaining("synthetic"), workspacePath: `/workspace/secrets/ssh/${ids(3)}` }],
    ["Config", { encoding: "utf8", kind: "file", name: "Config", originalName: "config.ini", value: "token = synthetic\n", workspacePath: `/workspace/secrets/files/${ids(4)}` }],
    ["Binary", { encoding: "base64", kind: "file", name: "Binary", value: "AP8B" }],
    ["Shop", { host: "shop.example.json", kind: "browser_session", name: "Shop", workspacePath: "/workspace/secrets/browser/shop.example.json" }],
    ["API_KEY", { kind: "env", name: "API_KEY", value: "synthetic-api-key", variable: "API_KEY" }]
  ])("reads %s", async (name, expected) => {
    const secrets = source();
    const result = await executeReadSecret(secrets, call(name), context);
    expect(result.status).toBe("complete");
    expect(value(result)).toMatchObject(expected);
    expect(secrets.read).toHaveBeenCalledOnce();
  });

  it("never returns browser cookies", async () => {
    const result = await executeReadSecret(source(), call("Shop"), context);
    expect(JSON.stringify(result)).not.toContain("cookies\":[");
  });

  it("refuses an unknown name with the available names, decrypting nothing", async () => {
    const secrets = source();
    const result = await executeReadSecret(secrets, call("Jira"), context);
    expect(result.status).toBe("error");
    expect(value(result)).toMatchObject({ available: ["GitLab", "Notes", "Deploy key", "Config", "Shop", "Binary", "API_KEY"], code: "read_secret_unknown" });
    expect(value(result).message).toContain("No saved secret or environment variable is named \"Jira\". Available: \"GitLab\" (env: GITLAB_TOKEN, GITLAB_URL); \"Notes\" (text)");
    expect(secrets.read).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous name and explains an empty set", async () => {
    const twins = source([secret(1, "Token", { kind: "text", text: "a" }), secret(2, "token", { kind: "text", text: "b" })]);
    expect(value(await executeReadSecret(twins, call("TOKEN"), context))).toMatchObject({ code: "read_secret_ambiguous" });
    expect(value(await executeReadSecret(source([]), call("x"), context))).toMatchObject({ available: [], code: "read_secret_unknown" });
  });

  it("refuses bad input and a run without identity", async () => {
    expect(value(await executeReadSecret(source(), call(""), context))).toMatchObject({ code: "read_secret_invalid" });
    expect(value(await executeReadSecret(source(), call("x".repeat(257)), context))).toMatchObject({ code: "read_secret_invalid" });
    expect(value(await executeReadSecret(source(), call("Notes"), { userId: "user_1" }))).toMatchObject({ code: "read_secret_unavailable" });
  });

  it("turns a store failure into a content-free refusal and propagates cancellation", async () => {
    const failing = { ...source(), list: vi.fn(async () => { throw new WorkspaceSecretError("workspace_secret_unavailable"); }) };
    const result = await executeReadSecret(failing, call("Notes"), context);
    expect(value(result)).toEqual({ code: "read_secret_unavailable", message: "Saved secrets could not be read right now. Try again once; if it fails again, tell the user." });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(executeReadSecret(source(), call("Notes"), context, { signal: controller.signal })).rejects.toThrow("stopped");
  });
});
