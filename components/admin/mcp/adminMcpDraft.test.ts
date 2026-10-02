import { describe, expect, it } from "vitest";
import {
  changeMcpRemoteSource,
  defaultMcpDraft,
  diffMcpToolInventory,
  enabledMcpToolInventory,
  normalizeMcpImport,
  preparedMcpOAuthPolicy,
  staleDisabledMcpToolNames,
  withMcpToolEnabled
} from "./adminMcpDraft";

describe("adminMcpDraft", () => {
  it("edits an exact-name opt-out policy while new tools remain enabled", () => {
    const draft = defaultMcpDraft();
    const disabled = withMcpToolEnabled(
      withMcpToolEnabled(draft, "Echo", false),
      "remember",
      false
    );

    expect(disabled.disabledToolNames).toEqual(["Echo", "remember"]);
    expect(enabledMcpToolInventory([
      { description: null, name: "Echo" },
      { description: null, name: "echo" },
      { description: null, name: "new_tool" }
    ], disabled.disabledToolNames).map((tool) => tool.name)).toEqual(["echo", "new_tool"]);
    expect(staleDisabledMcpToolNames(disabled, [
      { description: null, name: "Echo" }
    ])).toEqual(["remember"]);

    const enabled = withMcpToolEnabled(disabled, "Echo", true);
    expect(enabled.disabledToolNames).toEqual(["remember"]);
    expect(withMcpToolEnabled(enabled, "remember", true)).not.toHaveProperty("disabledToolNames");
  });

  it("starts as a remote Streamable HTTP draft", () => {
    expect(defaultMcpDraft()).toMatchObject({
      source: { kind: "remote", url: "" },
      transport: "streamable_http"
    });
  });

  it("normalizes a remote mcpServers entry and treats imported headers as write-only shared fields", () => {
    const normalized = normalizeMcpImport(JSON.stringify({
      mcpServers: {
        memory: {
          headers: {
            Authorization: "Bearer secret-value",
            "X-Default-User": "user123"
          },
          url: "https://mcp.example.test/mcp"
        }
      }
    }));

    expect(normalized.name).toBe("memory");
    expect(normalized.draft).toMatchObject({
      auth: { mode: "static" },
      source: { kind: "remote", url: "https://mcp.example.test/mcp" },
      transport: "streamable_http"
    });
    expect(normalized.draft.slots).toEqual([
      expect.objectContaining({ slotKey: "authorization", target: { kind: "header", name: "Authorization" } }),
      expect.objectContaining({ slotKey: "x-default-user", target: { kind: "header", name: "X-Default-User" } })
    ]);
    expect(normalized.sharedValues).toEqual({
      authorization: "Bearer secret-value",
      "x-default-user": "user123"
    });
  });

  it("accepts trailing commas in MCP JSON without changing commas inside strings", () => {
    const normalized = normalizeMcpImport(`{
      "mcpServers": {
        "mem0": {
          "url": "https://mcp.example.test/mcp",
          "headers": {
            "Authorization": "fixture,} value,]",
          },
        },
      },
    }`);

    expect(normalized).toMatchObject({
      name: "mem0",
      draft: {
        auth: { mode: "static" },
        source: { kind: "remote", url: "https://mcp.example.test/mcp" },
        slots: [expect.objectContaining({
          target: { kind: "header", name: "Authorization" }
        })]
      },
      sharedValues: { authorization: "fixture,} value,]" }
    });
  });

  it("keeps malformed JSON and broader JSON5 syntax invalid", () => {
    expect(() => normalizeMcpImport('{"mcpServers": {,}}'))
      .toThrow(/not valid JSON/i);
    expect(() => normalizeMcpImport('{"url": "https://mcp.example.test/mcp" "headers": {}}'))
      .toThrow(/not valid JSON/i);
    expect(() => normalizeMcpImport('{// comment\n"url": "https://mcp.example.test/mcp"}'))
      .toThrow(/not valid JSON/i);
  });

  it("normalizes direct URLs and endpoint JSON", () => {
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
      allowPrivateNetwork: true,
      endpoint: "http://10.0.0.5:8080/mcp",
      name: "Fetch"
    }))).toMatchObject({
      draft: {
        auth: { mode: "none" },
        source: { allowPrivateNetwork: true, kind: "remote", url: "http://10.0.0.5:8080/mcp" },
        transport: "streamable_http"
      },
      name: "Fetch"
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
      ...defaultMcpDraft(),
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

  it("rejects launch commands and command JSON because only remote servers are supported", () => {
    const remoteOnly = "Only remote MCP URLs are supported.";
    for (const pasted of [
      "npx -y @playwright/mcp@latest",
      "uvx mcp-server-fetch",
      "pip install canvas-local-mcp==0.1.1",
      "docker run --rm -i ghcr.io/team/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "mcp.example.test/mcp",
      JSON.stringify({ args: ["mcp-server-fetch"], command: "uvx", name: "Fetch" }),
      JSON.stringify({ mcpServers: { memory: { args: ["-y", "@mem0/mcp-server"], command: "npx", env: { MEM0_API_KEY: "secret" } } } })
    ]) {
      expect(() => normalizeMcpImport(pasted)).toThrow(remoteOnly);
    }
    expect(() => normalizeMcpImport("   ")).toThrow("Paste an MCP URL or JSON configuration.");
    expect(() => normalizeMcpImport('{"mcpServers": {"canvas": {"command": "canvas-local-mcp",}}}\npip install canvas-local-mcp'))
      .toThrow(/not valid JSON/i);
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
