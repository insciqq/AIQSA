import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memory";
import { decodeMemoryActionControlDecision } from "../../../contracts/memoryActionIntent";
import { memoryControlAcceptedOutputHash, memoryControlIntentHash } from "../actions/controlRuntime";
import { consumeMemoryMutationAuthorization } from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";

const source = vi.hoisted(() => vi.fn());
vi.mock("./sourceAuthority", () => ({ requireMemoryCommandSource: source }));

function fixture() {
  const decoded = decodeMemoryActionControlDecision({ decision: {
    action: "SAVE", statement: "I prefer green", answerRequested: false, category: "preferences",
    confidenceBand: "HIGH", reasonCode: "save_request",
    responsePreference: false, sensitivity: "NORMAL", thisChatOnly: false
  } }, "Remember that I prefer green");
  if (!decoded.ok) throw new Error("invalid fixture");
  const intentHash = memoryControlIntentHash(decoded.value);
  const authorizedPayloadHash = memorySha256("I prefer green");
  const row = { id: "auth", action: "SAVE", authorizedPayloadHash, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    consumedAt: null, createdAt: new Date(Date.now() - 1_000), expiresAt: new Date(Date.now() + 60_000),
    expectedTargetVersionId: null, targetFactId: null, modelRunId: "run", persistedToolCallId: null,
    requestId: "command-v1:job", sourceChatId: "chat", sourceMessageId: "message" };
  const commandResult = { bindingId: "binding", claimToken: "lease", intentHash,
    mutationHash: memorySha256({ action: row.action, authorizedPayloadHash,
      domain: "aiqsa.memory.control-mutation", expectedTargetVersionId: null, targetFactId: null, version: 2 }),
    candidateMapHash: null, selectedHandle: null, selectionBindingId: null };
  const job = { id: "job", chatId: "chat", sourceMessageId: "message", leaseToken: "lease",
    commandIntent: { bindingId: "binding", intent: decoded.value }, commandResult };
  source.mockResolvedValue({ job, modelRunId: "run" });
  const tx = {
    memoryMutationAuthorization: { findFirst: vi.fn().mockResolvedValue(row), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    memoryExecutionBinding: { findFirst: vi.fn().mockResolvedValue({
      inputHash: "a".repeat(64), acceptedOutputHash: memoryControlAcceptedOutputHash("a".repeat(64), intentHash)
    }) },
    memoryJob: { update: vi.fn(), updateMany: vi.fn() }
  };
  const consume = () => consumeMemoryMutationAuthorization(tx as never, "owner", {
    action: "SAVE", authorizationId: "auth", authorizedPayloadHash, requestId: row.requestId
  });
  return { job, tx, consume };
}

beforeEach(() => vi.clearAllMocks());

describe("Memory command mutation authority", () => {
  it("records commit in the same transaction as consuming exact-source authority", async () => {
    const f = fixture(); await f.consume();
    expect(source).toHaveBeenCalledWith(f.tx, "owner", "job");
    expect(f.tx.memoryJob.update).toHaveBeenCalledWith({ where: { id: "job" }, data: { commandStatus: "COMMITTED" } });
    expect(f.tx.memoryMutationAuthorization.updateMany).toHaveBeenCalledOnce();
  });
  it("rejects a replaced decoded intent instead of reusing an accepted binding", async () => {
    const f = fixture(); f.job.commandIntent.intent.statement = "I prefer blue";
    await expect(f.consume()).rejects.toThrow("memory_mutation_authorization_invalid");
    expect(f.tx.memoryJob.update).not.toHaveBeenCalled();
    expect(f.tx.memoryMutationAuthorization.updateMany).not.toHaveBeenCalled();
  });
  it("rejects the authorization from a previous worker lease", async () => {
    const f = fixture(); f.job.leaseToken = "replacement-lease";
    await expect(f.consume()).rejects.toThrow("memory_mutation_authorization_invalid");
    expect(f.tx.memoryJob.update).not.toHaveBeenCalled();
  });
});
