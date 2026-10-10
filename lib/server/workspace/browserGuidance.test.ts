import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKSPACE_BROWSER_GUIDANCE } from "./browserGuidance";
import { WORKSPACE_GUIDE_FILES } from "./guides";
import { WORKSPACE_BROWSER_SESSION_USER_PATH, workspaceSecretsGuide } from "./secrets/manifest";

/** UI controls that exist nowhere for website sign-in; models invented them before. */
const INVENTED_CONTROLS = /reconnect|reauthori[sz]e|log ?in window|sign-in window|\bSave\/Done\b|\bDone\b/iu;
const DISCLAIMER = "AIQSA has no in-app website login, Reconnect or Reauthorize (MCP Reconnect is unrelated)";

function withoutDisclaimer(text: string): string {
  return text.replaceAll(DISCLAIMER, "");
}

describe("Browser session user path", () => {
  it("names the real Studio import path and denies an in-app login", () => {
    for (const phrase of ["Studio → Secrets", "Add secret", "Browser session", "Edit", "Replace saved value",
      "Playwright storage_state JSON", "next Workspace request"]) {
      expect(WORKSPACE_BROWSER_SESSION_USER_PATH).toContain(phrase);
    }
    expect(WORKSPACE_BROWSER_SESSION_USER_PATH).toContain(DISCLAIMER);
    expect(withoutDisclaimer(WORKSPACE_BROWSER_SESSION_USER_PATH)).not.toMatch(INVENTED_CONTROLS);
  });

  it("reaches the guest browser guide and the secrets guide without other login-button claims", () => {
    const browserGuide = WORKSPACE_GUIDE_FILES.find((file) => file.name === "browser.md")?.content ?? "";
    const secretsGuide = workspaceSecretsGuide([]);
    for (const text of [WORKSPACE_BROWSER_GUIDANCE, browserGuide, secretsGuide]) {
      expect(text.split(WORKSPACE_BROWSER_SESSION_USER_PATH)).toHaveLength(2);
      expect(withoutDisclaimer(text)).not.toMatch(INVENTED_CONTROLS);
    }
  });

  it("uses labels that the Studio Secrets panel actually renders", () => {
    const panel = readFileSync(new URL("../../../features/settings-v2/WorkspaceSecretsPanel.tsx", import.meta.url), "utf8");
    const studio = readFileSync(new URL("../../../features/workspace-v2/WorkspaceWelcomeV2.tsx", import.meta.url), "utf8");
    for (const label of [">Add secret<", "browser_session: \"Browser session\"", ">Edit<", "Replace saved value",
      "Playwright storage_state JSON"]) {
      expect(panel, label).toContain(label);
    }
    expect(studio).toContain("{ id: \"secrets\", label: \"Secrets\"");
  });
});
