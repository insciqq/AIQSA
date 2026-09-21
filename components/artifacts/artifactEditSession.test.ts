import { afterEach, describe, expect, it } from "vitest";
import { composerSessionKey, useComposerSessionStore } from "@/components/app-shell/composerSessionStore";
import { resetComposerSessionStoreForTest } from "@/tests/support/appShellStores";
import { setArtifactEditSession } from "./artifactEditSession";

afterEach(resetComposerSessionStoreForTest);
describe("artifact edit intent", () => {
  it("preserves an existing draft when selecting an edit or runtime repair", () => {
    const store = useComposerSessionStore.getState();
    const key = composerSessionKey("chat");
    store.activateSession(key);
    store.setDraft("Keep my original request.");
    const target = { artifactId: "artifact", versionId: "v1", title: "Counter", versionNumber: 1 };
    setArtifactEditSession("chat", target);
    expect(useComposerSessionStore.getState().sessionsByKey[key]).toMatchObject({ artifactEdit: target, draft: "Keep my original request." });
    setArtifactEditSession("chat", target, "runtime_error");
    setArtifactEditSession("chat", target, "runtime_error");
    expect(useComposerSessionStore.getState().sessionsByKey[key]?.draft).toBe("Keep my original request.");
  });
  it("prefills an empty draft with bounded diagnostic text and clears a creation selection", () => {
    const key = composerSessionKey("chat");
    useComposerSessionStore.getState().activateSession(key);
    useComposerSessionStore.getState().updateSession(key, { artifactCreate: { intent: "create" } });
    setArtifactEditSession("chat", { artifactId: "artifact", versionId: "v1", title: "Counter", versionNumber: 1 }, "runtime_error",
      { kind: "error", message: "counter is not defined", line: 32, column: 8 });
    expect(useComposerSessionStore.getState().sessionsByKey[key]).toMatchObject({ artifactCreate: null,
      draft: "Fix the runtime error in this artifact: counter is not defined (line 32:8)." });
  });
});
