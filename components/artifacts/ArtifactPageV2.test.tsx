import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactViewerV2Props } from "./ArtifactViewerV2";

const mocks = vi.hoisted(() => ({
  prepareArtifactEdit: vi.fn(async () => "source chat"),
  push: vi.fn(),
  replace: vi.fn(),
  storeArtifactRuntimeError: vi.fn(),
  viewer: null as ArtifactViewerV2Props | null
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("./artifactClient", () => ({ prepareArtifactEdit: mocks.prepareArtifactEdit }));
vi.mock("./artifactRuntimeSession", () => ({ storeArtifactRuntimeError: mocks.storeArtifactRuntimeError }));
vi.mock("./ArtifactViewerV2", () => ({
  ArtifactViewerV2: (props: ArtifactViewerV2Props) => {
    mocks.viewer = props;
    return null;
  }
}));

import { ArtifactPageV2 } from "./ArtifactPageV2";

afterEach(() => vi.clearAllMocks());

describe("standalone artifact page", () => {
  it("edits in the source chat through its path address", async () => {
    render(<ArtifactPageV2 artifactId="artifact/1" versionId="version 2" />);
    await mocks.viewer!.onEditRequest("edit");
    expect(mocks.prepareArtifactEdit).toHaveBeenCalledWith("artifact/1", "version 2");
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(
      "/c/source%20chat?artifactEdit=edit&artifactId=artifact%2F1&versionId=version+2"
    );
    const target = new URL(mocks.push.mock.calls[0]![0] as string, "https://aiqsa.invalid");
    expect([...target.searchParams.keys()]).not.toContain("chat");
  });
});
