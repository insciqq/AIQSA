import { afterEach, describe, expect, it, vi } from "vitest";
import { resetComposerSessionStoreForTest, resetThreadStoreForTest } from "@/tests/support/appShellStores";
import { composerSessionKey, selectComposerSession, useComposerSessionStore } from "./composerSessionStore";
import { selectThreadSnapshot, useThreadStore } from "./threadStore";
import { submitRunFollowup } from "./runFollowupAction";
import { shellFetch } from "./shellApi";

vi.mock("./shellApi", () => ({ shellFetch: vi.fn() }));
afterEach(() => { resetComposerSessionStoreForTest(); resetThreadStoreForTest(); vi.resetAllMocks(); });
const key = composerSessionKey("chat");
const session = () => selectComposerSession(useComposerSessionStore.getState(), key);
const receipt = { id: "followup-1", ordinal: 1, text: "Use three points", author: "Author",
  createdAt: "2026-09-22T00:00:00.000Z", delivery: "accepted" };
function setup() {
  useComposerSessionStore.getState().activateSession(key);
  useComposerSessionStore.getState().updateSession(key, { draft: "Use three points", attachments: [{ id: "file", fileName: "next.txt", kind: "file" }],
    artifactCreate: { intent: "create" } });
  useThreadStore.getState().replaceThread("chat", { activeLeafId: "answer", usageStats: null, messages: [
    { id: "answer", role: "assistant", parentMessageId: "question", content: "Old draft", status: "streaming", runId: "run",
      followups: { available: true, entries: [] } }
  ] });
}
function deferredResponse() {
  let resolve!: (value: Response) => void;
  return { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value) };
}

describe("follow-up composer submission", () => {
  it("clears only acknowledged text, keeping files and choices for the next send", async () => {
    setup(); const response = deferredResponse();
    vi.mocked(shellFetch).mockReturnValue(response.promise);
    const sending = submitRunFollowup("run");
    expect(session().draft).toBe("Use three points");
    expect(session().followupSubmission?.inFlight).toBe(true);
    await submitRunFollowup("run");
    expect(shellFetch).toHaveBeenCalledOnce();
    const sent = JSON.parse(String(vi.mocked(shellFetch).mock.calls[0]![1]!.body));
    expect(Object.keys(sent).sort()).toEqual(["assistantMessageId", "chatId", "nonce", "text"]);
    response.resolve(Response.json({ followup: receipt })); await sending;
    expect(session()).toMatchObject({ draft: "", attachments: [{ id: "file" }], artifactCreate: { intent: "create" }, followupSubmission: null });
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat").messages[0]!.followups?.entries).toEqual([receipt]);
  });

  it("reuses the nonce after a lost acknowledgement without duplicating history", async () => {
    setup(); vi.mocked(shellFetch).mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(Response.json({ followup: { ...receipt, delivery: "delivered" } }));
    await submitRunFollowup("run");
    expect(session().draft).toBe("Use three points");
    await submitRunFollowup("run");
    const nonces = vi.mocked(shellFetch).mock.calls.map(call => JSON.parse(String(call[1]!.body)).nonce);
    expect(nonces[0]).toBe(nonces[1]);
    expect(session().draft).toBe("");
    expect(selectThreadSnapshot(useThreadStore.getState(), "chat").messages[0]!.followups?.entries).toHaveLength(1);
  });

  it("keeps a newer draft and never transfers a late response to the opened chat", async () => {
    setup(); const response = deferredResponse(); vi.mocked(shellFetch).mockReturnValue(response.promise);
    const sending = submitRunFollowup("run");
    useComposerSessionStore.getState().updateSession(key, { draft: "My next clarification" });
    useComposerSessionStore.getState().activateSession(composerSessionKey("other"));
    useComposerSessionStore.getState().setDraft("Other chat draft");
    response.resolve(Response.json({ followup: receipt })); await sending;
    expect(session().draft).toBe("My next clarification");
    expect(selectComposerSession(useComposerSessionStore.getState(), composerSessionKey("other")).draft).toBe("Other chat draft");
    expect(selectThreadSnapshot(useThreadStore.getState(), "other").messages).toHaveLength(0);
  });

  it.each(["followup_closed", "followup_context_full", "model_run_not_found"])("preserves the draft on %s without starting another task", async error => {
    setup(); vi.mocked(shellFetch).mockResolvedValue(Response.json({ error }, { status: 409 }));
    await submitRunFollowup("run");
    expect(session().draft).toBe("Use three points");
    expect(session().operationError).toBeTruthy();
    expect(vi.mocked(shellFetch).mock.calls.map(call => call[0])).toEqual(["/api/model-runs/run/followups"]);
  });
});
