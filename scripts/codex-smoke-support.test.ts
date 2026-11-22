import { describe, expect, it } from "vitest";
import { codexLbOverridesFromConfig, findAuthorizationUrl } from "./codex-smoke-support";

describe("Codex smoke support", () => {
  it("extracts only the reviewed codex-lb provider from user config", () => {
    const result = codexLbOverridesFromConfig(`
model = "gpt-5.6-luna"
model_provider = "codex-lb"
[model_providers.codex-lb]
name = "Codex LB"
base_url = "http://127.0.0.1:2455/v1"
wire_api = "responses"
supports_websockets = false
env_key = "CODEX_LB_API_KEY"
requires_openai_auth = false
[mcp_servers.other]
url = "https://unrelated.example/mcp"
`);
    expect(result.configuredModel).toBe("gpt-5.6-luna");
    expect(result.args.join(" ")).toContain("model_providers.codex-lb.base_url");
    expect(result.args.join(" ")).not.toContain("unrelated.example");
    expect(() => codexLbOverridesFromConfig('model = "x"\nmodel_provider = "openai"\n'))
      .toThrow("codex_smoke_codex_lb_profile_required");
  });

  it("finds only the installation's own consent URL", () => {
    expect(findAuthorizationUrl(
      "Open http://127.0.0.1:3000/oauth/authorize?state=opaque",
      "http://127.0.0.1:3000"
    )).toContain("/oauth/authorize");
    expect(findAuthorizationUrl("Open https://other.example/oauth/authorize", "http://127.0.0.1:3000")).toBeNull();
  });
});
