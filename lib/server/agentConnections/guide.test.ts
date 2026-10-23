import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyWithEnv } from "../../../proxy";
import { publicAgentGuide, publicAgentGuideResponse } from "./guide";
import { GET as guideGET } from "../../../app/agents/guide/route";
import { GET as metadataGET } from "../../../app/agents/metadata/route";

const config = vi.hoisted(() => ({ appBaseUrl: "https://canonical.example" }));
vi.mock("../auth/config", () => ({ getAuthConfig: () => config }));

afterEach(() => {
  config.appBaseUrl = "https://canonical.example";
  vi.unstubAllEnvs();
});

describe("Public agent instructions", () => {
  it("returns product Markdown with the configured canonical URLs and independent resources", async () => {
    const response = publicAgentGuideResponse("https://canonical.example/ignored-base-path");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("https://canonical.example/AGENTS.md");
    expect(text).toContain("https://canonical.example/mcp/hub");
    expect(text).toContain("https://canonical.example/mcp/skills");
    expect(text).toContain("https://canonical.example/mcp");
    expect(text).toContain("not a general gateway or prerequisite");
    expect(text).toContain("there is no sync tool");
    expect(text).toContain("--expected-version VERSION");
    expect(text).toContain("--operation-key UUID");
    expect(text).toContain("claude mcp add --transport http --scope user");
    expect(text).toContain("codex mcp login aiqsa-skills --scopes skills:read,skills:write");
    expect(text).not.toMatch(/ignored-base-path|AGENTS.override|DEV_SERVER|agent_docs|<html/);
  });

  it.each(["not a URL", "https://secret:password@host.example", "file:///tmp/private", "https://host.example?token=private", "https://host.example#private"])("fails closed for invalid trusted configuration %s", async (baseUrl) => {
    const response = publicAgentGuideResponse(baseUrl);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Agent connection instructions are unavailable.");
  });

  it("supports loopback and bracketed IPv6 installation addresses", () => {
    expect(publicAgentGuide("http://[::1]:3000")).toContain("'http://[::1]:3000/mcp/skills'");
  });

  it("does not give setup commands for a disabled Hub", () => {
    const guide = publicAgentGuide("https://canonical.example", false);
    expect(guide).toContain("Disabled by this installation’s administrator");
    expect(guide).not.toContain("mcp add aiqsa-hub");
    expect(guide).not.toContain("--scope user aiqsa-hub");
    expect(guide).toContain("mcp add aiqsa-skills");
  });

  it("uses the same public canonical capability projection in route responses", async () => {
    vi.stubEnv("AIQSA_MCP_HUB_ENABLED", "0");
    expect(await metadataGET().json()).toEqual({ origin: "https://canonical.example", hubEnabled: false });
    expect(await guideGET().text()).toContain("Disabled by this installation’s administrator");
    config.appBaseUrl = "https://user:password@canonical.example";
    expect(metadataGET().status).toBe(503);
    expect(guideGET().status).toBe(503);
  });

  it.each(["/AGENTS", "/AGENTS.md", "/agents/guide", "/agents/metadata", "/agents/skills-client.mjs"])("serves %s without a browser session", (path) => {
    const response = proxyWithEnv(new NextRequest(`https://untrusted-host.example${path}`), { AIQSA_APP_BASE_URL: "https://canonical.example" });
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it.each(["/AGENTS-private", "/AGENTS.md/private", "/agents/private", "/agents/guide/private", "/agents/skills-client.mjs/private"])("keeps neighboring %s behind the session boundary", (path) => {
    const response = proxyWithEnv(new NextRequest(`https://canonical.example${path}`), { AIQSA_APP_BASE_URL: "https://canonical.example" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });
});
