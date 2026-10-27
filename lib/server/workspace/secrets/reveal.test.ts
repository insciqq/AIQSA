// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkspaceSecretReveal, WORKSPACE_BROWSER_SESSION_VALUE_MAX_BYTES, type WorkspaceSecretValue
} from "@/lib/contracts/workspaceSecrets";
import { encryptSecretEnvelope } from "../../secrets/envelope";
import { revealedWorkspaceSecretValue } from "./reveal";
import { createWorkspaceSecretStore } from "./store";

const key = Buffer.alloc(32, 41);
const browserState = Buffer.from(JSON.stringify({ cookies: [], origins: [] })).toString("base64");

/** Rows as the database holds them, encrypted with the store's own envelope binding. */
function fixture() {
  const rows: { id: string; userId: string; value: Record<string, unknown> }[] = [];
  function save(userId: string, value: WorkspaceSecretValue) {
    const id = randomUUID(), versionId = randomUUID();
    rows.push({ id, userId, value: { id: versionId, secretId: id, userId, kind: value.kind, name: "Synthetic", description: "",
      payloadEnvelope: encryptSecretEnvelope(value, key, { ownerId: userId, purpose: "workspace-user-secret", valueId: versionId },
        { maxPlaintextBytes: WORKSPACE_BROWSER_SESSION_VALUE_MAX_BYTES }) } });
    return { id, versionId };
  }
  const findFirst = vi.fn(async ({ where }: { where: { id: string; userId: string; user: { status: string } } }) =>
    rows.find((row) => row.id === where.id && row.userId === where.userId && where.user.status === "active") ?? null);
  const prisma = { workspaceSecret: { findFirst } } as unknown as PrismaClient;
  return { save, findFirst, prisma, store: createWorkspaceSecretStore(prisma, { key: () => key }) };
}

describe("revealing a saved Workspace secret", () => {
  it("shows each kind's value and only a binary file's size", () => {
    expect(revealedWorkspaceSecretValue({ kind: "text", text: "synthetic token" })).toEqual({ kind: "text", text: "synthetic token" });
    expect(revealedWorkspaceSecretValue({ kind: "env", entries: [{ name: "A", value: "1" }, { name: "B", value: "" }] }))
      .toEqual({ kind: "env", entries: [{ name: "A", value: "1" }, { name: "B", value: "" }] });
    expect(revealedWorkspaceSecretValue({ kind: "ssh_key", privateKey: "synthetic key", passphrase: "" }))
      .toEqual({ kind: "ssh_key", privateKey: "synthetic key", passphrase: null });
    expect(revealedWorkspaceSecretValue({ kind: "ssh_key", privateKey: "synthetic key", passphrase: "synthetic phrase" }))
      .toEqual({ kind: "ssh_key", privateKey: "synthetic key", passphrase: "synthetic phrase" });
    expect(revealedWorkspaceSecretValue({ kind: "file", originalName: "notes.txt", base64: Buffer.from("line\nтекст").toString("base64") }))
      .toEqual({ kind: "file", originalName: "notes.txt", byteSize: 15, text: "line\nтекст" });
    for (const bytes of [Buffer.from([0xff, 0xfe, 0x00, 0x01]), Buffer.from("a\0b")]) {
      expect(revealedWorkspaceSecretValue({ kind: "file", originalName: "blob.bin", base64: bytes.toString("base64") }))
        .toEqual({ kind: "file", originalName: "blob.bin", byteSize: bytes.byteLength, text: null });
    }
    expect(() => revealedWorkspaceSecretValue({ kind: "browser_session", originalName: "shop.example.json", base64: browserState }))
      .toThrow("workspace_secret_not_revealable");
  });

  it("decrypts only the caller's own secret and answers another user's as not found", async () => {
    const { save, store, findFirst } = fixture();
    const owner = `owner-${randomUUID()}`, other = `other-${randomUUID()}`;
    const env = save(owner, { kind: "env", entries: [{ name: "SYNTHETIC_TOKEN", value: "synthetic-value" }] });
    const revealed = await store.reveal(owner, env.id);
    expect(revealed).toEqual({ ...env, value: { kind: "env", entries: [{ name: "SYNTHETIC_TOKEN", value: "synthetic-value" }] } });
    expect(decodeWorkspaceSecretReveal(JSON.parse(JSON.stringify(revealed)), env.id)).toEqual(revealed);
    expect(findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: env.id, userId: owner, user: { status: "active" } } }));
    await expect(store.reveal(other, env.id)).rejects.toMatchObject({ code: "workspace_secret_not_found" });
    await expect(store.reveal(owner, randomUUID())).rejects.toMatchObject({ code: "workspace_secret_not_found" });
  });

  it("refuses a browser session and fails a tampered envelope without content", async () => {
    const { save, store, prisma } = fixture();
    const owner = `owner-${randomUUID()}`;
    const browser = save(owner, { kind: "browser_session", originalName: "shop.example.json", base64: browserState });
    await expect(store.reveal(owner, browser.id)).rejects.toMatchObject({ code: "workspace_secret_not_revealable" });
    const text = save(owner, { kind: "text", text: "synthetic-value" });
    const wrongKey = createWorkspaceSecretStore(prisma, { key: () => Buffer.alloc(32, 7) });
    const failure = await wrongKey.reveal(owner, text.id).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "workspace_secret_unavailable" });
    expect(String((failure as Error).message)).not.toContain("synthetic-value");
  });
});
