// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maintenanceFailureCode } from "./maintenance-observability";
import { serializeEvent } from "../lib/server/observability/runtime.cjs";

const fixture = vi.hoisted(() => ({ disconnect: vi.fn() }));
vi.mock("./worker-bootstrap.cjs", () => ({}));
vi.mock("../lib/server/prisma", () => ({ prisma: { $disconnect: fixture.disconnect } }));
vi.mock("../lib/server/uploads/storage", () => ({ createS3StorageAdapter: () => ({}) }));

const originalArgv = process.argv;
const originalExit = process.exitCode;
const lines: string[] = [];
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  lines.length = 0; process.exitCode = undefined;
  process.argv = [originalArgv[0], "maintenance-fixture"];
  fixture.disconnect.mockResolvedValue(undefined);
  for (const key of ["ANTHROPIC_API_KEY", "CUSTOM_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "_DEV_CUSTOM_OPENAI_API_KEY", "AIQSA_RESTORE_RECONCILIATION", "AIQSA_RESTORE_NETWORK_ISOLATED"]) vi.stubEnv(key, "");
  vi.spyOn(process.stdout, "write").mockImplementation(line => { lines.push(String(line)); return true; });
});
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExit; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("maintenance guard diagnostics", () => {
  it("keeps restore authorization and forbidden-credential failures distinct", async () => {
    await import("./memory-restore-reconcile");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: "memory_restore_reconciliation_not_authorized" });
    expect(process.exitCode).toBe(1);
    vi.resetModules(); fixture.disconnect.mockClear(); lines.length = 0;
    vi.stubEnv("AIQSA_RESTORE_RECONCILIATION", "YES"); vi.stubEnv("AIQSA_RESTORE_NETWORK_ISOLATED", "YES");
    vi.stubEnv("OPENAI_API_KEY", "PRIVATE_CREDENTIAL_CANARY");
    await import("./memory-restore-reconcile");
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ code: "memory_restore_provider_credentials_forbidden_openai_api_key" });
    expect(lines.join("")).not.toContain("PRIVATE_CREDENTIAL_CANARY");
  });

  it("rejects arbitrary exception text and getters while serializing all reviewed guard codes", () => {
    const fallback = "memory_restore_reconciliation_failed";
    const getter = vi.fn(() => { throw new Error("PRIVATE_GETTER"); });
    const error = Object.defineProperty(new Error(), "message", { get: getter });
    expect(maintenanceFailureCode(error, fallback)).toBe(fallback);
    expect(getter).not.toHaveBeenCalled();
    for (const message of ["private_operator_note", "memory_restore_reconciliation_pending PRIVATE_CANARY", "memory_restore_provider_credentials_forbidden_private_key"]) {
      expect(maintenanceFailureCode(new Error(message), fallback)).toBe(fallback);
    }
    for (const suffix of ["reconciliation_pending", "reconciliation_not_authorized", "endpoint_invalid", "endpoint_not_isolated", "service_identity_invalid",
      ...["anthropic_api_key", "custom_openai_api_key", "deepseek_api_key", "gemini_api_key", "google_api_key", "openai_api_key", "openrouter_api_key", "_dev_custom_openai_api_key"].map(key => `provider_credentials_forbidden_${key}`)]) {
      const code = `memory_restore_${suffix}`;
      const value = maintenanceFailureCode(new Error(code), fallback);
      expect(JSON.parse(serializeEvent("runtime_lifecycle", { subsystem: "memory", stage: "reconcile", outcome: "failed", code: value })!)).toMatchObject({ code });
    }
  });
});
