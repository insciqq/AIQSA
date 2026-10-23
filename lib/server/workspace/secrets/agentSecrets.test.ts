// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SelfServiceCallStore } from "../../tools/selfServiceCall";
import type { ToolExecutionResult } from "../../tools/types";
import { createAgentSecretService, findAgentSecret, type AgentSecretView } from "./agentSecrets";
import { WorkspaceSecretError } from "./validation";

const USER = "user_1";
const OTHER = "user_2";
const id = (n: number) => `10000000-0000-4000-8000-00000000000${n}`;
const version = (n: number) => `20000000-0000-4000-8000-00000000000${n}`;
const scope = { callId: "call_1", chatId: "chat_1", runId: "run_1", userId: USER };
const result: ToolExecutionResult = { callId: "provider_call", content: [{ text: "saved", type: "text" }], name: "manage_secret", status: "complete" };

type Row = Readonly<{ id: string; userId: string; value: Readonly<{ id: string; name: string; description: string; kind: string; envNames: string[] }> }>;
const rows: Row[] = [
  { id: id(1), userId: USER, value: { description: "Work", envNames: [], id: version(1), kind: "text", name: "GitLab" } },
  { id: id(2), userId: USER, value: { description: "", envNames: ["DEPLOY_TOKEN"], id: version(2), kind: "env", name: "Deploy" } },
  { id: id(3), userId: OTHER, value: { description: "", envNames: [], id: version(3), kind: "text", name: "Other's token" } }
];

function setup(options: Readonly<{ claim?: Awaited<ReturnType<SelfServiceCallStore["claim"]>>; active?: boolean }> = {}) {
  const tx = {
    $queryRaw: vi.fn(async () => options.active === false ? [] : [{ id: USER }]),
    workspaceSecret: { findMany: vi.fn(async ({ where }: { where: { userId: string } }) => rows.filter((row) => row.userId === where.userId)) }
  };
  const db = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    attachment: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(async () => options.active === false ? null : { id: USER }) },
    workspaceSecret: tx.workspaceSecret
  };
  const store = { claim: vi.fn(async () => options.claim ?? { kind: "open" as const }), settle: vi.fn(async () => undefined) };
  const mutate = vi.fn(async (_tx: unknown, _userId: string, mutation: { action: string }) =>
    mutation.action === "delete" ? null : { id: mutation.action === "create" ? id(9) : id(1), versionId: version(9) });
  const service = createAgentSecretService({ db: db as never, key: () => Buffer.alloc(32), mutate: mutate as never, scope, store });
  return { db, mutate, service, store, tx };
}

const view = (row: Row): AgentSecretView => ({ description: row.value.description, envNames: row.value.envNames, id: row.id,
  kind: row.value.kind as AgentSecretView["kind"], name: row.value.name, versionId: row.value.id });

describe("finding the user's secret", () => {
  const own = rows.filter((row) => row.userId === USER).map(view);

  it("matches by id, then exact name, then a case-insensitive name only one secret has", () => {
    expect(findAgentSecret(own, { secretId: id(2) })).toEqual({ kind: "found", secret: own[1] });
    expect(findAgentSecret(own, { name: " GitLab " })).toEqual({ kind: "found", secret: own[0] });
    expect(findAgentSecret(own, { name: "gitlab" })).toEqual({ kind: "found", secret: own[0] });
    const twins = [...own, { ...own[0]!, id: id(4), name: "GITLAB" }];
    expect(findAgentSecret(twins, { name: "gitlab" })).toEqual({ kind: "ambiguous", matches: [own[0], twins[2]] });
    expect(findAgentSecret(twins, { name: "GitLab" })).toEqual({ kind: "found", secret: own[0] });
    expect(findAgentSecret(own, { name: "Jira" })).toEqual({ kind: "missing", available: own });
  });
});

describe("agent secret service", () => {
  it("creates through the settings mutation and settles the call in the same transaction", async () => {
    const fixture = setup();
    const outcome = await fixture.service.change({ action: "create", description: "", name: " Jira ", value: { kind: "text", text: "synthetic" } }, () => result);
    expect(outcome).toMatchObject({ kind: "changed", result, value: { action: "created",
      secret: { envNames: [], id: id(9), kind: "text", name: "Jira", versionId: version(9) } } });
    expect(fixture.db.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.store.claim).toHaveBeenCalledWith(fixture.tx);
    expect(fixture.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(fixture.tx.workspaceSecret.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER } }));
    expect(fixture.mutate).toHaveBeenCalledWith(fixture.tx, USER, { action: "create", description: "", name: "Jira",
      value: { kind: "text", text: "synthetic" } }, expect.any(Function));
    expect(fixture.store.settle).toHaveBeenCalledWith(fixture.tx, result);
  });

  it("refuses a name the user already has, whatever its case, and writes nothing", async () => {
    const fixture = setup();
    const outcome = await fixture.service.change({ action: "create", description: "", name: "gitlab", value: { kind: "text", text: "x" } }, () => result);
    expect(outcome).toEqual({ kind: "refused", value: { code: "secret_name_taken", existing: view(rows[0]!) } });
    expect(fixture.mutate).not.toHaveBeenCalled();
    expect(fixture.store.settle).not.toHaveBeenCalled();
  });

  it("updates the user's own secret under the revision it read, preserving or replacing the value", async () => {
    const fixture = setup();
    const renamed = await fixture.service.change({ action: "update", description: null, name: "GitLab work", selector: { name: "gitlab" }, value: null }, () => result);
    expect(fixture.mutate).toHaveBeenLastCalledWith(fixture.tx, USER, { action: "update", description: "Work", expectedVersionId: version(1),
      id: id(1), name: "GitLab work", value: { action: "preserve" } }, expect.any(Function));
    expect(renamed).toMatchObject({ kind: "changed", value: { previous: view(rows[0]!), secret: { name: "GitLab work", versionId: version(9) }, valueReplaced: false } });
    await fixture.service.change({ action: "update", description: null, name: null, selector: { secretId: id(2) },
      value: { entries: [{ name: "DEPLOY_TOKEN", value: "new" }], kind: "env" } }, () => result);
    expect(fixture.mutate).toHaveBeenLastCalledWith(fixture.tx, USER, expect.objectContaining({ expectedVersionId: version(2), id: id(2),
      value: { action: "replace", content: { entries: [{ name: "DEPLOY_TOKEN", value: "new" }], kind: "env" } } }), expect.any(Function));
  });

  it("treats another user's secret id like a missing one", async () => {
    const fixture = setup();
    const foreign = await fixture.service.change({ action: "update", description: null, name: "Mine now", selector: { secretId: id(3) }, value: null }, () => result);
    const absent = await fixture.service.change({ action: "update", description: null, name: "Mine now", selector: { secretId: id(8) }, value: null }, () => result);
    expect(foreign).toEqual(absent);
    expect(foreign).toMatchObject({ kind: "refused", value: { code: "secret_not_found" } });
    expect(JSON.stringify(foreign)).not.toContain("Other's token");
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "update" as const, description: null, name: null, selector: { name: "GitLab" }, value: { entries: [{ name: "A", value: "b" }], kind: "env" as const } }, "secret_kind_mismatch"],
    [{ action: "update" as const, description: "Work", name: "GitLab", selector: { name: "GitLab" }, value: null }, "secret_unchanged"],
    [{ action: "update" as const, description: null, name: "deploy", selector: { name: "GitLab" }, value: null }, "secret_name_taken"]
  ])("refuses %j without writing", async (change, code) => {
    const fixture = setup();
    expect(await fixture.service.change(change, () => result)).toMatchObject({ kind: "refused", value: { code } });
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("turns a settings refusal inside the transaction into the same refusal, with the call unsettled", async () => {
    const fixture = setup();
    fixture.mutate.mockRejectedValueOnce(new WorkspaceSecretError("workspace_secret_limit"));
    const outcome = await fixture.service.change({ action: "create", description: "", name: "Jira", value: { kind: "text", text: "x" } }, () => result);
    expect(outcome).toEqual({ kind: "refused", value: { code: "workspace_secret_limit" } });
    expect(fixture.store.settle).not.toHaveBeenCalled();
    const invalid = await fixture.service.change({ action: "create", description: "", name: "x".repeat(121), value: { kind: "text", text: "x" } }, () => result);
    expect(invalid).toEqual({ kind: "refused", value: { code: "workspace_secret_invalid" } });
  });

  it("returns a settled call's result without changing anything, and refuses an inactive user", async () => {
    const settled = setup({ claim: { kind: "settled", result } });
    expect(await settled.service.change({ action: "create", description: "", name: "Jira", value: { kind: "text", text: "x" } }, () => result))
      .toEqual({ kind: "settled", result });
    expect(settled.mutate).not.toHaveBeenCalled();
    const inactive = setup({ active: false });
    expect(await inactive.service.change({ action: "create", description: "", name: "Jira", value: { kind: "text", text: "x" } }, () => result))
      .toEqual({ kind: "refused", value: { code: "workspace_secret_unavailable" } });
    expect(await inactive.service.find({ name: "GitLab" })).toBeNull();
  });

  it("reads only an admitted or produced file of this chat, whole and with its checksum", async () => {
    const bytes = Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const row = { byteSize: bytes.length, checksum, fileName: "id_ed25519", mimeType: "text/plain", storageKey: "objects/1" };
    const storage = { getObject: vi.fn(async () => ({ body: bytes, contentType: "text/plain", storageKey: "objects/1" })) };
    const fixture = setup();
    fixture.db.attachment.findFirst.mockResolvedValue(row);
    const service = createAgentSecretService({ attachmentIds: ["att_1"], db: fixture.db as never, scope, storage, store: fixture.store });
    expect(await service.readAttachment("att_1", 1_024)).toEqual({ bytes, fileName: "id_ed25519", kind: "file", mimeType: "text/plain" });
    expect(fixture.db.attachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { chatId: "chat_1", id: "att_1", projectId: null,
      userId: USER, OR: [{ id: { in: ["att_1"] } }, { producerModelRunId: "run_1" }] } }));
    expect(storage.getObject).toHaveBeenCalledWith("objects/1", { maxBytes: bytes.length });
    expect(await service.readAttachment("att_1", 4)).toEqual({ byteSize: bytes.length, kind: "too_large" });
    fixture.db.attachment.findFirst.mockResolvedValue({ ...row, checksum: "0".repeat(64) });
    expect(await service.readAttachment("att_1", 1_024)).toEqual({ kind: "missing" });
    fixture.db.attachment.findFirst.mockResolvedValue(null);
    expect(await service.readAttachment("att_other", 1_024)).toEqual({ kind: "missing" });
    expect(await createAgentSecretService({ db: fixture.db as never, scope, store: fixture.store }).readAttachment("att_1", 1_024))
      .toEqual({ kind: "missing" });
  });
});
