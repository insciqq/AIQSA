// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { decodeResourceChangeCard } from "@/lib/contracts/resourceChanges";
import { logEvent } from "../observability";
import type { AgentSecretService, AgentSecretView } from "../workspace/secrets/agentSecrets";
import { WorkspaceSecretError } from "../workspace/secrets/validation";
import { MANAGE_SECRET_TOOL_NAME, executeManageSecret, manageSecretTool } from "./manageSecret";
import { invalidProviderToolArguments, type ToolExecutionResult } from "./types";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const SECRET_ID = "10000000-0000-4000-8000-000000000001";
const VERSION_ID = "20000000-0000-4000-8000-000000000001";
const NEXT_VERSION_ID = "20000000-0000-4000-8000-000000000002";
const TOKEN = "glpat-synthetic-value-0001";
const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_secret", name: MANAGE_SECRET_TOOL_NAME });
const gitlab: AgentSecretView = { description: "", envNames: [], id: SECRET_ID, kind: "text", name: "GitLab", versionId: VERSION_ID };

function service(overrides: Partial<AgentSecretService> = {}) {
  const fake = {
    change: vi.fn<AgentSecretService["change"]>(async (change, result) => {
      if (change.action === "create") {
        const secret: AgentSecretView = { description: change.description, envNames: change.value.kind === "env" ? change.value.entries.map((entry) => entry.name) : [],
          id: SECRET_ID, kind: change.value.kind, name: change.name, versionId: VERSION_ID };
        const done = { action: "created" as const, previous: null, secret, valueReplaced: false };
        return { kind: "changed", result: result(done), value: done };
      }
      const secret = { ...gitlab, name: change.name ?? gitlab.name, versionId: NEXT_VERSION_ID };
      const done = { action: "updated" as const, previous: gitlab, secret, valueReplaced: change.value !== null };
      return { kind: "changed", result: result(done), value: done };
    }),
    find: vi.fn<AgentSecretService["find"]>(async () => ({ kind: "found", secret: gitlab })),
    readAttachment: vi.fn<AgentSecretService["readAttachment"]>(async () => ({ kind: "missing" })),
    validateSshKey: vi.fn<AgentSecretService["validateSshKey"]>(async () => undefined),
    ...overrides
  };
  return fake;
}

const json = (result: ToolExecutionResult) => (result.content[0] as { value: Record<string, unknown> }).value;
const card = (result: ToolExecutionResult) => decodeResourceChangeCard((result.artifacts?.[0] as { data: { payload: unknown } }).data.payload);

describe("manage_secret", () => {
  it("is an account change that needs neither approval nor the VM", () => {
    expect(manageSecretTool).toMatchObject({ effects: "local", name: "manage_secret", needsApproval: false, requiresVm: false });
    expect(manageSecretTool.tool).toMatchObject({ capability: "session", name: "manage_secret" });
  });

  it("saves a pasted token through the service and answers with the name and a card, never the value", async () => {
    const fake = service();
    const result = await executeManageSecret(fake, call({ action: "create", kind: "text", name: " GitLab ", text: TOKEN }));
    expect(fake.change).toHaveBeenCalledWith({ action: "create", description: "", name: "GitLab", value: { kind: "text", text: TOKEN } }, expect.any(Function));
    expect(result.status).toBe("complete");
    expect(json(result)).toMatchObject({ action: "created", saved: true, secret: { kind: "text", name: "GitLab" }, secretId: SECRET_ID });
    expect(card(result)).toEqual({ action: "created", envNames: [], kind: "text", name: "GitLab", previousName: null, proposalId: null, resource: "secret",
      secretId: SECRET_ID, valueReplaced: false, version: 1, versionId: VERSION_ID });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("saves environment variables and refuses names the settings would refuse, naming the variable", async () => {
    const fake = service();
    const saved = await executeManageSecret(fake, call({ action: "create", kind: "env", name: "Deploy",
      variables: [{ name: "DEPLOY_TOKEN", value: TOKEN }, { name: "DEPLOY_USER", value: "bot" }] }));
    expect(card(saved)).toMatchObject({ envNames: ["DEPLOY_TOKEN", "DEPLOY_USER"], kind: "env" });
    for (const [variables, message] of [
      [[{ name: "1BAD", value: "x" }], "variables[0].name must use letters"],
      [[{ name: "SSH_AUTH_SOCK", value: "x" }], "not be SSH_AUTH_SOCK"],
      [[{ name: "A", value: "x" }, { name: "A", value: "y" }], "\"A\" repeats"],
      [[], "variables must be a non-empty list"]
    ] as const) {
      const result = await executeManageSecret(fake, call({ action: "create", kind: "env", name: "Deploy", variables }));
      expect(result.status).toBe("error");
      expect(json(result)).toMatchObject({ code: "secret_arguments_invalid" });
      expect(String(json(result).message)).toContain(message);
    }
    expect(fake.change).toHaveBeenCalledTimes(1);
  });

  it("validates an SSH key before anything is written", async () => {
    const fake = service({ validateSshKey: vi.fn(async () => { throw new WorkspaceSecretError("workspace_secret_ssh_invalid"); }) });
    const result = await executeManageSecret(fake, call({ action: "create", kind: "ssh_key", name: "Deploy key", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n" }));
    expect(fake.validateSshKey).toHaveBeenCalledWith("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n", "");
    expect(fake.change).not.toHaveBeenCalled();
    expect(json(result)).toMatchObject({ code: "workspace_secret_ssh_invalid", saved: false });
    expect(String(json(result).message)).toContain("valid private SSH key");
  });

  it("takes a value from a conversation file: bytes for a file secret, UTF-8 text for a token", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const fake = service({ readAttachment: vi.fn(async () => ({ bytes, fileName: "key.bin", kind: "file" as const, mimeType: "application/octet-stream" })) });
    await executeManageSecret(fake, call({ action: "create", attachmentId: "att_1", kind: "file", name: "Key file" }));
    expect(fake.readAttachment).toHaveBeenCalledWith("att_1", 512 * 1_024);
    expect(vi.mocked(fake.change).mock.calls[0]![0]).toMatchObject({ value: { base64: bytes.toString("base64"), kind: "file", originalName: "key.bin" } });
    const notText = await executeManageSecret(fake, call({ action: "create", attachmentId: "att_1", kind: "text", name: "Token" }));
    expect(json(notText)).toMatchObject({ code: "secret_attachment_not_text" });
    const missing = await executeManageSecret(service(), call({ action: "create", attachmentId: "att_2", kind: "text", name: "Token" }));
    expect(json(missing)).toMatchObject({ code: "secret_attachment_unavailable" });
    const both = await executeManageSecret(service(), call({ action: "create", attachmentId: "att_2", kind: "text", name: "Token", text: "x" }));
    expect(String(json(both).message)).toContain("Pass either text or attachmentId");
  });

  it("renames or replaces a value of the secret named, and says earlier values are not kept", async () => {
    const fake = service();
    const renamed = await executeManageSecret(fake, call({ action: "update", name: "GitLab", newName: "GitLab work" }));
    expect(vi.mocked(fake.change).mock.calls[0]![0]).toEqual({ action: "update", description: null, name: "GitLab work", selector: { name: "GitLab" }, value: null });
    expect(json(renamed)).toMatchObject({ action: "updated", renamedFrom: "GitLab" });
    expect(card(renamed)).toMatchObject({ action: "updated", name: "GitLab work", previousName: "GitLab", valueReplaced: false, versionId: NEXT_VERSION_ID });
    const replaced = await executeManageSecret(fake, call({ action: "update", kind: "text", secretId: SECRET_ID, text: TOKEN }));
    expect(vi.mocked(fake.change).mock.calls[1]![0]).toMatchObject({ selector: { secretId: SECRET_ID }, value: { kind: "text", text: TOKEN } });
    expect(json(replaced).valueReplaced).toContain("not kept");
    expect(JSON.stringify(replaced)).not.toContain(TOKEN);
    const nothing = await executeManageSecret(fake, call({ action: "update", name: "GitLab" }));
    expect(String(json(nothing).message)).toContain("update needs newName, description or a new value.");
  });

  it("answers a secret of another user exactly like a missing one", async () => {
    const missing = service({ change: vi.fn(async () => ({ kind: "refused" as const, value: { available: [gitlab], code: "secret_not_found" as const } })) });
    const foreign = await executeManageSecret(missing, call({ action: "update", newName: "x", secretId: "30000000-0000-4000-8000-000000000003" }));
    const absent = await executeManageSecret(missing, call({ action: "update", newName: "x", secretId: "30000000-0000-4000-8000-000000000004" }));
    expect(foreign).toEqual(absent);
    expect(json(foreign)).toMatchObject({ code: "secret_not_found", message: "The user has no saved secret with that name or id. Saved secrets: \"GitLab\"." });
  });

  it.each([
    [{ code: "secret_name_taken", existing: gitlab }, "already has a text secret named \"GitLab\". Use action update"],
    [{ code: "secret_kind_mismatch", current: gitlab }, "only be replaced with a text value"],
    [{ code: "workspace_secret_limit" }, "The user can remove secrets they no longer need"],
    [{ code: "workspace_secret_env_conflict" }, "already used by another saved secret"]
  ] as const)("explains the refusal %j", async (value, message) => {
    const result = await executeManageSecret(service({ change: vi.fn(async () => ({ kind: "refused" as const, value })) }),
      call({ action: "create", kind: "text", name: "GitLab", text: TOKEN }));
    expect(result.status).toBe("error");
    expect(json(result)).toMatchObject({ code: value.code, saved: false });
    expect(String(json(result).message)).toContain(message);
  });

  it("proposes a deletion without deleting anything", async () => {
    const fake = service();
    const result = await executeManageSecret(fake, call({ action: "propose_delete", name: "gitlab" }));
    expect(fake.find).toHaveBeenCalledWith({ name: "gitlab" });
    expect(fake.change).not.toHaveBeenCalled();
    expect(json(result)).toMatchObject({ deleted: false, deletionProposed: true, secret: { name: "GitLab" } });
    expect(card(result)).toMatchObject({ action: "delete_proposed", secretId: SECRET_ID, versionId: VERSION_ID });
    const ambiguous = await executeManageSecret(service({ find: vi.fn(async () => ({ kind: "ambiguous" as const,
      matches: [gitlab, { ...gitlab, id: "10000000-0000-4000-8000-000000000002" }] })) }), call({ action: "propose_delete", name: "GitLab" }));
    expect(json(ambiguous)).toMatchObject({ code: "secret_ambiguous", matches: [{ secretId: SECRET_ID }, { secretId: "10000000-0000-4000-8000-000000000002" }] });
    const extra = await executeManageSecret(fake, call({ action: "propose_delete", name: "GitLab", text: "x" }));
    expect(String(json(extra).message)).toContain("propose_delete takes only name or secretId");
  });

  it("gives each deletion proposal its own card and clips a name the answer's decoder would drop", async () => {
    const astral = { ...gitlab, name: "𝔸".repeat(100) };
    const fake = service({ find: vi.fn(async () => ({ kind: "found" as const, secret: astral })) });
    const first = card(await executeManageSecret(fake, call({ action: "propose_delete", name: "x" })));
    const second = card(await executeManageSecret(fake, call({ action: "propose_delete", name: "x" })));
    expect(first).toMatchObject({ action: "delete_proposed", name: `${"𝔸".repeat(59)}…`, proposalId: expect.any(String) });
    expect(first?.proposalId).not.toBe(second?.proposalId);
  });

  it.each([
    [invalidProviderToolArguments(), "The arguments were not valid JSON."],
    [{ action: "remove" }, "action must be one of create, update, propose_delete."],
    [{ action: "create", name: "x", kind: "text", text: "y", userId: "u2" }, "Unknown argument \"userId\""],
    [{ action: "create", name: "x", kind: "browser_session", text: "{}" }, "Browser sessions are saved by the Workspace browser"],
    [{ action: "create", name: "x", text: "y" }, "kind is required with text"],
    [{ action: "create", name: "a\nb", kind: "text", text: "y" }, "name must be a single line"],
    [{ action: "create", name: "x", kind: "file", text: "y", fileName: "../x" }, "fileName must be a plain file name"],
    [{ action: "create", name: "x", kind: "text", privateKey: "y" }, "kind text does not take privateKey"]
  ])("refuses %j with what to fix", async (args, message) => {
    const fake = service();
    const result = await executeManageSecret(fake, call(args));
    expect(result.status).toBe("error");
    expect(String(json(result).message)).toContain(message);
    expect(fake.change).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure without the value and answers with a stable code", async () => {
    vi.mocked(logEvent).mockClear();
    const result = await executeManageSecret(service({ change: vi.fn(async () => { throw new Error(`database said ${TOKEN}`); }) }),
      call({ action: "create", kind: "text", name: "GitLab", text: TOKEN }));
    expect(json(result)).toMatchObject({ code: "secret_change_failed" });
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", expect.objectContaining({ code: "self_service_change_failed", stage: "write" }));
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("is unavailable without a service and returns a settled call's own result", async () => {
    expect(json(await executeManageSecret(undefined, call({ action: "create" })))).toMatchObject({ code: "secret_change_unavailable" });
    const settledResult: ToolExecutionResult = { callId: "call_secret", content: [{ text: "earlier", type: "text" }], name: MANAGE_SECRET_TOOL_NAME, status: "complete" };
    const settled = service({ change: vi.fn(async () => ({ kind: "settled" as const, result: settledResult })) });
    expect(await executeManageSecret(settled, call({ action: "create", kind: "text", name: "GitLab", text: TOKEN }))).toBe(settledResult);
  });
});
