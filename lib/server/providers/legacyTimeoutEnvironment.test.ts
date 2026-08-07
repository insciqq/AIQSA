import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetIgnoredProviderTimeoutEnvironmentWarningForTests,
  warnIgnoredProviderTimeoutEnvironmentOnce
} from "./legacyTimeoutEnvironment";

afterEach(() => {
  resetIgnoredProviderTimeoutEnvironmentWarningForTests();
});

describe("removed provider timeout environment controls", () => {
  it("emits one value-free migration warning for non-empty legacy variables", () => {
    const warn = vi.fn();
    const environment = {
      AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS: "secret-value-must-not-be-logged",
      AIQSA_PROVIDER_TIMEOUT_MS: "900000"
    };

    warnIgnoredProviderTimeoutEnvironmentOnce(environment, warn);
    warnIgnoredProviderTimeoutEnvironmentOnce(environment, warn);

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      code: "provider_timeout_environment_ignored",
      variables: [
        "AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS",
        "AIQSA_PROVIDER_TIMEOUT_MS"
      ]
    });
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("900000");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("secret-value-must-not-be-logged");
  });

  it("does not warn for missing or blank legacy variables", () => {
    const warn = vi.fn();

    warnIgnoredProviderTimeoutEnvironmentOnce({
      AIQSA_PROVIDER_TIMEOUT_MS: "  "
    }, warn);

    expect(warn).not.toHaveBeenCalled();
  });
});
