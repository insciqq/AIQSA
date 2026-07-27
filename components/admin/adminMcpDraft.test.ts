import { describe, expect, it } from "vitest";
import {
  changeMcpRemoteSource,
  defaultMcpDraft,
  diffMcpToolInventory,
  normalizeMcpImport,
  preparedMcpOAuthPolicy
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

  it("accepts trailing commas in MCP JSON without changing commas inside strings", () => {
    const normalized = normalizeMcpImport(`{
      "mcpServers": {
        "mem0": {
          "command": "uvx",
          "args": ["mem0-mcp-server",],
          "env": {
            "MEM0_API_KEY": "fixture,} value,]",
          },
        },
      },
    }`);

    expect(normalized).toMatchObject({
      name: "mem0",
      draft: {
        auth: { mode: "static" },
        source: {
          args: [],
          kind: "pypi",
          packageName: "mem0-mcp-server"
        },
        slots: [expect.objectContaining({
          target: { kind: "environment", name: "MEM0_API_KEY" }
        })]
      },
      sharedValues: { mem0_api_key: "fixture,} value,]" }
    });
  });

  it("keeps malformed JSON and broader JSON5 syntax invalid", () => {
    expect(() => normalizeMcpImport('{"mcpServers": {,}}'))
      .toThrow(/not valid JSON/i);
    expect(() => normalizeMcpImport('{"command": "uvx" "args": []}'))
      .toThrow(/not valid JSON/i);
    expect(() => normalizeMcpImport('{// comment\n"command": "uvx", "args": ["server"]}'))
      .toThrow(/not valid JSON/i);
  });

  it("normalizes direct URLs and common uvx and OCI launch shapes", () => {
    expect(normalizeMcpImport("https://mcp.notion.com/mcp")).toMatchObject({
      draft: {
        auth: {
          allowedAuthorizationServerOrigins: ["https://mcp.notion.com"],
          mode: "oauth",
          scopes: []
        },
        source: { kind: "remote", url: "https://mcp.notion.com/mcp" }
      },
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

  it("prepares the official hosted Notion JSON for same-origin OAuth", () => {
    const normalized = normalizeMcpImport(JSON.stringify({
      mcpServers: {
        notion: { url: "https://mcp.notion.com/mcp" }
      }
    }));

    expect(normalized).toMatchObject({
      name: "notion",
      draft: {
        auth: {
          allowedAuthorizationServerOrigins: ["https://mcp.notion.com"],
          mode: "oauth",
          scopes: []
        },
        source: { kind: "remote", url: "https://mcp.notion.com/mcp" }
      }
    });
  });

  it("keeps generic URL imports unauthenticated while preparing explicit same-origin OAuth", () => {
    const generic = normalizeMcpImport(JSON.stringify({
      mcpServers: { example: { url: "https://mcp.example.test/mcp" } }
    }));
    const oauth = normalizeMcpImport(JSON.stringify({
      mcpServers: { example: { auth: "oauth", url: "https://mcp.example.test/mcp" } }
    }));

    expect(generic.draft.auth).toEqual({ mode: "none" });
    expect(oauth.draft.auth).toEqual({
      allowedAuthorizationServerOrigins: ["https://mcp.example.test"],
      mode: "oauth",
      scopes: []
    });
  });

  it("prepares and follows a remote endpoint origin without replacing reviewed external origins", () => {
    expect(preparedMcpOAuthPolicy({ kind: "remote", url: "https://mcp.example.test/path" }))
      .toEqual({
        allowedAuthorizationServerOrigins: ["https://mcp.example.test"],
        mode: "oauth",
        scopes: []
      });
    expect(preparedMcpOAuthPolicy({ kind: "remote", url: "not a URL" }))
      .toEqual({ allowedAuthorizationServerOrigins: [], mode: "oauth", scopes: [] });

    const sameOriginDraft = {
      ...defaultMcpDraft("remote"),
      auth: {
        allowedAuthorizationServerOrigins: ["https://old.example.test"],
        mode: "oauth" as const,
        scopes: []
      },
      source: { kind: "remote" as const, url: "https://old.example.test/mcp" }
    };
    expect(changeMcpRemoteSource(
      sameOriginDraft,
      { kind: "remote", url: "https://new.example.test/mcp" }
    ).auth).toEqual({
      allowedAuthorizationServerOrigins: ["https://new.example.test"],
      mode: "oauth",
      scopes: []
    });

    const reviewed = {
      ...sameOriginDraft,
      auth: {
        ...sameOriginDraft.auth,
        allowedAuthorizationServerOrigins: ["https://login.example.test"]
      }
    };
    expect(changeMcpRemoteSource(
      reviewed,
      { kind: "remote", url: "https://new.example.test/mcp" }
    ).auth).toEqual(reviewed.auth);
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
    const normalized = normalizeMcpImport(`{
      "mcpServers": {
        "canvas-local": {
          "args": ["--verbose",],
          "command": "canvas-local-mcp",
          "env": { "CANVAS_BASE_URL": "https://canvas.example.edu", },
        },
      },
    }
    pip install canvas-local-mcp==0.1.1`);

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
