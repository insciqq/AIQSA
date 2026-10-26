import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES, WORKSPACE_SECRET_ENV_MAX_BYTES
} from "@/lib/contracts/workspaceSecrets";
import {
  parseAcceptedWorkspaceSecrets, workspaceSecretEnvironment, workspaceSecretsGuide, workspaceSecretVariables,
  WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES, WORKSPACE_SECRETS_REQUEST_MAX_BYTES, WORKSPACE_TEXT_SECRET_VARIABLE_MAX_BYTES
} from "./manifest";
import type { AcceptedWorkspaceSecret } from "./store";

const saved = (name: string, value: AcceptedWorkspaceSecret["value"]): AcceptedWorkspaceSecret =>
  ({ id: randomUUID(), versionId: randomUUID(), name, description: "", value });

/** A secret as the run's admitted list describes it, with the size the store records (`createWorkspaceSecretRevision`). */
const stored = ({ name, value }: AcceptedWorkspaceSecret) => ({ byteSize: Buffer.byteLength(JSON.stringify(value), "utf8"),
  envNames: value.kind === "env" ? value.entries.map((entry) => entry.name) : [], kind: value.kind, name });

describe("Workspace variables of saved secrets", () => {
  it("sets a text secret named like a variable under that name in every command, and the guide says which", () => {
    const secrets = [
      saved("API access", { kind: "env", entries: [{ name: "SERVICE_TOKEN", value: "synthetic-service" }] }),
      saved("DEMO_API_TOKEN", { kind: "text", text: "synthetic-demo-token" }),
      saved("Notes", { kind: "text", text: "synthetic note" }),
      saved("github_token", { kind: "text", text: "synthetic lowercase" }),
      saved("SSH_AUTH_SOCK", { kind: "text", text: "synthetic reserved" }),
      saved("AIQSA_BROWSER_SESSIONS_DIR", { kind: "text", text: "/workspace/project" })
    ];
    expect(parseAcceptedWorkspaceSecrets(secrets)).toEqual(secrets);
    expect(workspaceSecretEnvironment(secrets)).toEqual({ DEMO_API_TOKEN: "synthetic-demo-token", SERVICE_TOKEN: "synthetic-service" });
    expect(workspaceSecretVariables(secrets.map(stored))).toEqual([["SERVICE_TOKEN"], ["DEMO_API_TOKEN"], [], [], [], []]);
    const guide = workspaceSecretsGuide(secrets);
    expect(guide).toContain("## DEMO\\_API\\_TOKEN\n\nEnvironment variable (the value is already in command environments): `DEMO_API_TOKEN`\n" +
      "Text secret:\n```\nsynthetic-demo-token\n```");
    expect(guide).toContain("## Notes\n\nText secret:\n```\nsynthetic note\n```");
    expect(guide).toContain("## github\\_token\n\nText secret:\n```\nsynthetic lowercase\n```");
    expect(guide).toContain("## SSH\\_AUTH\\_SOCK\n\nNot an environment variable here; use the text below.\nText secret:");
  });

  it("keeps an env secret's variable over a text secret of that name and leaves two text secrets of one name out", () => {
    const secrets = [
      saved("SHARED_TOKEN", { kind: "text", text: "synthetic text" }),
      saved("Shared", { kind: "env", entries: [{ name: "SHARED_TOKEN", value: "synthetic env" }] }),
      saved("TWIN", { kind: "text", text: "synthetic first" }),
      saved("TWIN", { kind: "text", text: "synthetic second" })
    ];
    expect(workspaceSecretEnvironment(secrets)).toEqual({ SHARED_TOKEN: "synthetic env" });
    expect(workspaceSecretVariables(secrets.map(stored))).toEqual([[], ["SHARED_TOKEN"], [], []]);
    expect(workspaceSecretsGuide(secrets).match(/Not an environment variable here/gu)).toHaveLength(3);
  });

  it("bounds a text variable like one env value, and the saved environment by its budget, as the stored sizes predict", () => {
    // A text value's stored size is its JSON plus 25 bytes of kind.
    const largest = saved("LARGEST", { kind: "text", text: "x".repeat(WORKSPACE_TEXT_SECRET_VARIABLE_MAX_BYTES - 25) });
    const larger = saved("LARGER", { kind: "text", text: "x".repeat(WORKSPACE_TEXT_SECRET_VARIABLE_MAX_BYTES - 24) });
    expect(Object.keys(workspaceSecretEnvironment([largest, larger]))).toEqual(["LARGEST"]);
    // Env secrets use most of the budget; the first text variable still fits, the next does not.
    const env = saved("Bulk", { kind: "env", entries: Array.from({ length: 8 }, (_, index) => ({ name: `BULK_${index}`, value: "v".repeat(16_000) })) });
    const small = saved("SMALL", { kind: "text", text: "synthetic small" });
    const medium = saved("MEDIUM", { kind: "text", text: "m".repeat(4_000) });
    const bounded = [env, small, medium];
    expect(parseAcceptedWorkspaceSecrets(bounded)).toEqual(bounded);
    expect(Object.keys(workspaceSecretEnvironment(bounded))).toEqual([...Array.from({ length: 8 }, (_, index) => `BULK_${index}`), "SMALL"]);
    expect(workspaceSecretVariables(bounded.map(stored)).map((names) => names.length)).toEqual([8, 1, 0]);
    // Long names and escape-heavy values: the environment the guest receives stays within its bound.
    const many = Array.from({ length: 32 }, (_, index) =>
      saved(`T${String(index).padStart(2, "0")}${"_".repeat(117)}`, { kind: "text", text: "\n".repeat(8_000) }));
    expect(parseAcceptedWorkspaceSecrets(many)).toEqual(many);
    const environment = workspaceSecretEnvironment(many);
    expect(Object.keys(environment).length).toBeGreaterThan(0);
    expect(Object.keys(environment).length).toBeLessThan(many.length);
    expect(Buffer.byteLength(JSON.stringify(environment), "utf8")).toBeLessThanOrEqual(WORKSPACE_SECRET_ENV_MAX_BYTES);
    expect(workspaceSecretVariables(many.map(stored)).flat()).toEqual(Object.keys(environment));
  });
});

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

  it("fits the full browser aggregate plus maximum ordinary secrets within the runner request and guest input", () => {
    const template = JSON.stringify({ cookies: [], origins: [], syntheticPadding: "" });
    const bytes = Buffer.from(template.replace('"syntheticPadding":""', `"syntheticPadding":"${"x".repeat(WORKSPACE_BROWSER_SESSION_MAX_BYTES - Buffer.byteLength(template))}"`));
    expect(bytes.length).toBe(WORKSPACE_BROWSER_SESSION_MAX_BYTES);
    const base64 = bytes.toString("base64");
    // Control characters make each description's JSON escaping as large as the contract allows.
    const description = "\u0001".repeat(2000);
    const sessions: AcceptedWorkspaceSecret[] = Array.from({ length: WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES / WORKSPACE_BROWSER_SESSION_MAX_BYTES },
      (_, index) => ({ id: randomUUID(), versionId: randomUUID(), name: `Site ${index}`, description,
        value: { kind: "browser_session", originalName: `site-${index}.example.json`, base64 } }));
    const text = "\n".repeat(128 * 1024);
    const ordinary: AcceptedWorkspaceSecret[] = Array.from({ length: 15 }, () => ({ id: randomUUID(), versionId: randomUUID(),
      name: "Large literal", description, value: { kind: "text" as const, text } }));
    const secrets = [...sessions, ...ordinary];
    expect(parseAcceptedWorkspaceSecrets(secrets)).toEqual(secrets);
    const request = Buffer.byteLength(JSON.stringify({ secrets, modelRunId: randomUUID(), runtimeSandboxId: "fixture", operation: { owner: "run:fixture", generation: 1 } }));
    expect(request).toBeLessThan(WORKSPACE_SECRETS_REQUEST_MAX_BYTES);
    const guide = workspaceSecretsGuide(secrets);
    expect(Buffer.byteLength(JSON.stringify({ secrets, environment: workspaceSecretEnvironment(secrets), guide, runId: "fixture" })))
      .toBeLessThan(WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES);
    const small: AcceptedWorkspaceSecret = { id: randomUUID(), versionId: randomUUID(), name: "Small", description: "",
      value: { kind: "browser_session", originalName: "small.example.json", base64: Buffer.from(template).toString("base64") } };
    expect(() => parseAcceptedWorkspaceSecrets([...sessions, small])).toThrow("workspace_secret_limit");
  }, 30_000);
});
