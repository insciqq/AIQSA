import { describe, expect, it } from "vitest";
import { codexLbRoute, requirePaidStand, type PaidStand } from "./workspace-user-paid-support";

function fixture(): PaidStand {
  const runtime = {
    AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0", AIQSA_WORKSPACE_MEMORY_MIB: "1024", AIQSA_WORKSPACE_CPUS: "1",
    AIQSA_WORKSPACE_MAX_TOOL_ROUNDS: "12", AIQSA_WORKSPACE_MAX_TOOL_CALLS: "30", AIQSA_WORKSPACE_TURN_TIMEOUT_SECONDS: "600"
  };
  return { name: "aiqsa-ws-paid-abcdef123456", services: {
    app: { image: "fixture", environment: { ...runtime, DATABASE_URL: "postgresql://aiqsa:synthetic@postgres:5432/aiqsa?schema=public" }, ports: [{ target: 3000, published: "30385", host_ip: "127.0.0.1" }] },
    postgres: { image: "fixture", environment: {}, ports: [{ target: 5432, published: "15485", host_ip: "127.0.0.1" }] },
    "workspace-runner": { image: "fixture", environment: { ...runtime } },
    "workspace-maintenance": { image: "fixture", environment: { ...runtime } }
  } };
}

describe("real Workspace qualification authority", () => {
  it("admits only an explicit isolated topology and derives its loopback routes", () => {
    expect(requirePaidStand("DISPOSABLE", fixture())).toEqual({
      project: "aiqsa-ws-paid-abcdef123456", baseUrl: "http://127.0.0.1:30385", databaseUrl: "postgresql://aiqsa:synthetic@127.0.0.1:15485/aiqsa"
    });
    expect(() => requirePaidStand(undefined, fixture())).toThrow("workspace_user_paid_opt_in_required");
  });
  it("admits a loopback TLS proxy only for the exact configured app origin", () => {
    const value = fixture();
    value.services["browser-tls"] = { image: "fixture", environment: {},
      ports: [{ target: 8443, published: "30485", host_ip: "127.0.0.1" }] };
    value.services.app.environment.AIQSA_APP_BASE_URL = "https://127.0.0.1:30485";
    expect(requirePaidStand("DISPOSABLE", value).baseUrl).toBe("https://127.0.0.1:30485");
    value.services.app.environment.AIQSA_APP_BASE_URL = "https://operator.invalid";
    expect(() => requirePaidStand("DISPOSABLE", value)).toThrow("workspace_user_paid_tls_origin_mismatch");
    value.services.app.environment.AIQSA_APP_BASE_URL = "https://127.0.0.1:30485";
    value.services["browser-tls"].ports![0]!.host_ip = "0.0.0.0";
    expect(() => requirePaidStand("DISPOSABLE", value)).toThrow("workspace_user_paid_loopback_required");
    value.services["browser-tls"].ports![0]!.host_ip = "127.0.0.1";
    value.services.app.ports![0]!.host_ip = "0.0.0.0";
    expect(() => requirePaidStand("DISPOSABLE", value)).toThrow("workspace_user_paid_loopback_required");
  });
  it("requires the production deletion worker before spending on scenarios with chat cleanup", () => {
    const value = fixture();
    value.services.app.environment.NODE_ENV = "production";
    expect(() => requirePaidStand("DISPOSABLE", value)).toThrow("workspace_user_paid_deletion_worker_required");
    value.services["memory-worker"] = structuredClone(value.services["workspace-maintenance"]);
    expect(requirePaidStand("DISPOSABLE", value).project).toBe(value.name);
    value.services["memory-worker"].environment.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME = "1";
    expect(() => requirePaidStand("DISPOSABLE", value)).toThrow("workspace_user_paid_runtime_bounds_invalid");
  });
  it.each(["persistent", "public app", "public database", "external database", "fake runtime", "large VM", "parallel CPUs", "unbounded calls", "missing maintenance"])("rejects %s before browser/provider work", kind => {
    const value = fixture();
    if (kind === "persistent") value.name = "aiqsa";
    if (kind === "public app") value.services.app.ports![0]!.host_ip = "0.0.0.0";
    if (kind === "public database") value.services.postgres.ports![0]!.host_ip = "0.0.0.0";
    if (kind === "external database") value.services.app.environment.DATABASE_URL = "postgresql://aiqsa:synthetic@operator.invalid:5432/aiqsa";
    if (kind === "fake runtime") value.services.app.environment.AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME = "1";
    if (kind === "large VM") value.services["workspace-runner"].environment.AIQSA_WORKSPACE_MEMORY_MIB = "4096";
    if (kind === "parallel CPUs") value.services["workspace-runner"].environment.AIQSA_WORKSPACE_CPUS = "4";
    if (kind === "unbounded calls") value.services.app.environment.AIQSA_WORKSPACE_MAX_TOOL_CALLS = "200";
    if (kind === "missing maintenance") delete value.services["workspace-maintenance"];
    expect(() => requirePaidStand("DISPOSABLE", value)).toThrow();
  });
  const config = `model = "gpt-5.6-sol"
model_provider = "codex-lb"
[model_providers.codex-lb]
name = "Codex LB"
base_url = "https://provider.example.test/v1"
wire_api = "responses"
env_key = "CODEX_LB_API_KEY"
requires_openai_auth = false
`;
  it("uses the operator's exact codex-lb route and configured model", () => {
    expect(codexLbRoute(config)).toEqual({ apiRoot: "https://provider.example.test/v1", model: "gpt-5.6-sol" });
  });
  it("uses codex-lb's documented compatible API on the same origin for a CLI profile", () => {
    expect(codexLbRoute(config.replace("https://provider.example.test/v1", "https://provider.example.test:8443/backend-api/codex"))).toEqual({
      apiRoot: "https://provider.example.test:8443/v1", model: "gpt-5.6-sol"
    });
  });
  it.each([
    config.replace('model_provider = "codex-lb"', 'model_provider = "other"'),
    config.replace('wire_api = "responses"', 'wire_api = "chat"'),
    config.replace('model = "gpt-5.6-sol"', 'model = "fake-qsa"'),
    config.replace('env_key = "CODEX_LB_API_KEY"', 'env_key = "OTHER_KEY"')
  ])("rejects substitution of the reviewed provider contract", value => {
    expect(() => codexLbRoute(value)).toThrow();
  });
});
