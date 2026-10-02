import { describe, expect, it } from "vitest";
import { PersonalMcpApiError } from "./personalMcpApi";
import { presentPersonalMcpError, presentPersonalMcpOAuthStartError, type PersonalMcpField } from "./personalMcpErrors";

const fields: PersonalMcpField[] = ["auth", "headerName", "insecure", "name", "token", "url"];

function present(error: unknown, authMode: "none" | "oauth" | "static" = "none", allowed = fields) {
  return presentPersonalMcpError(error, { authMode, fallback: "Fallback.", fields: allowed });
}

describe("personal MCP error copy", () => {
  it.each([
    ["url_invalid", "url", "url"],
    ["insecure_http_acknowledgement_required", "insecureHttpAcknowledged", "insecure"],
    ["header_name_invalid", "auth.headerName", "headerName"],
    ["authorization_required", "values.authorization", "token"]
  ] as const)("places %s next to its field", (code, path, field) => {
    const result = present(new PersonalMcpApiError(code, 422, { issues: [{ code, path }] }), "static");
    expect(Object.keys(result.fields)).toEqual([field]);
    expect(result.general).toBeNull();
  });

  it.each([
    ["mcp_internal_address_forbidden", /belongs to AIQSA's own services/],
    ["mcp_local_network_disabled", /turned off connections to the local network/],
    ["mcp_static_header_reserved", /X-API-Key/]
  ])("maps the validation issue %s inside a failed draft test", (code, copy) => {
    const result = present(new PersonalMcpApiError("mcp_draft_test_failed", 422, { issues: [{ code, path: "source" }] }), "static");
    expect(Object.values(result.fields).join(" ")).toMatch(copy);
    expect(result.general).toBeNull();
  });

  it("puts a rejected credential on the token for static auth and on the auth choice otherwise", () => {
    const rejected = new PersonalMcpApiError("mcp_draft_test_failed", 422, { issues: [{ code: "mcp_authorization_required", path: "source" }] });
    expect(present(rejected, "static").fields).toEqual({ token: "The server rejected this token or API key." });
    expect(present(rejected, "none").fields).toEqual({ auth: "This server requires authorization. Choose OAuth or a token." });
  });

  it.each([
    ["personal_mcp_limit_reached", 409, /25 personal connections/],
    ["mcp_enabled_server_limit_reached", 409, /At most 64 MCP servers/],
    ["mcp_validation_unavailable", 503, /Connection checks are unavailable/],
    ["mcp_encryption_unavailable", 503, /Credential storage is unavailable/],
    ["mcp_draft_test_failed", 422, /could not connect to this server/]
  ])("shows %s as a form-level message", (code, status, copy) => {
    const result = present(new PersonalMcpApiError(code, status));
    expect(result.general).toMatch(copy);
    expect(result.fields).toEqual({});
  });

  it("names the retry time of a rate-limited request", () => {
    expect(present(new PersonalMcpApiError("personal_mcp_rate_limited", 429, { retryAfterSeconds: 120 })).general)
      .toBe("Too many attempts. Try again in 2 minutes.");
    expect(present(new PersonalMcpApiError("personal_mcp_rate_limited", 429)).general).toBe("Too many attempts. Try again in a few minutes.");
  });

  it("falls back to the general message for a field the form does not have and for unknown codes", () => {
    const url = new PersonalMcpApiError("url_invalid", 422, { issues: [{ code: "url_invalid", path: "url" }] });
    expect(present(url, "static", ["token", "headerName"]).general).toMatch(/https:\/\//);
    expect(present(new PersonalMcpApiError("mcp_draft_test_failed", 422, { issues: [{ code: "mcp_remote_validation_failed", path: "validator" }] })).general)
      .toMatch(/could not connect/);
    expect(present(new Error("network"))).toEqual({ fields: {}, general: "Fallback." });
  });

  it("offers Disconnect and add again when the sign-in details changed", () => {
    const changed = Object.assign(new Error("mcp_oauth_policy_forbidden"), { code: "mcp_oauth_policy_forbidden" });
    expect(presentPersonalMcpOAuthStartError(changed)).toMatchObject({ readd: true });
    const limited = Object.assign(new Error("personal_mcp_rate_limited"), { code: "personal_mcp_rate_limited", retryAfterSeconds: 30 });
    expect(presentPersonalMcpOAuthStartError(limited)).toEqual({ readd: false, text: "Too many authorization attempts. Try again in 30 seconds." });
  });
});
