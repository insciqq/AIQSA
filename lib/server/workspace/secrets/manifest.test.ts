import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseAcceptedWorkspaceSecrets, workspaceSecretEnvironment, workspaceSecretsGuide, WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES } from "./manifest";
import type { AcceptedWorkspaceSecret } from "./store";

describe("accepted Workspace secret installation", () => {
  it("keeps original files separate, names literal, and text accessible without exposing env/key values in the guide", () => {
    const shared = { id: randomUUID(), versionId: randomUUID(), name: "# `name`", description: "```\nPurpose $HOME\n```" };
    const secrets: AcceptedWorkspaceSecret[] = [
      { ...shared, value: { kind: "text", text: "````\nsynthetic text\n````" } },
      { ...shared, id: randomUUID(), value: { kind: "env", entries: [{ name: "SERVICE_TOKEN", value: "'\"$HOME`command`\nline" }] } },
      { ...shared, id: randomUUID(), value: { kind: "file", originalName: "data.json", base64: Buffer.from("file-only-contents").toString("base64") } },
      { ...shared, id: randomUUID(), value: { kind: "ssh_key", privateKey: "key-only-contents", passphrase: "password-only-contents" } }
    ];
    expect(parseAcceptedWorkspaceSecrets(secrets)).toEqual(secrets);
    expect(workspaceSecretEnvironment(secrets)).toEqual({ SERVICE_TOKEN: "'\"$HOME`command`\nline" });
    const guide = workspaceSecretsGuide(secrets);
    expect(guide).toContain("## \\# \\`name\\`");
    expect(guide).toContain("~~~\n````\nsynthetic text\n````\n~~~");
    expect(guide).toContain(`/workspace/secrets/files/${secrets[2]!.id}`);
    expect(guide).toContain(`ssh -F /dev/null -i /workspace/secrets/ssh/${secrets[3]!.id}`);
    expect(guide).toContain("SERVICE_TOKEN");
    expect(guide).not.toMatch(/file-only-contents|key-only-contents|password-only-contents|`command`/);
    expect(workspaceSecretsGuide([])).toContain("No personal secrets");
  });

  // Maximum-size serialization checks byte bounds, not shared CI CPU throughput.
  it.each([
    { name: "many separate delimiters", text: "` ".repeat(128 * 1024) },
    { name: "long runs of both delimiters", text: "`".repeat(128 * 1024) + "~".repeat(128 * 1024) },
    { name: "escaped newlines", text: "\n".repeat(128 * 1024) }
  ])("keeps the largest admitted guide bundle bounded with $name", ({ text }) => {
    const secrets: AcceptedWorkspaceSecret[] = Array.from({ length: 15 }, () => ({
      id: randomUUID(), versionId: randomUUID(), name: "Large literal", description: "Purpose", value: { kind: "text", text }
    }));
    parseAcceptedWorkspaceSecrets(secrets);
    const guide = workspaceSecretsGuide(secrets);
    expect(guide).toContain(text);
    expect(Buffer.byteLength(JSON.stringify({ secrets, guide, environment: {}, runId: "fixture" }))).toBeLessThan(WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES);
  }, 15_000);

  it("rejects duplicate ownership paths, env collisions and oversized admitted sets", () => {
    const secret: AcceptedWorkspaceSecret = { id: randomUUID(), versionId: randomUUID(), name: "Fixture", description: "",
      value: { kind: "env", entries: [{ name: "TOKEN", value: "value" }] } };
    expect(() => parseAcceptedWorkspaceSecrets([secret, secret])).toThrow("workspace_secret_invalid");
    expect(() => parseAcceptedWorkspaceSecrets([secret, { ...secret, id: randomUUID() }])).toThrow("workspace_secret_env_conflict");
    expect(() => parseAcceptedWorkspaceSecrets([{ ...secret, id: "../../escape" }])).toThrow("workspace_secret_invalid");
    expect(() => parseAcceptedWorkspaceSecrets(Array.from({ length: 33 }, (_, index) => ({ ...secret, id: randomUUID(),
      value: { kind: "env", entries: [{ name: `TOKEN_${index}`, value: "value" }] } })))).toThrow("workspace_secret_limit");
  });

  it("admits fifty maximum-size browser states alongside ordinary secrets without putting cookies in the guide", () => {
    const template = JSON.stringify({ cookies: [], origins: [], syntheticPadding: "" });
    const bytes = Buffer.from(template.replace('"syntheticPadding":""', `"syntheticPadding":"${"x".repeat(512 * 1024 - Buffer.byteLength(template))}"`));
    expect(bytes.length).toBe(512 * 1024);
    const sessions: AcceptedWorkspaceSecret[] = Array.from({ length: 50 }, (_, index) => ({ id: randomUUID(), versionId: randomUUID(),
      name: `Site ${index}`, description: "", value: { kind: "browser_session", originalName: `site-${index}.example.json`, base64: bytes.toString("base64") } }));
    const secrets: AcceptedWorkspaceSecret[] = [...sessions, ...Array.from({ length: 32 }, () => ({ id: randomUUID(), versionId: randomUUID(),
      name: "Credential", description: "", value: { kind: "text" as const, text: "synthetic ordinary value" } }))];
    expect(parseAcceptedWorkspaceSecrets(secrets)).toEqual(secrets);
    const guide = workspaceSecretsGuide(secrets);
    expect(guide).toContain("/workspace/secrets/browser/site-49.example.json");
    expect(guide).not.toContain("syntheticPadding");
    expect(Buffer.byteLength(JSON.stringify({ secrets, guide, environment: {}, runId: "fixture" }))).toBeLessThan(WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES);
    expect(() => parseAcceptedWorkspaceSecrets([...sessions, { ...sessions[0]!, id: randomUUID() }])).toThrow("workspace_secret_limit");
    expect(() => parseAcceptedWorkspaceSecrets([sessions[0], { ...sessions[0]!, id: randomUUID() }])).toThrow("workspace_secret_invalid");
  });
});
