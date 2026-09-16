import { describe, expect, it } from "vitest";
import { codexExecArguments, renderCodexManagedProfile, type CodexManagedProfile } from "./codexProfile";

const profile: CodexManagedProfile = {
  contextWindowTokens: 128_000,
  developerInstructions: "Server-owned Workspace instructions",
  gatewayOrigin: "http://agent-gateway:4311",
  maxOutputTokens: 16_000,
  mcpMode: "auto",
  mcpTimeoutSeconds: 120,
  modelId: "deepseek/deepseek-v4.1-flash"
};

describe("managed Codex invocation", () => {
  it.each(["off", "auto", "all"] as const)("keeps selected AIQSA Search available with MCP %s and alongside native search", (mcpMode) => {
    const config = renderCodexManagedProfile({ ...profile, mcpMode, aiqsaSearch: true, standaloneWebSearch: true });
    expect(config).toContain("[mcp_servers.aiqsa]");
    expect(config).toContain('web_search = "live"');
    if (mcpMode === "off") expect(config).toContain('enabled_tools = ["aiqsa_search"]');
    if (mcpMode === "auto") expect(config).toContain('enabled_tools = ["find_tools","call_tool","aiqsa_search"]');
    if (mcpMode === "all") expect(config).not.toContain("enabled_tools");
  });
  it("uses scoped gateway auth and only discovery meta-tools in Auto", () => {
    const config = renderCodexManagedProfile(profile);
    expect(config).toContain('base_url = "http://agent-gateway:4311/v1"');
    expect(config).toContain('url = "http://agent-gateway:4311/mcp"');
    expect(config).toContain('env_key = "AIQSA_AGENT_TOKEN"');
    expect(config).toContain('bearer_token_env_var = "AIQSA_AGENT_TOKEN"');
    expect(config).toContain('enabled_tools = ["find_tools","call_tool"]');
    expect(config).not.toMatch(/api\.deepseek\.com|openrouter\.ai|experimental_bearer_token|api_key\s*=/u);
    // Keys explicitly saved as Workspace secrets must survive Codex's normal
    // child-process environment filtering (in particular *_KEY names).
    expect(config).toContain('ignore_default_excludes = true');
  });

  it("removes MCP entirely for Off and leaves the admitted list to the bridge for All", () => {
    expect(renderCodexManagedProfile({ ...profile, mcpMode: "off" })).not.toContain("[mcp_servers.");
    const all = renderCodexManagedProfile({ ...profile, mcpMode: "all" });
    expect(all).toContain("[mcp_servers.aiqsa]");
    expect(all).not.toContain("enabled_tools");
  });

  it("enables live native search only for an explicitly admitted capability", () => {
    expect(renderCodexManagedProfile(profile)).toContain('web_search = "disabled"');
    expect(renderCodexManagedProfile({ ...profile, nativeWebSearch: true })).toContain('web_search = "live"');
    const standalone = renderCodexManagedProfile({ ...profile, standaloneWebSearch: true });
    expect(standalone).toContain('web_search = "live"');
    expect(standalone).toContain("supports_standalone_web_search = true");
    expect(standalone).toContain("standalone_web_search = true");
    expect(renderCodexManagedProfile({ ...profile, nativeWebSearch: false })).toContain('web_search = "disabled"');
    expect(() => renderCodexManagedProfile({ ...profile, nativeWebSearch: "true" as unknown as boolean }))
      .toThrow("agent_profile_invalid");
  });

  it.each(["https://user:password@example.com", "https://example.com/v1", "https://example.com?key=x", "https://example.com#x", "file:///tmp/proxy"])
    ("rejects a gateway outside the origin-only contract: %s", (gatewayOrigin) => {
      expect(() => renderCodexManagedProfile({ ...profile, gatewayOrigin })).toThrow("agent_profile_invalid");
    });

  it("does not allow model names or instruction text to inject TOML settings", () => {
    expect(() => renderCodexManagedProfile({ ...profile, modelId: 'model"\n[features]\napps=true' })).toThrow("agent_profile_invalid");
    const instructions = 'A "quote"\n[features]\napps=true\n';
    const config = renderCodexManagedProfile({ ...profile, developerInstructions: instructions });
    expect(config.split("\n").filter((line) => line === "[features]")).toHaveLength(1);
    const encoded = config.split("\n").find((line) => line.startsWith("developer_instructions = "))!.slice("developer_instructions = ".length);
    expect(JSON.parse(encoded)).toBe(instructions);
    expect(config).not.toMatch(/^apps=true$/mu);
  });

  it("rejects impossible envelopes instead of silently misconfiguring compaction", () => {
    expect(() => renderCodexManagedProfile({ ...profile, maxOutputTokens: profile.contextWindowTokens })).toThrow("agent_profile_invalid");
    expect(() => renderCodexManagedProfile({ ...profile, contextWindowTokens: NaN })).toThrow("agent_profile_invalid");
    expect(() => renderCodexManagedProfile({ ...profile, mcpTimeoutSeconds: 0 })).toThrow("agent_profile_invalid");
  });

  it("accepts only explicit thread ids, preserves session files and uses stdin", () => {
    const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
    expect(codexExecArguments(id)).toEqual(expect.arrayContaining(["resume", id, "-"]));
    expect(codexExecArguments()).not.toContain("--ephemeral");
    expect(codexExecArguments()).not.toContain("--last");
    for (const bad of ["--last", "../other", "$(cat private)", ""]) expect(() => codexExecArguments(bad)).toThrow("agent_profile_invalid");
  });
});
