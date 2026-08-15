import { describe, expect, it } from "vitest";
import {
  artifactByteSizeLabel,
  artifactFormatLabel,
  artifactVersionLabel,
  boundArtifactVersion
} from "./artifactModel";
import { readyReportArtifact } from "@/app/ui-v2-fixture/_fixtures/artifactFixtures";

describe("artifact v2 presentation model", () => {
  it("formats only safe display metadata", () => {
    expect(artifactFormatLabel("xlsx")).toBe("XLSX");
    expect(artifactByteSizeLabel(512)).toBe("512 B");
    expect(artifactByteSizeLabel(219_136)).toBe("214 KB");
    expect(artifactByteSizeLabel(1_887_437)).toBe("1.8 MB");
    expect(artifactByteSizeLabel(-1)).toBe("Size unknown");
  });

  it("resolves the exact message-bound version and fails closed when it is absent", () => {
    const version = boundArtifactVersion(readyReportArtifact);
    expect(version?.id).toBe("artifact-version-private-report-v2");
    expect(version && artifactVersionLabel(version)).toBe("v2");
    expect(boundArtifactVersion({
      ...readyReportArtifact,
      boundVersionId: "missing-version"
    })).toBeNull();
  });
});
