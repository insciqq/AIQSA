import { randomUUID, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeWorkspaceSecretList, workspaceSecretAssetPath, type WorkspaceSecretValue } from "@/lib/contracts/workspaceSecrets";
import { parseWorkspaceSecretMutation, parseWorkspaceSecretValue } from "./validation";
import { validateWorkspaceSshKey } from "./sshKey";
import { encryptSecretEnvelope } from "../../secrets/envelope";
import { decryptWorkspaceSecret } from "./store";

describe("Workspace secret inputs", () => {
  it("keeps exact multiline and binary values, with explicit preserve/replace", () => {
    const text = "quoted '\" $HOME `touch /tmp/unwanted`\n\tline\r\nПривет";
    const bytes = Buffer.from([0, 255, 13, 10, 96, 36, 92]);
    const values: WorkspaceSecretValue[] = [
      { kind: "text", text }, { kind: "env", entries: [{ name: "SYNTHETIC_TOKEN", value: text }] },
      { kind: "file", originalName: ".credentials", base64: bytes.toString("base64") }
    ];
    for (const value of values) expect(parseWorkspaceSecretValue(value)).toEqual(value);
    const update = { action: "update", id: randomUUID(), expectedVersionId: randomUUID(), name: "Renamed", description: "Purpose",
      value: { action: "preserve" } };
    expect(parseWorkspaceSecretMutation(update)).toEqual(update);
    expect(() => parseWorkspaceSecretMutation({ ...update, value: { action: "preserve", secret: "unexpected" } })).toThrow("workspace_secret_invalid");
    expect(Buffer.from((values[2] as Extract<WorkspaceSecretValue, { kind: "file" }>).base64, "base64")).toEqual(bytes);
  });

  it.each([
    { kind: "env", entries: [{ name: "NOT-ENV", value: "value" }] },
    { kind: "env", entries: [{ name: "HOME\nCOMMAND", value: "value" }] },
    { kind: "env", entries: [{ name: "GIT_SSH_COMMAND", value: "value" }] },
    { kind: "env", entries: [{ name: "TOKEN", value: "a" }, { name: "TOKEN", value: "b" }] },
    { kind: "env", entries: [{ name: "TOKEN", value: "a\0b" }] },
    { kind: "file", originalName: "../escape", base64: "AA==" },
    { kind: "file", originalName: "file", base64: "not base64" },
    { kind: "file", originalName: "file", base64: Buffer.alloc(512 * 1024 + 1).toString("base64") },
    { kind: "text", text: "a".repeat(256 * 1024 + 1) },
    { kind: "text", text: "\ud800" },
    { kind: "text", text: "valid", host: "unexpected" }
  ])("rejects invalid or oversized secret values", (value) => {
    expect(() => parseWorkspaceSecretValue(value)).toThrow("workspace_secret_");
  });

  it("does not derive paths from labels and rejects value-bearing settings responses", () => {
    const id = randomUUID();
    expect(workspaceSecretAssetPath(id, "file")).toBe(`/workspace/secrets/files/${id}`);
    expect(() => workspaceSecretAssetPath("../../project", "ssh_key")).toThrow();
    const summary = { id, versionId: randomUUID(), name: "A secret", description: "", kind: "text", byteSize: 32,
      updatedAt: new Date().toISOString(), envNames: [], originalName: null, sshProtected: false };
    expect(decodeWorkspaceSecretList([summary])).toEqual([summary]);
    expect(decodeWorkspaceSecretList([{ ...summary, text: "raw value" }])).toBeNull();
    expect(decodeWorkspaceSecretList([summary, summary])).toBeNull();
  });

  it("binds encrypted values to their owner, purpose and immutable revision", () => {
    const key = Buffer.alloc(32, 42);
    const value = { kind: "text" as const, text: "synthetic workspace token" };
    const record = { id: randomUUID(), userId: randomUUID(), secretId: randomUUID(), kind: "text", name: "Fixture", description: "",
      byteSize: 50, envNames: [], originalName: null, sshProtected: false, autoSaved: false, checksum: null, createdAt: new Date(), payloadEnvelope: "" };
    record.payloadEnvelope = encryptSecretEnvelope(value, key, { ownerId: record.userId, purpose: "workspace-user-secret", valueId: record.id });
    expect(record.payloadEnvelope).not.toContain(value.text);
    expect(decryptWorkspaceSecret(record, record.userId, key).value).toEqual(value);
    expect(() => decryptWorkspaceSecret(record, randomUUID(), key)).toThrow("workspace_secret_unavailable");
    expect(() => decryptWorkspaceSecret({ ...record, id: randomUUID() }, record.userId, key)).toThrow("workspace_secret_unavailable");
    const otherPurpose = encryptSecretEnvelope(value, key, { ownerId: record.userId, purpose: "provider-credential", valueId: record.id });
    expect(() => decryptWorkspaceSecret({ ...record, payloadEnvelope: otherPurpose }, record.userId, key)).toThrow("workspace_secret_unavailable");
  });

  it("validates private and encrypted keys without a public-key upload or unbounded parsing", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const plain = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const encrypted = privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic key password" }).toString();
    await expect(validateWorkspaceSshKey(plain, "")).resolves.toBeUndefined();
    await expect(validateWorkspaceSshKey(encrypted, "synthetic key password")).resolves.toBeUndefined();
    await expect(validateWorkspaceSshKey(encrypted, "wrong")).rejects.toThrow("workspace_secret_ssh_invalid");
    await expect(validateWorkspaceSshKey(publicKey.export({ type: "spki", format: "pem" }).toString(), "")).rejects.toThrow("workspace_secret_ssh_invalid");
    await expect(validateWorkspaceSshKey("not a private key", "")).rejects.toThrow("workspace_secret_ssh_invalid");
  });
});
