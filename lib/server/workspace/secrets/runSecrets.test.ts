// @vitest-environment node
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptSecretEnvelope } from "../../secrets/envelope";
import { createRunSecretSource } from "./runSecrets";

const KEY = randomBytes(32);
const USER = "user_1";
const VALUE_ID = "20000000-0000-4000-8000-000000000001";
const SECRET_ID = "10000000-0000-4000-8000-000000000001";

const row = {
  byteSize: 10, checksum: null, createdAt: new Date(0), description: "Work", envNames: ["GITLAB_TOKEN"], id: VALUE_ID, kind: "env",
  name: "GitLab", originalName: null, payloadEnvelope: encryptSecretEnvelope({ entries: [{ name: "GITLAB_TOKEN", value: "glpat-synthetic" }], kind: "env" },
    KEY, { ownerId: USER, purpose: "workspace-user-secret", valueId: VALUE_ID }), secretId: SECRET_ID, sshProtected: false, userId: USER
};
const entryValue = { description: "Work", envNames: ["GITLAB_TOKEN"], id: VALUE_ID, kind: "env", name: "GitLab" };

function prisma(input: { active?: boolean; bound?: boolean; chatUserId?: string; projectId?: string | null; run?: boolean } = {}) {
  return {
    modelRun: { findFirst: vi.fn(async () => input.run === false ? null : {
      chat: { projectId: input.projectId ?? null, userId: input.chatUserId ?? USER },
      workspaceRunBinding: input.bound ? { modelRunId: "run_1" } : null
    }) },
    user: { findFirst: vi.fn(async () => input.active === false ? null : { id: USER }) },
    workspaceRunSecret: { findMany: vi.fn(async () => [{ value: entryValue }]) },
    workspaceSecret: { findMany: vi.fn(async () => [{ value: entryValue }]) },
    workspaceSecretValue: { findUnique: vi.fn(async () => row) }
  };
}

const scope = { runId: "run_1", userId: USER };

describe("run secret source", () => {
  it("lists the run's bound revisions when admission bound them, and decrypts only the value read", async () => {
    const db = prisma({ bound: true });
    const source = createRunSecretSource(db as never, () => KEY);
    await expect(source.list(scope)).resolves.toEqual([{ description: "Work", envNames: ["GITLAB_TOKEN"], kind: "env", name: "GitLab", valueId: VALUE_ID }]);
    expect(db.workspaceRunSecret.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { modelRunId: "run_1" } }));
    expect(db.workspaceSecret.findMany).not.toHaveBeenCalled();
    expect(db.workspaceSecretValue.findUnique).not.toHaveBeenCalled();
    await expect(source.read({ ...scope, valueId: VALUE_ID })).resolves.toMatchObject({
      id: SECRET_ID, name: "GitLab", value: { entries: [{ name: "GITLAB_TOKEN", value: "glpat-synthetic" }], kind: "env" }
    });
  });

  it("reads the owner's current revisions in a run without a Workspace binding", async () => {
    const db = prisma({ bound: false });
    await createRunSecretSource(db as never, () => KEY).list(scope);
    expect(db.workspaceSecret.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER } }));
    expect(db.workspaceRunSecret.findMany).not.toHaveBeenCalled();
    expect(db.modelRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "run_1", userId: USER } }));
  });

  it("gives Project runs no personal secrets", async () => {
    await expect(createRunSecretSource(prisma({ projectId: "project_1" }) as never, () => KEY).list(scope)).resolves.toEqual([]);
  });

  it.each([
    [{ active: false }],
    [{ run: false }],
    [{ chatUserId: "user_2" }]
  ])("refuses another owner's or an inactive user's run (%j)", async (input) => {
    await expect(createRunSecretSource(prisma(input) as never, () => KEY).list(scope)).rejects.toMatchObject({ code: "workspace_secret_unavailable" });
  });

  it("refuses to read a value outside the run's readable set", async () => {
    const db = prisma({ bound: true });
    await expect(createRunSecretSource(db as never, () => KEY).read({ ...scope, valueId: "20000000-0000-4000-8000-000000000009" }))
      .rejects.toMatchObject({ code: "workspace_secret_unavailable" });
    expect(db.workspaceSecretValue.findUnique).not.toHaveBeenCalled();
  });
});
