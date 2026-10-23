// @vitest-environment node
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSecretValue } from "../../../contracts/workspaceSecrets";
import { serializeEvent } from "../../observability/runtime.cjs";
import { encryptSecretEnvelope } from "../../secrets/envelope";
import { MemoryPersistenceError } from "./errors";
import {
  assertMemoryTextFreeOfSavedSecrets,
  memorySavedSecretValues,
  memoryValueContainsSavedSecret,
  type MemorySavedSecretReader
} from "./savedSecrets";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("../../observability", () => ({ logEvent }));

const KEY = randomBytes(32);
const USER = "user-1";
const TOKEN = "tok_demo_7f3a9c21b8e4";

let next = 0;
function row(value: WorkspaceSecretValue, userId = USER, key = KEY) {
  next += 1;
  const id = `20000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  return {
    value: {
      autoSaved: false, byteSize: 10, checksum: null, createdAt: new Date(0), description: "", envNames: [], id,
      kind: value.kind, name: `Secret ${next}`, originalName: null,
      payloadEnvelope: encryptSecretEnvelope(value, key, { ownerId: userId, purpose: "workspace-user-secret", valueId: id }),
      secretId: `10000000-0000-4000-8000-${String(next).padStart(12, "0")}`, sshProtected: false, userId
    }
  };
}

function db(rows: readonly ReturnType<typeof row>[]) {
  return { workspaceSecret: { findMany: vi.fn(async (_query: unknown) => rows) } };
}

/** The fake answers the one query the guard makes. */
function reader(fake: ReturnType<typeof db>): MemorySavedSecretReader {
  return fake as unknown as MemorySavedSecretReader;
}

describe("Memory saved-secret guard", () => {
  it("reads every typed value of the owner's saved secrets, trimmed too, and leaves browser states out", async () => {
    const fake = db([
      row({ kind: "text", text: ` ${TOKEN}\n` }),
      row({ entries: [{ name: "DEMO_API_TOKEN", value: "env-value-123" }, { name: "SHORT", value: "abc" }], kind: "env" }),
      row({ kind: "ssh_key", passphrase: "correct horse", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----" }),
      row({ base64: Buffer.from("file-secret-content").toString("base64"), kind: "file", originalName: "token.txt" })
    ]);
    const values = await memorySavedSecretValues(reader(fake), USER, () => KEY);

    expect(fake.workspaceSecret.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { browserFileName: null, userId: USER }
    }));
    expect(values).toEqual(expect.arrayContaining([
      ` ${TOKEN}\n`, TOKEN, "env-value-123", "correct horse", "file-secret-content"
    ]));
    // Below the masking threshold a value would match ordinary words.
    expect(values).not.toContain("abc");
  });

  it("needs no key when the owner has no saved secrets", async () => {
    const key = vi.fn(() => KEY);
    await expect(memorySavedSecretValues(reader(db([])), USER, key)).resolves.toEqual([]);
    expect(key).not.toHaveBeenCalled();
  });

  it("skips a value it cannot decrypt with a content-free record and keeps checking the rest", async () => {
    logEvent.mockClear();
    const values = await memorySavedSecretValues(reader(db([
      row({ kind: "text", text: "unreadable-value-1" }, USER, randomBytes(32)),
      row({ kind: "text", text: TOKEN })
    ])), USER, () => KEY);

    expect(values).toEqual([TOKEN]);
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_saved_secret_unreadable", count: 1, subsystem: "memory"
    }));
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("unreadable-value-1");
    const [, fields] = logEvent.mock.calls[0]!;
    expect(JSON.parse(serializeEvent("service_operation", fields)!)).toMatchObject({ code: "memory_saved_secret_unreadable", count: 1 });
  });

  it("finds a saved value anywhere in stored text, structured values and keys included", () => {
    const saved = [TOKEN];
    expect(memoryValueContainsSavedSecret(`Мой секрет DEMO_API_TOKEN имеет значение ${TOKEN}.`, saved)).toBe(true);
    expect(memoryValueContainsSavedSecret([{ kind: "explicit_statement", statement: `value ${TOKEN}` }], saved)).toBe(true);
    expect(memoryValueContainsSavedSecret({ [TOKEN]: "label" }, saved)).toBe(true);
    expect(memoryValueContainsSavedSecret("My secret is named DEMO_API_TOKEN.", saved)).toBe(false);
    expect(memoryValueContainsSavedSecret(`value ${TOKEN}`, [])).toBe(false);
  });

  it("refuses a write that repeats a saved value with a stable code and no content in the log", async () => {
    logEvent.mockClear();
    const owner = reader(db([row({ kind: "text", text: TOKEN })]));
    const write = assertMemoryTextFreeOfSavedSecrets(owner, USER, [
      `My test token DEMO_API_TOKEN is ${TOKEN}.`, { statement: "safe" }, "safe excerpt"
    ], () => KEY);

    await expect(write).rejects.toBeInstanceOf(MemoryPersistenceError);
    await expect(write).rejects.toMatchObject({ code: "memory_saved_secret_value" });
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_saved_secret_value", subsystem: "memory"
    }));
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(TOKEN);
    // The stable code survives the log allowlist instead of becoming "unknown".
    for (const [event, fields] of logEvent.mock.calls) {
      expect(event).toBe("service_operation");
      expect(JSON.parse(serializeEvent("service_operation", fields)!)).toMatchObject({ code: fields.code });
    }
    await expect(assertMemoryTextFreeOfSavedSecrets(owner, USER, ["I prefer tea."], () => KEY)).resolves.toBeUndefined();
  });
});
