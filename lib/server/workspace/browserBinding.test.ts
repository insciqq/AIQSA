import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workspaceBrowserBinding, workspaceBrowserEnvironment, WORKSPACE_BROWSER_DEFAULT_LOCALE } from "./browserBinding";
import { WORKSPACE_BROWSER_LOCALE_ENV, WORKSPACE_BROWSER_TIME_ZONE_ENV } from "./codeMcp";

describe("Workspace browser binding", () => {
  it("freezes the run's admitted zone and the documented default language", () => {
    expect(workspaceBrowserBinding({ timeZone: "Europe/Madrid" })).toEqual({ locale: "en-US", timeZone: "Europe/Madrid" });
    expect(workspaceBrowserBinding({ timeZone: "UTC" })).toEqual({ locale: "en-US", timeZone: "UTC" });
    for (const zone of [undefined, null, "", "Not/A_Zone", "Europe/Madrid; rm -rf /", "x".repeat(80)]) {
      expect(workspaceBrowserBinding({ timeZone: zone })).toEqual({ locale: "en-US", timeZone: "UTC" });
    }
  });

  it("becomes the command environment only in shapes the guest accepts", () => {
    expect(workspaceBrowserEnvironment({ locale: "es-ES", timeZone: "Europe/Madrid" }))
      .toEqual({ [WORKSPACE_BROWSER_LOCALE_ENV]: "es-ES", [WORKSPACE_BROWSER_TIME_ZONE_ENV]: "Europe/Madrid" });
    expect(workspaceBrowserEnvironment(undefined)).toEqual({});
    expect(workspaceBrowserEnvironment({ locale: "es ES", timeZone: "UTC" })).toEqual({});
  });

  it("uses the names and the default the guest helper reads", () => {
    const identity = readFileSync(new URL("../../../ops/workspace-guest/python/aiqsa/browser/_identity.py", import.meta.url), "utf8");
    expect(identity).toContain(`LOCALE_ENV = "${WORKSPACE_BROWSER_LOCALE_ENV}"`);
    expect(identity).toContain(`TIMEZONE_ENV = "${WORKSPACE_BROWSER_TIME_ZONE_ENV}"`);
    expect(identity).toContain(`DEFAULT_LOCALE = "${WORKSPACE_BROWSER_DEFAULT_LOCALE}"`);
  });
});
