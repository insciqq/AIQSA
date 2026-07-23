import type { McpSource } from "@/lib/contracts/mcp";
import { describe, expect, it } from "vitest";
import { parseMcpLocalResolvedArtifact } from "./localArtifact";

const npmSource: McpSource = {
  args: [],
  kind: "npm",
  packageName: "example-mcp",
  versionSelector: "^1.0.0"
};

describe("local MCP resolved artifacts", () => {
  it("records a ToolHive-generated package tag explicitly as a tag, not a Docker digest", () => {
    const artifact = parseMcpLocalResolvedArtifact({
      exactVersion: "1.2.3",
      imageRef: "toolhivelocal/npx-example-mcp-1-2-3:20260722202455",
      imageReferenceKind: "toolhive_generated_tag",
      kind: "toolhive_local",
      materializer: "npx",
      packageName: "example-mcp",
      registryArtifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
      registryIntegrity: "sha512-YWJjZA==",
      sourceKind: "npm",
      toolhiveVersion: "v0.40.1"
    }, npmSource);

    expect(artifact).toMatchObject({
      exactVersion: "1.2.3",
      imageReferenceKind: "toolhive_generated_tag",
      registryIntegrity: "sha512-YWJjZA=="
    });
  });

  it("does not accept a generated package tag presented as an OCI digest", () => {
    expect(parseMcpLocalResolvedArtifact({
      exactVersion: "1.2.3",
      imageRef: "toolhivelocal/npx-example-mcp-1-2-3:20260722202455",
      imageReferenceKind: "oci_digest",
      kind: "toolhive_local",
      materializer: "npx",
      packageName: "example-mcp",
      registryArtifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.2.3.tgz",
      registryIntegrity: "sha512-YWJjZA==",
      sourceKind: "npm",
      toolhiveVersion: "v0.40.1"
    }, npmSource)).toBeNull();
  });

  it("requires an actual sha256 reference for OCI artifacts", () => {
    const image = `example.invalid/mcp@sha256:${"a".repeat(64)}`;
    const source: McpSource = { args: [], image, kind: "oci" };

    expect(parseMcpLocalResolvedArtifact({
      imageRef: image,
      imageReferenceKind: "oci_digest",
      kind: "toolhive_local",
      materializer: "oci",
      sourceKind: "oci",
      toolhiveVersion: "v0.40.1"
    }, source)).toMatchObject({ imageRef: image, imageReferenceKind: "oci_digest" });
  });
});
