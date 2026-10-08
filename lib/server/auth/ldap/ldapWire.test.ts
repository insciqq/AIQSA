// @vitest-environment node
import { createServer, type Server, type Socket } from "node:net";
import { BerReader, BerWriter } from "ldapts";
import { afterEach, describe, expect, it } from "vitest";
import { ldapSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { createLdapConnect } from "./ldapConnection";
import { authenticateLdapUser } from "./ldapDirectory";

/**
 * A minimal LDAPv3 responder on loopback, so the real `ldapts` client, the pinned socket and
 * the attribute decoding run end to end: simple binds against fixed credentials, and every
 * subtree search answered with one entry (binary `objectGUID`, `memberOf`, `mail`).
 */
const SERVICE = { dn: "CN=aiqsa-bind,CN=Users,DC=corp,DC=test", password: "service-secret" };
const USER = { dn: "CN=Jane Doe,CN=Users,DC=corp,DC=test", password: "correct horse" };
const GUID = Buffer.from([0x8b, 0x5f, 0x5e, 0x1d, 0x4c, 0x2b, 0x6e, 0x4a, 0x9f, 0x10, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);

type Received = { binds: { dn: string; password: string }[]; searches: Buffer[] };

function response(messageId: number, write: (writer: BerWriter) => void): Buffer {
  const writer = new BerWriter();
  writer.startSequence();
  writer.writeInt(messageId);
  write(writer);
  writer.endSequence();
  return writer.buffer;
}

function result(messageId: number, tag: number, code: number): Buffer {
  return response(messageId, (writer) => {
    writer.startSequence(tag);
    writer.writeEnumeration(code);
    writer.writeString("");
    writer.writeString("");
    writer.endSequence();
  });
}

function entry(messageId: number): Buffer {
  return response(messageId, (writer) => {
    writer.startSequence(0x64);
    writer.writeString(USER.dn);
    writer.startSequence();
    const attribute = (type: string, values: (Buffer | string)[]) => {
      writer.startSequence();
      writer.writeString(type);
      writer.startSequence(0x31);
      for (const value of values) {
        if (typeof value === "string") writer.writeString(value);
        else writer.writeBuffer(value, 0x04);
      }
      writer.endSequence();
      writer.endSequence();
    };
    attribute("objectGUID", [GUID]);
    attribute("mail", ["jane@corp.test"]);
    attribute("displayName", ["Jane Doe"]);
    attribute("memberOf", ["CN=ad-engineers,CN=Users,DC=corp,DC=test", "CN=aiqsa-admins,CN=Users,DC=corp,DC=test"]);
    writer.endSequence();
    writer.endSequence();
  });
}

/** The length of one complete BER message at the start of `buffer`, or null while incomplete. */
function messageLength(buffer: Buffer): number | null {
  if (buffer.length < 2) return null;
  const first = buffer[1]!;
  if (first < 0x80) return buffer.length >= 2 + first ? 2 + first : null;
  const octets = first & 0x7f;
  if (buffer.length < 2 + octets) return null;
  const length = buffer.subarray(2, 2 + octets).reduce((total, byte) => total * 256 + byte, 0);
  return buffer.length >= 2 + octets + length ? 2 + octets + length : null;
}

function handle(socket: Socket, message: Buffer, received: Received): void {
  const reader = new BerReader(message);
  reader.readSequence();
  const messageId = reader.readInt() ?? 0;
  const operation = reader.peek();
  if (operation === 0x60) {
    reader.readSequence(0x60);
    reader.readInt();
    const dn = reader.readString() ?? "";
    const password = reader.readString(0x80) ?? "";
    received.binds.push({ dn, password });
    const ok = (dn === SERVICE.dn && password === SERVICE.password) || (dn === USER.dn && password === USER.password);
    socket.write(result(messageId, 0x61, ok ? 0 : 49));
  } else if (operation === 0x63) {
    received.searches.push(message);
    socket.write(Buffer.concat([entry(messageId), result(messageId, 0x65, 0)]));
  }
}

async function directory(): Promise<{ port: number; received: Received; server: Server }> {
  const received: Received = { binds: [], searches: [] };
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let length = messageLength(pending); length !== null; length = messageLength(pending)) {
        handle(socket, pending.subarray(0, length), received);
        pending = pending.subarray(length);
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { port, received, server };
}

let running: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  running = null;
});

function config(port: number) {
  return ldapSignInConfigSchema.parse({
    attributes: { displayName: "displayName", email: "mail", groups: "memberOf", id: "objectGUID" },
    bindDn: SERVICE.dn,
    url: `ldap://127.0.0.1:${port}`,
    userSearchBase: "CN=Users,DC=corp,DC=test",
    userSearchFilter: "(sAMAccountName={{username}})"
  });
}

describe("LDAP over the wire with ldapts", () => {
  it("binds as the service, searches, binds as the entry and decodes the AD attributes", async () => {
    const { port, received, server } = await directory();
    running = server;

    const outcome = await authenticateLdapUser({
      config: config(port),
      connect: createLdapConnect({ addressPolicy: () => null }),
      password: USER.password,
      secrets: { bindPassword: SERVICE.password },
      username: "*)(uid=*"
    });

    expect(outcome).toEqual({
      kind: "authenticated",
      profile: {
        displayName: "Jane Doe",
        email: "jane@corp.test",
        groups: ["ad-engineers", "aiqsa-admins"],
        subject: "1d5e5f8b-2b4c-4a6e-9f10-0123456789ab"
      }
    });
    expect(received.binds).toEqual([SERVICE, USER]);
    // The escaped name reaches the directory as one equality value, never as filter syntax.
    const search = received.searches[0]!;
    expect(search.includes(Buffer.from("sAMAccountName"))).toBe(true);
    expect(search.includes(Buffer.from("*)(uid=*"))).toBe(true);
    expect(search.includes(Buffer.from("\\2a"))).toBe(false);
  });

  it("turns a refused user bind into a rejection", async () => {
    const { port, received, server } = await directory();
    running = server;

    await expect(authenticateLdapUser({
      config: config(port),
      connect: createLdapConnect({ addressPolicy: () => null }),
      password: "wrong password",
      secrets: { bindPassword: SERVICE.password },
      username: "jdoe"
    })).resolves.toEqual({ kind: "rejected" });
    expect(received.binds.map((bind) => bind.dn)).toEqual([SERVICE.dn, USER.dn]);
  });
});
