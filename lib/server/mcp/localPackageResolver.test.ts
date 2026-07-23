import { describe, expect, it, vi } from "vitest";
import { createMcpLocalPackageResolver } from "./localPackageResolver";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

describe("local MCP package resolution", () => {
  it("pins an npm range to an exact version and registry integrity", async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({
      "dist-tags": { latest: "2.1.0" },
      versions: {
        "1.4.0": {
          dist: {
            integrity: "sha512-YWJjZA==",
            tarball: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.4.0.tgz"
          }
        },
        "2.1.0": {
          dist: {
            integrity: "sha512-ZWZnaA==",
            tarball: "https://registry.npmjs.org/example-mcp/-/example-mcp-2.1.0.tgz"
          }
        }
      }
    }));
    const resolve = createMcpLocalPackageResolver(fetchImplementation);

    await expect(resolve({
      args: [],
      kind: "npm",
      packageName: "example-mcp",
      versionSelector: "^1.0.0"
    })).resolves.toEqual({
      kind: "ok",
      value: {
        artifactUrl: "https://registry.npmjs.org/example-mcp/-/example-mcp-1.4.0.tgz",
        exactVersion: "1.4.0",
        integrity: "sha512-YWJjZA==",
        materializer: "npx",
        packageName: "example-mcp",
        protocolImage: "npx://example-mcp@1.4.0",
        sourceKind: "npm"
      }
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://registry.npmjs.org/example-mcp"),
      expect.objectContaining({ method: "GET", redirect: "error" })
    );
  });

  it("pins a PyPI release to uvx and prefers its non-yanked sdist digest", async () => {
    const digest = "a".repeat(64);
    const resolve = createMcpLocalPackageResolver(vi.fn(async () => jsonResponse({
      info: { version: "3.2.1" },
      releases: {
        "3.2.1": [
          {
            digests: { sha256: "b".repeat(64) },
            packagetype: "bdist_wheel",
            url: "https://files.pythonhosted.org/example_mcp-3.2.1.whl",
            yanked: false
          },
          {
            digests: { sha256: digest },
            packagetype: "sdist",
            url: "https://files.pythonhosted.org/example_mcp-3.2.1.tar.gz",
            yanked: false
          }
        ]
      }
    })));

    await expect(resolve({
      args: ["--stdio"],
      kind: "pypi",
      packageName: "example-mcp",
      versionSelector: "==3.2.1"
    })).resolves.toEqual({
      kind: "ok",
      value: {
        artifactUrl: "https://files.pythonhosted.org/example_mcp-3.2.1.tar.gz",
        exactVersion: "3.2.1",
        integrity: `sha256:${digest}`,
        materializer: "uvx",
        packageName: "example-mcp",
        protocolImage: "uvx://example-mcp@3.2.1",
        sourceKind: "pypi"
      }
    });
  });

  it("rejects unsupported PyPI range selectors with a stable issue", async () => {
    const resolve = createMcpLocalPackageResolver(vi.fn(async () => jsonResponse({
      info: { version: "3.2.1" },
      releases: {}
    })));

    await expect(resolve({
      args: [],
      kind: "pypi",
      packageName: "example-mcp",
      versionSelector: ">=3"
    })).resolves.toEqual({
      issue: { code: "pypi_version_selector_unsupported", path: "source.versionSelector" },
      kind: "invalid"
    });
  });
});
