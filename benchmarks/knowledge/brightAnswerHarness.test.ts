import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBrightAnswerOperationScope, assertBrightAnswerMessageRoute, brightAnswerHash, brightAnswerJudgePrompt, createBrightAnswerStore,
  decodeBrightAnswerJudgment, decodeBrightChatStage, parseBrightAnswerCli,
  readBrightBoundedResponse, safeBrightAnswerError, selectBrightAnswerQueries, settleBrightChatStage
} from "./brightAnswerHarness";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("BRIGHT answer canary", () => {
  it.each(["chat_page_cursor_invalid", "http_404", "unauthorized", null])(
    "requires the real message-route response before paid admission (%s)", async (code) => {
      const probe = vi.fn(async () => { if (code) throw new Error(code); return {}; });
      const result = assertBrightAnswerMessageRoute(probe);
      if (code === "chat_page_cursor_invalid") await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("bright_answer_message_route_unavailable");
      expect(probe).toHaveBeenCalledOnce();
    }
  );

  it("requires separate paid authority and refuses a full run", () => {
    expect(() => parseBrightAnswerCli(["--output", "results/test"])).toThrow("paid_ack");
    expect(parseBrightAnswerCli(["--output", "results/test", "--preflight-only"]).queryLimit).toBe(5);
    for (const count of ["0", "6", "10", "11", "117", "-1"]) {
      expect(() => parseBrightAnswerCli(["--output", "results/test", "--query-limit", count])).toThrow("canary_limit");
    }
    expect(() => parseBrightAnswerCli(["--full"])).toThrow("argument_unknown");
    expect(() => parseBrightAnswerCli(["--resume", "--resume"])).toThrow("duplicate");
    expect(parseBrightAnswerCli(["--confirm-paid", "BRIGHT_ANSWER_JUDGE", "--query-limit", "5",
      "--batch-size", "1", "--output", "results/test", "--resume"])).toMatchObject({
      queryLimit: 5, batchSize: 1, resume: true
    });
  });

  it("selects successive five-question batches with stable official ordinals", () => {
    const args = ["--output", "results/test", "--preflight-only"];
    const queries = Array.from({ length: 117 }, (_, ordinal) => ({ ordinal, query: "Synthetic question" }));
    const first = parseBrightAnswerCli(args);
    const second = parseBrightAnswerCli([...args, "--query-offset", "5"]);
    expect(first).toMatchObject({ batchSize: 5, queryLimit: 5, queryOffset: 0 });
    expect(selectBrightAnswerQueries(queries, first).map(({ ordinal }) => ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(selectBrightAnswerQueries(queries, second).map(({ ordinal }) => ordinal)).toEqual([5, 6, 7, 8, 9]);
    const tail = parseBrightAnswerCli([...args, "--query-offset", "115", "--query-limit", "2"]);
    expect(selectBrightAnswerQueries(queries, tail).map(({ ordinal }) => ordinal)).toEqual([115, 116]);
    for (const offset of ["-1", "117", "05", "1.5"]) {
      expect(() => parseBrightAnswerCli([...args, "--query-offset", offset])).toThrow("query_offset_invalid");
    }
    expect(() => parseBrightAnswerCli([...args, "--query-offset", "115"])).toThrow("query_range_invalid");
    expect(() => selectBrightAnswerQueries(queries.slice(0, 10), first)).toThrow("query_range_invalid");
    expect(() => selectBrightAnswerQueries(queries, { queryOffset: 116, queryLimit: 2 })).toThrow("query_range_invalid");
    expect(() => parseBrightAnswerCli([...args, "--batch-size", "6"])).toThrow("canary_limit_invalid");
  });

  it("separates answer correctness from grounding and rejects inconsistent passes", () => {
    const valid = { verdict: "pass", grounding: "unsupported", explanation: "Correct but uncited.",
      missingPoints: [], incorrectClaims: [] };
    expect(decodeBrightAnswerJudgment(JSON.stringify(valid))).toEqual(valid);
    expect(decodeBrightAnswerJudgment(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
    expect(() => decodeBrightAnswerJudgment(JSON.stringify({ ...valid, missingPoints: ["A required condition."] }))).toThrow();
    expect(() => decodeBrightAnswerJudgment(JSON.stringify({ ...valid, extra: true }))).toThrow();
    expect(() => decodeBrightAnswerJudgment("not json")).toThrow();
    expect(brightAnswerJudgePrompt({ question: "Question", referenceAnswer: "Reference",
      answer: "Answer", evidence: [] })).toContain("referenceAnswer");
  });

  it("does not leak arbitrary errors into aggregate output", () => {
    expect(safeBrightAnswerError(new Error("secret URL or request body"))).toBe("bright_answer_unclassified_failure");
    expect(safeBrightAnswerError(new Error("provider_timeout"))).toBe("provider_timeout");
    expect(() => decodeBrightChatStage({ chatId: "id", state: "settled", runId: null,
      requestHash: "a".repeat(64) })).toThrow();
  });

  it("checks the ordinary operation ID contract before paid execution", () => {
    const scope = { baseId: "11111111-1111-4111-8111-111111111111", snapshotId: `kbs_${"a".repeat(40)}`,
      profileRevisionId: "22222222-2222-4222-8222-222222222222", profileRevisionNumber: 1 };
    expect(() => assertBrightAnswerOperationScope(scope)).not.toThrow();
    expect(() => assertBrightAnswerOperationScope({ ...scope, baseId: "not-an-id" })).toThrow("contract_incompatible");
    expect(() => assertBrightAnswerOperationScope({ ...scope, snapshotId: "not-a-snapshot" })).toThrow("contract_incompatible");
  });

  it("bounds HTTP bytes before parsing and decodes split UTF-8", async () => {
    const encoded = new TextEncoder().encode("é");
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoded.slice(0, 1));
      controller.enqueue(encoded.slice(1));
      controller.close();
    } }));
    await expect(readBrightBoundedResponse(response, 2)).resolves.toBe("é");
    await expect(readBrightBoundedResponse(new Response("large"), 2)).rejects.toThrow("too_large");
  });
});

function stageFixture() {
  const files = new Map<string, unknown>();
  const request = { question: "A synthetic question" };
  const trace = { id: "run-1", status: "complete", answer: "A synthetic answer", error: null };
  const store = {
    read: vi.fn(async (name: string) => files.get(name) ?? null),
    write: vi.fn(async (name: string, value: unknown) => { files.set(name, value); })
  };
  return {
    files, request, trace, store, prefix: "001/answer", deadlineMs: 1_000,
    createChat: vi.fn(async () => "chat-1"), send: vi.fn(async () => undefined),
    capture: vi.fn(async () => trace), beforeSend: vi.fn(async () => undefined),
    wait: vi.fn(async () => undefined), progress: vi.fn()
  };
}

describe("durable paid stage boundary", () => {
  it("reserves before send, settles, and resumes without another answer call", async () => {
    const fixture = stageFixture();
    fixture.send.mockImplementation(async () => {
      expect(fixture.files.get("001/answer-state.json")).toMatchObject({ state: "submitted" });
    });
    await expect(settleBrightChatStage(fixture)).resolves.toEqual(fixture.trace);
    await expect(settleBrightChatStage(fixture)).resolves.toEqual(fixture.trace);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.createChat).toHaveBeenCalledTimes(1);
  });

  it("recovers a completed response after an HTTP interruption without replay", async () => {
    const fixture = stageFixture();
    fixture.send.mockRejectedValue(new Error("network_failure"));
    await expect(settleBrightChatStage(fixture)).resolves.toEqual(fixture.trace);
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });

  it("reconciles a crash-ambiguous stage and never sends it again", async () => {
    const fixture = stageFixture();
    fixture.files.set("001/answer-state.json", {
      chatId: "chat-1", state: "submitted", runId: null, requestHash: brightAnswerHash(fixture.request)
    });
    await expect(settleBrightChatStage(fixture)).resolves.toEqual(fixture.trace);
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.createChat).not.toHaveBeenCalled();
  });

  it("halts when an ambiguous request has no durable product run", async () => {
    const fixture = stageFixture();
    fixture.files.set("001/answer-state.json", {
      chatId: "chat-1", state: "submitted", runId: null, requestHash: brightAnswerHash(fixture.request)
    });
    await expect(settleBrightChatStage({ ...fixture, continueKnowledgeFailures: true, capture: async () => null })).rejects.toThrow("dispatch_ambiguous");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("preserves a provider failure trace and stops scheduling", async () => {
    const fixture = stageFixture();
    fixture.capture.mockResolvedValue({ ...fixture.trace, status: "error", answer: "", error: "provider_timeout" } as never);
    await expect(settleBrightChatStage(fixture)).rejects.toThrow("provider_timeout");
    expect(fixture.files.get("001/answer-trace.json")).toMatchObject({ status: "error" });
    expect(fixture.files.has("001/answer.json")).toBe(false);
  });

  it.each(["knowledge_answer_contract_failed", "knowledge_retrieval_failed", "knowledge_retrieval_query_timed_out"])
    ("settles classified Knowledge failure %s without another paid send on resume", async (error) => {
      const fixture = stageFixture();
      const failed = { ...fixture.trace, status: "error", answer: "", error };
      fixture.capture.mockResolvedValue(failed as never);
      await expect(settleBrightChatStage({ ...fixture, continueKnowledgeFailures: true })).resolves.toEqual(failed);
      expect(fixture.files.get("001/answer-state.json")).toMatchObject({ state: "settled", runId: failed.id });
      fixture.capture.mockRejectedValue(new Error("unexpected_capture"));
      await expect(settleBrightChatStage({ ...fixture, continueKnowledgeFailures: true })).resolves.toEqual(failed);
      expect(fixture.send).toHaveBeenCalledTimes(1);
      expect(fixture.createChat).toHaveBeenCalledTimes(1);
      await expect(settleBrightChatStage(fixture)).rejects.toThrow("settled_trace_invalid");
      const next = { ...fixture.trace, id: "run-2" };
      fixture.capture.mockResolvedValue(next);
      fixture.createChat.mockResolvedValue("chat-2");
      await expect(settleBrightChatStage({ ...fixture, prefix: "002/answer", continueKnowledgeFailures: true }))
        .resolves.toEqual(next);
      expect(fixture.send).toHaveBeenCalledTimes(2);
    });

  it.each([
    { status: "cancelled", error: "knowledge_answer_contract_failed" },
    { status: "error", error: "provider_timeout" },
    { status: "error", error: "run_access_denied" }
  ])("does not continue a cancelled or unclassified terminal run: $error", async (failure) => {
    const fixture = stageFixture();
    fixture.capture.mockResolvedValue({ ...fixture.trace, ...failure, answer: "" } as never);
    await expect(settleBrightChatStage({ ...fixture, continueKnowledgeFailures: true })).rejects.toThrow(failure.error);
    expect(fixture.files.has("001/answer.json")).toBe(false);
  });

  it("refuses request drift before provider work", async () => {
    const fixture = stageFixture();
    fixture.files.set("001/answer-state.json", {
      chatId: "chat-1", state: "created", runId: null, requestHash: "0".repeat(64)
    });
    await expect(settleBrightChatStage(fixture)).rejects.toThrow("request_drift");
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("resumes the judge independently of a settled answer", async () => {
    const fixture = stageFixture();
    await settleBrightChatStage(fixture);
    fixture.send.mockClear();
    await settleBrightChatStage(fixture);
    await settleBrightChatStage({ ...fixture, prefix: "001/judge" });
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.files.has("001/judge.json")).toBe(true);
  });
});

describe("private checkpoint integrity", () => {
  async function fixture() {
    const repositoryRoot = await mkdtemp(resolve(tmpdir(), "bright-answer-checkpoint-"));
    temporaryRoots.push(repositoryRoot);
    return { repositoryRoot, output: resolve(repositoryRoot, "benchmarks/knowledge/results/test"),
      manifest: { contractVersion: 1, model: "fixture" }, resume: false };
  }

  it("writes private atomic receipts, prevents concurrent writers, and verifies resume", async () => {
    const input = await fixture();
    const store = await createBrightAnswerStore(input);
    await expect(createBrightAnswerStore({ ...input, resume: true })).rejects.toThrow("locked");
    await store.write("001/answer.json", { answer: "Private fixture" });
    expect((await stat(resolve(input.output, "001/answer.json"))).mode & 0o777).toBe(0o600);
    await store.close();
    const resumed = await createBrightAnswerStore({ ...input, resume: true });
    expect(await resumed.read("001/answer.json")).toEqual({ answer: "Private fixture" });
    await resumed.close();
    await expect(createBrightAnswerStore({ ...input, resume: true, manifest: { model: "changed" } })).rejects.toThrow("manifest_mismatch");
  });

  it("rejects corrupt receipts rather than paying for a replacement", async () => {
    const input = await fixture();
    const store = await createBrightAnswerStore(input);
    await store.write("001/answer.json", { answer: "Private fixture" });
    const path = resolve(input.output, "001/answer.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.value.answer = "tampered";
    await writeFile(path, JSON.stringify(receipt));
    await expect(store.read("001/answer.json")).rejects.toThrow("corrupt");
    await store.close();
  });

  it("hashes Prisma timestamps in their persisted JSON representation", async () => {
    const input = await fixture();
    const store = await createBrightAnswerStore(input);
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    await store.write("001/answer.json", { createdAt, nested: [{ completedAt: createdAt }] });
    await store.close();
    const resumed = await createBrightAnswerStore({ ...input, resume: true });
    expect(await resumed.read("001/answer.json")).toEqual({
      createdAt: createdAt.toISOString(), nested: [{ completedAt: createdAt.toISOString() }]
    });
    await resumed.close();
  });

  it("refuses an existing directory without a manifest", async () => {
    const input = await fixture();
    const store = await createBrightAnswerStore(input);
    await store.write("001/answer.json", {});
    await store.close();
    await rm(resolve(input.output, "manifest.json"));
    await expect(createBrightAnswerStore(input)).rejects.toThrow("not_empty");
  });

  it("rejects symlinks and paths outside the private boundary", async () => {
    const input = await fixture();
    await expect(createBrightAnswerStore({ ...input, output: resolve(input.repositoryRoot, "tracked") })).rejects.toThrow("private_path");
    const store = await createBrightAnswerStore(input);
    await symlink(input.repositoryRoot, resolve(input.output, "001"));
    await expect(store.write("001/answer.json", {})).rejects.toThrow("symlink");
    await expect(store.write("../answer.json", {})).rejects.toThrow("name_invalid");
    await store.close();
  });
});
