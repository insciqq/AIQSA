import { describe, expect, it, vi } from "vitest";
import { chatTitleWork } from "@/tests/support/chatTitles";
import { createChatTitleWorker } from "./titleGenerationWorker";

function fixture() {
  const work = chatTitleWork();
  const repository = {
    enqueue: vi.fn(), finish: vi.fn(), isCurrent: vi.fn(async () => true),
    recordUsage: vi.fn(), recover: vi.fn(),
    take: vi.fn().mockResolvedValueOnce(work).mockResolvedValue(null)
  };
  return { repository, work };
}

describe("background chat title worker", () => {
  it.each(["generated", "invalid", "failed"] as const)("keeps reported usage before settling %s output", async (outcome) => {
    const { repository, work } = fixture();
    const usage = { inputTokens: 10, outputTokens: 3, reasoningTokens: 0, totalTokens: 13 };
    const execute = vi.fn<Parameters<typeof createChatTitleWorker>[0]["execute"]>(async (_snapshot, _request, options) => {
      options?.onUsage?.(usage);
      if (outcome === "failed") throw new Error("synthetic_provider_failure");
      return { title: outcome === "invalid" ? "" : "Network transport comparison" };
    });
    await createChatTitleWorker({ execute, repository }).reconcile(new AbortController().signal);
    expect(execute).toHaveBeenCalledExactlyOnceWith(work.providerSnapshot,
      expect.objectContaining({ maxOutputTokens: 64, name: "chat_title", reasoningEffort: null }),
      expect.objectContaining({ timeoutMs: 8_000 }));
    expect(repository.recordUsage).toHaveBeenCalledExactlyOnceWith(work, usage);
    expect(repository.finish).toHaveBeenCalledExactlyOnceWith(work, outcome === "generated" ? "Network transport comparison" : null);
    expect(repository.recordUsage.mock.invocationCallOrder[0]).toBeLessThan(repository.finish.mock.invocationCallOrder[0]!);
  });

  it("retains accounting when title persistence fails without repeating the provider request", async () => {
    const { repository } = fixture();
    repository.finish.mockRejectedValue(new Error("synthetic_title_write_failure"));
    const execute = vi.fn<Parameters<typeof createChatTitleWorker>[0]["execute"]>(async (_snapshot, _request, options) => {
      options?.onUsage?.({ inputTokens: 5, outputTokens: 1, reasoningTokens: 0 });
      return { title: "A short title" };
    });
    const worker = createChatTitleWorker({ execute, repository });
    await expect(worker.reconcile(new AbortController().signal)).rejects.toThrow("synthetic_title_write_failure");
    await worker.reconcile(new AbortController().signal);
    expect(execute).toHaveBeenCalledOnce();
    expect(repository.recordUsage).toHaveBeenCalledOnce();
  });

  it("does not dispatch after ownership, lifecycle or manual-title authority changes", async () => {
    const { repository, work } = fixture();
    repository.isCurrent.mockResolvedValue(false);
    const execute = vi.fn();
    await createChatTitleWorker({ execute, repository }).reconcile(new AbortController().signal);
    expect(execute).not.toHaveBeenCalled();
    expect(repository.recordUsage).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(work, null);
  });

  it("passes application cancellation to its single held provider call and preserves reported usage", async () => {
    const { repository } = fixture();
    const controller = new AbortController();
    const execute = vi.fn<Parameters<typeof createChatTitleWorker>[0]["execute"]>(async (_snapshot, _request, options) => {
      options?.onUsage?.({ inputTokens: 4, outputTokens: 0, reasoningTokens: 0 });
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("cancelled");
    });
    const pending = createChatTitleWorker({ execute, repository }).reconcile(controller.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort();
    await pending;
    expect(repository.recordUsage).toHaveBeenCalledOnce();
    expect(repository.take).toHaveBeenCalledOnce();
  });
});
