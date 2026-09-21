import { afterEach, describe, expect, it } from "vitest";
import { consumeArtifactRuntimeError, storeArtifactRuntimeError } from "./artifactRuntimeSession";

afterEach(() => sessionStorage.clear());
describe("runtime repair handoff", () => {
  it("stores a bounded UTF-8 diagnostic only for the version and consumes it once", () => {
    storeArtifactRuntimeError("v1", { kind: "error", message: "界".repeat(300), line: 42, column: 4 });
    const encoded = sessionStorage.getItem("aiqsa.artifactFix.v1")!;
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(1024);
    expect(consumeArtifactRuntimeError("other")).toBeNull();
    expect(consumeArtifactRuntimeError("v1")).toMatchObject({ kind: "error", line: 42, column: 4 });
    expect(consumeArtifactRuntimeError("v1")).toBeNull();
  });
  it.each(["invalid-json", JSON.stringify({ type: "aiqsa_artifact_runtime_error", kind: "error", message: "x".repeat(2000), line: 0, column: 0 })])("drops malformed or oversized handoffs", value => {
    sessionStorage.setItem("aiqsa.artifactFix.v1", value);
    expect(consumeArtifactRuntimeError("v1")).toBeNull();
    expect(sessionStorage.getItem("aiqsa.artifactFix.v1")).toBeNull();
  });
});
