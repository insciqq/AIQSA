import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import { createArtifactService } from "./service";

const operation = { intent: "create", kind: "html", title: "Retry", entrypoint: "index.html",
  files: [{ path: "index.html", mimeType: "text/html", text: "<p>Ready</p>" }] } as const;
const deadlock = () => new Prisma.PrismaClientKnownRequestError("fixture", { code: "P2010", clientVersion: "test", meta: { code: "40P01" } });

function fixture(failures: ReadonlyMap<number, Error>, committedFailure = false) {
  type Row = Record<string, unknown> & { id: string };
  let state = { artifacts: [] as Row[], versions: [] as Row[], jobs: [] as unknown[], receipts: [] as unknown[] };
  let ids = 0;
  let attempts = 0;
  const guard = vi.fn(async () => [{ id: "run" }]);
  const tx = {
    $queryRaw: guard,
    artifact: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `artifact-${++ids}` };
        state.artifacts.push(row); return row;
      },
      findFirst: async () => state.artifacts[0] ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = state.artifacts.find(item => item.id === where.id)!;
        Object.assign(row, data); return row;
      }
    },
    artifactVersion: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        expect(state.artifacts.some(row => row.id === data.artifactId)).toBe(true);
        const row = { ...data, id: `version-${++ids}`, createdAt: new Date(), readyAt: null };
        state.versions.push(row); return row;
      },
      findFirst: async () => state.versions[0] ?? null,
      findUnique: async () => state.versions[0] ?? null,
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const row = state.versions.find(item => item.id === where.id && item.status === where.status);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }
    },
    chat: { findFirst: async () => ({ id: "chat" }) },
    artifactChatBinding: { updateMany: async () => ({ count: 0 }), upsert: async () => ({}) },
    artifactVersionBlob: { deleteMany: async () => ({ count: 0 }) },
    attachmentDeletionJob: { create: async ({ data }: { data: unknown }) => { state.jobs.push(data); }, upsert: async () => ({}) },
    modelRunToolCall: { update: async ({ data }: { data: unknown }) => { state.receipts.push(data); } }
  };
  const transaction = vi.fn(async (write: (client: typeof tx) => Promise<unknown>) => {
    const before = structuredClone(state);
    const attempt = ++attempts;
    try {
      const result = await write(tx);
      if (failures.has(attempt)) throw failures.get(attempt);
      return result;
    } catch (error) {
      if (!committedFailure) state = before;
      throw error;
    }
  });
  const objects = new Map<string, Buffer>();
  const putObject = vi.fn(async ({ storageKey, body }: { storageKey: string; body: Buffer }) => { objects.set(storageKey, body); });
  const storage = { putObject, getObject: async (key: string) => ({ body: objects.get(key)! }) } as unknown as StorageAdapter;
  const service = createArtifactService({ ...tx, $transaction: transaction } as unknown as PrismaClient, storage);
  const context = { userId: "owner", runId: "run", persistedToolCallId: "call-row", request: { chatId: "chat" } } as unknown as ToolExecutionContext;
  const execute = () => service.execute({ id: "call", name: "create_artifact", arguments: operation }, context, {
    onResult: async (client, result) => { await client.modelRunToolCall.update({ where: { id: "call-row" }, data: { result: result as unknown as Prisma.InputJsonValue } }); }
  });
  return { execute, transaction, putObject, guard, state: () => state };
}

describe("artifact creation transaction retries", () => {
  it.each([
    ["raw deadlock", deadlock()],
    ["write conflict", new Prisma.PrismaClientKnownRequestError("fixture", { code: "P2034", clientVersion: "test" })],
    ["connector deadlock", new Prisma.PrismaClientUnknownRequestError('Error querying the database: PostgresError { code: "40P01", message: "fixture" }', { clientVersion: "test" })]
  ] satisfies Array<[string, Error]>)("retries a rolled-back reservation once after %s, without reusing its artifact id", async (_label, error) => {
    const f = fixture(new Map([[1, error]]));
    expect((await f.execute()).status).toBe("complete");
    expect(f.transaction).toHaveBeenCalledTimes(3);
    expect(f.state().artifacts).toHaveLength(1);
    expect(f.state().versions).toEqual([expect.objectContaining({ artifactId: f.state().artifacts[0]!.id, status: "READY" })]);
    expect(f.state().jobs).toHaveLength(1);
    expect(f.state().receipts).toHaveLength(1);
    expect(f.putObject).toHaveBeenCalledTimes(1);
    const again = await f.execute();
    expect(again.status).toBe("complete");
    expect(f.transaction).toHaveBeenCalledTimes(3);
    expect(f.state().artifacts).toHaveLength(1);
  });

  it("retries settlement and its receipt together without repeating storage writes", async () => {
    const f = fixture(new Map([[2, deadlock()]]));
    expect((await f.execute()).status).toBe("complete");
    expect(f.transaction).toHaveBeenCalledTimes(3);
    expect(f.state().artifacts).toHaveLength(1);
    expect(f.state().versions).toEqual([expect.objectContaining({ status: "READY" })]);
    expect(f.state().receipts).toHaveLength(1);
    expect(f.putObject).toHaveBeenCalledTimes(1);
  });

  it("stops after the second conflict", async () => {
    const error = deadlock();
    const f = fixture(new Map([[1, error], [2, error]]));
    await expect(f.execute()).rejects.toBe(error);
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.state().artifacts).toHaveLength(0);
    expect(f.putObject).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not repeat a transaction with an unknown outcome (committed: %s)", async committed => {
    const error = new Error("connection_lost");
    const f = fixture(new Map([[1, error]]), committed);
    await expect(f.execute()).rejects.toBe(error);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.state().artifacts).toHaveLength(committed ? 1 : 0);
    expect(f.putObject).not.toHaveBeenCalled();
  });

  it("rechecks the run guard before retrying", async () => {
    const f = fixture(new Map([[1, deadlock()]]));
    f.guard.mockResolvedValueOnce([{ id: "run" }]).mockResolvedValueOnce([]);
    await expect(f.execute()).rejects.toThrow("artifact_run_inactive");
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.state().artifacts).toHaveLength(0);
    expect(f.putObject).not.toHaveBeenCalled();
  });
});
