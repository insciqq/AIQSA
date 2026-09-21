import { afterEach, describe, expect, it } from "vitest";
import { closeArtifactPanel, openArtifactPanel, selectArtifactPanelVersion, useArtifactPanelStore } from "./artifactPanelStore";

afterEach(() => closeArtifactPanel(false));

describe("artifact panel version selection", () => {
  it("selects a saved version without changing its artifact or chat", () => {
    openArtifactPanel({ chatId: "chat", artifactId: "artifact", versionId: "v2" });

    selectArtifactPanelVersion("v1");

    expect(useArtifactPanelStore.getState().open).toEqual({ chatId: "chat", artifactId: "artifact", versionId: "v1" });
  });

  it.each(["draft", ""])("keeps a generation target unchanged when selecting a saved version (draft %j)", draftId => {
    openArtifactPanel({ chatId: "chat", draftId });
    const target = useArtifactPanelStore.getState().open;

    selectArtifactPanelVersion("v1");

    expect(useArtifactPanelStore.getState().open).toBe(target);
  });

  it("keeps a closed panel closed", () => {
    selectArtifactPanelVersion("v1");

    expect(useArtifactPanelStore.getState().open).toBeNull();
  });
});
