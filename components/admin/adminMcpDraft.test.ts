import { describe, expect, it } from "vitest";
import {
  defaultMcpDraft,
  diffMcpToolInventory,
  normalizeMcpImport
} from "./adminMcpDraft";

describe("adminMcpDraft", () => {
  it("starts with the one supported transport for each source kind", () => {
    expect(defaultMcpDraft("remote")).toMatchObject({
      source: { kind: "remote" },
      transport: "streamable_http"
    });
    expect(defaultMcpDraft("npm")).toMatchObject({
      source: { kind: "npm" },
      transport: "stdio"
    });
  });

  it("normalizes a common npx config and treats imported env values as write-only shared fields", () => {
    const normalized = normalizeMcpImport(JSON.stringify({
      mcpServers: {
        memory: {
          args: ["-y", "@mem0/mcp-server@2.3.0", "--stdio"],
          command: "npx",
          env: {
            MEM0_API_KEY: "secret-value",
            MEM0_DEFAULT_USER_ID: "user123"
          }
        }
      }
    }));

    expect(normalized.name).toBe("memory");
    expect(normalized.draft).toMatchObject({
      auth: { mode: "static" },
      source: {
        args: ["--stdio"],
        kind: "npm",
        packageName: "@mem0/mcp-server",
        versionSelector: "2.3.0"
      },
      transport: "stdio"
    });
    expect(normalized.draft.slots).toEqual([
      expect.objectContaining({ slotKey: "mem0_api_key", target: { kind: "environment", name: "MEM0_API_KEY" } }),
      expect.objectContaining({ slotKey: "mem0_default_user_id", target: { kind: "environment", name: "MEM0_DEFAULT_USER_ID" } })
    ]);
    expect(normalized.sharedValues).toEqual({
      mem0_api_key: "secret-value",
      mem0_default_user_id: "user123"
    });
  });

  it("normalizes direct URLs and common uvx and OCI launch shapes", () => {
    expect(normalizeMcpImport("https://mcp.notion.com/mcp")).toMatchObject({
      draft: { source: { kind: "remote", url: "https://mcp.notion.com/mcp" } },
      name: "mcp.notion.com"
    });
    expect(normalizeMcpImport(JSON.stringify({
      command: "uvx",
      args: ["mcp-server-fetch==1.4.0", "--ignore-robots-txt"],
      name: "Fetch"
    })).draft.source).toEqual({
      args: ["--ignore-robots-txt"],
      kind: "pypi",
      packageName: "mcp-server-fetch",
      versionSelector: "==1.4.0"
    });
    expect(normalizeMcpImport(JSON.stringify({
      command: "docker",
      args: ["run", "--rm", "-i", "ghcr.io/team/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]
    })).draft.source).toEqual({
      args: [],
      image: "ghcr.io/team/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "oci"
    });
  });

  it("normalizes familiar pasted launch and install commands without executing shell", () => {
    expect(normalizeMcpImport("npx -y @playwright/mcp@latest")).toMatchObject({
      name: "@playwright/mcp",
      draft: {
        source: {
          args: [],
          kind: "npm",
          packageName: "@playwright/mcp",
          versionSelector: "latest"
        }
      }
    });
    expect(normalizeMcpImport("pip install canvas-local-mcp==0.1.1")).toMatchObject({
      name: "canvas-local-mcp",
      draft: {
        source: {
          args: [],
          kind: "pypi",
          packageName: "canvas-local-mcp",
          versionSelector: "==0.1.1"
        }
      }
    });
    expect(normalizeMcpImport("python3 -m pip install --no-cache-dir canvas-local-mcp").draft.source)
      .toEqual({ args: [], kind: "pypi", packageName: "canvas-local-mcp" });
    expect(() => normalizeMcpImport("npx package && curl https://example.com"))
      .toThrow(/without shell operators/i);
    expect(() => normalizeMcpImport("canvas-local-mcp"))
      .toThrow(/could not identify how that command is installed/i);
  });

  it("uses a pasted install command to resolve a JSON config with a bare executable", () => {
    const normalized = normalizeMcpImport(`${JSON.stringify({
      mcpServers: {
        "canvas-local": {
          args: ["--verbose"],
          command: "canvas-local-mcp",
          env: { CANVAS_BASE_URL: "https://canvas.example.edu" }
        }
      }
    }, null, 2)}\npip install canvas-local-mcp==0.1.1`);

    expect(normalized).toMatchObject({
      name: "canvas-local",
      draft: {
        source: {
          args: ["--verbose"],
          kind: "pypi",
          packageName: "canvas-local-mcp",
          versionSelector: "==0.1.1"
        },
        slots: [expect.objectContaining({
          target: { kind: "environment", name: "CANVAS_BASE_URL" }
        })]
      },
      sharedValues: { canvas_base_url: "https://canvas.example.edu" }
    });
  });

  it("requires one pasted server and produces a stable tool diff", () => {
    expect(() => normalizeMcpImport(JSON.stringify({
      mcpServers: { first: { url: "https://one.example/mcp" }, second: { url: "https://two.example/mcp" } }
    }))).toThrow(/exactly one/i);

    expect(diffMcpToolInventory(
      [{ description: "Old", name: "changed" }, { description: null, name: "removed" }],
      [{ description: "New", name: "changed" }, { description: null, name: "added" }]
    )).toEqual({
      added: [{ description: null, name: "added" }],
      changed: [{ description: "New", name: "changed" }],
      removed: [{ description: null, name: "removed" }],
      unchanged: []
    });
  });
});
