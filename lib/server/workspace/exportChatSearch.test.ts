import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { recordingTransaction, type RecordedCall } from "../chatSearch/index/markRecorder.testFixtures";
import { createPrismaWorkspaceCoordinatorRepository } from "./coordinator";

const OWNER = "owner-1";
const CHAT_ID = "chat-1";
const lease = { operation: { generation: 2, owner: "export:run-1:token" }, runId: "run-1", runtimeSandboxId: "runtime-1",
  sessionId: "session-1", token: "token" };
const output = { byteSize: 6, checksum: "c".repeat(64), mimeType: "text/plain", relativePath: "report.txt" };

const isChatLock = (call: RecordedCall) => call.name === "$queryRaw" && Boolean(call.text?.includes("FROM \"Chat\""));

function exportRepository(outputs: readonly typeof output[]) {
  const recorder = recordingTransaction({
    "workspaceRunBinding.count": () => 1,
    "workspaceRunBinding.findUniqueOrThrow": () => ({
      modelRun: { chatId: CHAT_ID, userId: OWNER },
      outputCapture: { id: "a".repeat(32), outputs },
      outputs: outputs.map(({ mimeType, ...rest }) => ({ ...rest, attachment: { mimeType } }))
    }),
    "workspaceSession.findUnique": () => ({ chatId: CHAT_ID, operationExpiresAt: new Date(Date.now() + 60_000),
      operationOwner: lease.operation.owner, runtimeSandboxId: lease.runtimeSandboxId, state: "READY", version: 2 })
  });
  return { recorder, repository: createPrismaWorkspaceCoordinatorRepository(recorder.client as unknown as PrismaClient) };
}

describe("a completed Workspace export", () => {
  it("marks the answer's chat for past-chat search, after the export's own chat lock", async () => {
    const { recorder, repository } = exportRepository([output]);

    await expect(repository.markExportComplete(lease)).resolves.toBe(true);

    const complete = recorder.indexOf((call) => call.name === "workspaceRunBinding.updateMany");
    const mark = recorder.indexOf((call) => call.name === "$executeRaw");
    expect(recorder.indexOf(isChatLock)).toBeLessThan(complete);
    expect(mark).toBeGreaterThan(complete);
    expect(recorder.marks()).toEqual([{ kind: "dirty", values: expect.arrayContaining([CHAT_ID, OWNER]) }]);
  });

  it("with no files marks nothing", async () => {
    const { recorder, repository } = exportRepository([]);

    await expect(repository.markExportComplete(lease)).resolves.toBe(true);
    expect(recorder.marks()).toEqual([]);
  });
});
