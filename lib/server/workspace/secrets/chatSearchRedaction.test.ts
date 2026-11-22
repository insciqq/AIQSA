import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordingTransaction, type RecordedCall } from "../../chatSearch/index/markRecorder.testFixtures";
import { mutateWorkspaceSecretInTransaction } from "./store";

const OWNER = "owner-1";
const key = () => Buffer.alloc(32, 7);
const isOwnerLock = (call: RecordedCall) => call.name === "$queryRaw" && Boolean(call.text?.includes("UPDATE \"User\""));

function secretStore(current: unknown = null) {
  return recordingTransaction({
    $queryRaw: (call) => isOwnerLock(call as RecordedCall) ? [{ id: OWNER }] : [],
    "user.update": () => ({ workspaceBrowserSequence: 1n }),
    "workspaceSecret.findFirst": () => current
  });
}

describe("saving a secret value re-redacts the owner's past-chat passages", () => {
  it("a new value marks every indexed chat of the owner, in the saving transaction", async () => {
    const recorder = secretStore();

    await mutateWorkspaceSecretInTransaction(recorder.tx, OWNER, {
      action: "create", description: "", name: "Deploy token", value: { kind: "text", text: "tok_live_8hQ2mZp4Lw9x" }
    }, key);

    const saved = recorder.indexOf((call) => call.name === "workspaceSecretValue.create");
    const mark = recorder.indexOf((call) => call.name === "$executeRaw");
    expect(saved).toBeGreaterThan(recorder.indexOf(isOwnerLock));
    expect(mark).toBeGreaterThan(saved);
    expect(recorder.marks()).toEqual([{ kind: "owner", values: [OWNER] }]);
    // The old Memory scrub request is gone.
    expect(recorder.calls.some((call) => call.name.startsWith("memoryDeletionOutbox."))).toBe(false);
  });

  it("a deleted secret and a browser sign-in mark nothing", async () => {
    const versionId = randomUUID();
    const deleted = secretStore({ id: "secret-1", value: { kind: "text" }, valueId: versionId });
    await mutateWorkspaceSecretInTransaction(deleted.tx, OWNER, {
      action: "delete", expectedVersionId: versionId, id: "secret-1"
    }, key);
    expect(deleted.marks()).toEqual([]);

    const browser = secretStore();
    await mutateWorkspaceSecretInTransaction(browser.tx, OWNER, {
      action: "create", description: "", name: "example.com",
      value: { base64: Buffer.from("{}").toString("base64"), kind: "browser_session", originalName: "example.com.json" }
    }, key);
    expect(browser.marks()).toEqual([]);
  });
});
