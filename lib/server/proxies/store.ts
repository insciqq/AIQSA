import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Prisma, type NetworkProxy, type PrismaClient } from "@prisma/client";
import {
  PROXY_LIMITS,
  isProxyCheckStatus,
  toProxyRunPlan,
  type ProxyCheckResult,
  type ProxyOwner,
  type ProxyProtocol,
  type ProxyRunPlan,
  type ProxySharedWire,
  type ProxyWire
} from "@/lib/contracts/proxies";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { decryptSecretEnvelope, encryptSecretEnvelope, getSecretEncryptionKey } from "../secrets/envelope";
import { checkProxyAddress, type ProxyAddressOptions } from "./address";
import { probeExitAddress, type ProxyProbe, type ProxyProbeResult } from "./probe";
import { runProxyConnectionsFromRows, type RunProxies, type RunProxyRow } from "./runProxies";
import {
  assertProxyCredentials,
  parseProxyCreate,
  parseProxyUpdate,
  ProxyError,
  type ProxyFields,
  type ProxyPatch
} from "./validation";

/**
 * Personal and administrator proxies. The password is sealed like a saved
 * secret's value (`lib/server/secrets/envelope.ts`), bound to its row, and goes
 * one way: no wire shape holds it. It is opened only for a check, for the
 * run-proxies interface and for the agent's `manage_proxy` read
 * (`agent_docs/SECURITY.md`, Proxies). Another user's proxy and a missing one
 * read the same, because every query carries the caller's owner.
 */

const PASSWORD_PURPOSE = "network-proxy-password";
/** The envelope's owner when no user owns the row. */
const ADMINISTRATOR_ENVELOPE_OWNER = "installation-proxies";
const ENVELOPE_OPTIONS = { maxPlaintextBytes: PROXY_LIMITS.passwordMaxLength * 4 } as const;
const CHECK_TIMEOUT_MS = 30_000;

export type ProxyScope = Readonly<{ kind: "administrator" } | { kind: "personal"; userId: string }>;

export const ADMINISTRATOR_PROXY_SCOPE: ProxyScope = Object.freeze({ kind: "administrator" });

export const personalProxyScope = (userId: string): ProxyScope => ({ kind: "personal", userId });

const ownerWhere = (scope: ProxyScope) => ({ userId: scope.kind === "personal" ? scope.userId : null });
const ownerOf = (row: Pick<NetworkProxy, "userId">): ProxyOwner => row.userId === null ? "administrator" : "personal";
const OLDEST_FIRST = [{ createdAt: "asc" }, { id: "asc" }] satisfies Prisma.NetworkProxyOrderByWithRelationInput[];

const foldName = (name: string) => name.toLocaleLowerCase("en-US");

export function sameProxyName(left: string, right: string): boolean {
  return foldName(left.trim()) === foldName(right.trim());
}

function envelopeContext(row: Pick<NetworkProxy, "id" | "userId">) {
  return { ownerId: row.userId ?? ADMINISTRATOR_ENVELOPE_OWNER, purpose: PASSWORD_PURPOSE, valueId: row.id };
}

function sealPassword(password: string, row: Pick<NetworkProxy, "id" | "userId">, key: Buffer): string {
  return encryptSecretEnvelope({ password, version: 1 }, key, envelopeContext(row), ENVELOPE_OPTIONS);
}

/** The row's password, or null without one. Throws on a sealed value that cannot be read. */
export function unsealProxyPassword(row: Pick<NetworkProxy, "id" | "passwordEnvelope" | "userId">, key: Buffer): string | null {
  if (row.passwordEnvelope === null) return null;
  const stored = decryptSecretEnvelope<{ password?: unknown; version?: unknown }>(row.passwordEnvelope, key, envelopeContext(row), ENVELOPE_OPTIONS);
  if (stored.version !== 1 || typeof stored.password !== "string" || !stored.password) throw new ProxyError("proxy_unavailable");
  return stored.password;
}

function lastCheckOf(row: NetworkProxy): ProxyCheckResult | null {
  if (row.lastCheckedAt === null || !isProxyCheckStatus(row.lastCheckStatus)) return null;
  return { checkedAt: row.lastCheckedAt.toISOString(), exitAddress: row.lastExitAddress, status: row.lastCheckStatus };
}

/** What its owner reads. The sealed password stops here. */
export function toProxyWire(row: NetworkProxy): ProxyWire {
  return { active: row.active, country: row.country, domainHints: [...row.domainHints], hasPassword: row.passwordEnvelope !== null,
    host: row.host, id: row.id, lastCheck: lastCheckOf(row), login: row.login, name: row.name, owner: ownerOf(row), port: row.port,
    protocol: row.protocol as ProxyProtocol, version: row.version };
}

/** What a member reads of an administrator proxy: no address, login, password or check. */
export function toProxySharedWire(row: NetworkProxy): ProxySharedWire {
  return { active: row.active, country: row.country, domainHints: [...row.domainHints], id: row.id, name: row.name, owner: "administrator",
    protocol: row.protocol as ProxyProtocol };
}

/**
 * Serializes one owner's changes for the name and count rules. Personal changes
 * also fence an inactive owner. The unique indexes hold the rule against any
 * other writer.
 */
export async function lockProxyOwner(tx: Prisma.TransactionClient, scope: ProxyScope): Promise<void> {
  const owner = scope.kind === "personal" ? scope.userId : "administrator";
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aiqsa:network-proxy:${owner}`}, 0))::text AS "lock"`;
  if (scope.kind !== "personal") return;
  const user = await tx.user.findFirst({ select: { id: true }, where: { id: scope.userId, status: "active" } });
  if (!user) throw new ProxyError("proxy_unavailable");
}

async function assertNameFree(tx: Prisma.TransactionClient, scope: ProxyScope, name: string, exceptId?: string): Promise<void> {
  const rows = await tx.networkProxy.findMany({ select: { id: true, name: true }, where: ownerWhere(scope) });
  if (rows.some((row) => row.id !== exceptId && sameProxyName(row.name, name))) throw new ProxyError("proxy_name_taken");
}

/** A new proxy, in the caller's transaction, after the address rule passed outside it. */
export async function createProxyInTransaction(tx: Prisma.TransactionClient, scope: ProxyScope, fields: ProxyFields, key: () => Buffer): Promise<NetworkProxy> {
  await lockProxyOwner(tx, scope);
  if (await tx.networkProxy.count({ where: ownerWhere(scope) }) >= PROXY_LIMITS.proxiesPerOwner) throw new ProxyError("proxy_limit");
  await assertNameFree(tx, scope, fields.name);
  const row = { id: randomUUID(), ...ownerWhere(scope) };
  return tx.networkProxy.create({ data: { ...row, active: fields.active, country: fields.country, domainHints: [...fields.domainHints],
    host: fields.host, login: fields.login, name: fields.name, port: fields.port, protocol: fields.protocol,
    passwordEnvelope: fields.password === null ? null : sealPassword(fields.password, row, key()) } });
}

/** Whether a patch would change anything. A given password always counts: its old value is not compared. */
export function proxyPatchChanges(row: NetworkProxy, patch: ProxyPatch): boolean {
  return (patch.active !== undefined && patch.active !== row.active) || (patch.country !== undefined && patch.country !== row.country) ||
    (patch.domainHints !== undefined && patch.domainHints.join("\n") !== row.domainHints.join("\n")) ||
    (patch.host !== undefined && patch.host !== row.host) || (patch.login !== undefined && patch.login !== row.login) ||
    (patch.name !== undefined && patch.name !== row.name) || (patch.port !== undefined && patch.port !== row.port) ||
    (patch.protocol !== undefined && patch.protocol !== row.protocol) ||
    (patch.password !== undefined && (patch.password !== null || row.passwordEnvelope !== null));
}

/** Applies a patch while the proxy is at `expectedVersion`. An unchanged patch writes nothing and keeps the version. */
export async function updateProxyInTransaction(tx: Prisma.TransactionClient, scope: ProxyScope, id: string, expectedVersion: number,
  patch: ProxyPatch, key: () => Buffer): Promise<NetworkProxy> {
  await lockProxyOwner(tx, scope);
  const current = await tx.networkProxy.findFirst({ where: { id, ...ownerWhere(scope) } });
  if (!current) throw new ProxyError("proxy_not_found");
  if (current.version !== expectedVersion) throw new ProxyError("proxy_conflict");
  if (!proxyPatchChanges(current, patch)) return current;
  if (patch.name !== undefined) await assertNameFree(tx, scope, patch.name, id);
  const login = patch.login === undefined ? current.login : patch.login;
  const hasPassword = patch.password === undefined ? current.passwordEnvelope !== null : patch.password !== null;
  assertProxyCredentials({ hasLogin: login !== null, hasPassword });
  const { domainHints, password, ...plain } = patch;
  return tx.networkProxy.update({ where: { id }, data: {
    ...plain,
    ...(domainHints ? { domainHints: [...domainHints] } : {}),
    ...(password === undefined ? {} : { passwordEnvelope: password === null ? null : sealPassword(password, current, key()) }),
    version: { increment: 1 }
  } });
}

export async function deleteProxyInTransaction(tx: Prisma.TransactionClient, scope: ProxyScope, id: string, expectedVersion: number): Promise<void> {
  await lockProxyOwner(tx, scope);
  const current = await tx.networkProxy.findFirst({ select: { version: true }, where: { id, ...ownerWhere(scope) } });
  if (!current) throw new ProxyError("proxy_not_found");
  if (current.version !== expectedVersion) throw new ProxyError("proxy_conflict");
  await tx.networkProxy.delete({ where: { id } });
}

/** A unique index caught a name the application's folding missed. */
export function proxyWriteFailure(error: unknown): unknown {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ? new ProxyError("proxy_name_taken") : error;
}

export type ProxyAddressChecker = typeof checkProxyAddress;

/** The address rule for a save: outside any transaction, because it may wait on DNS. */
export async function assertProxyAddress(checkAddress: ProxyAddressChecker, host: string, port: number, signal?: AbortSignal): Promise<void> {
  const options: ProxyAddressOptions = signal ? { signal } : {};
  const check = await checkAddress({ host, port }, options);
  if (!check.ok) throw new ProxyError(check.code);
}

export type ProxyCheckDeps = Readonly<{
  checkAddress: ProxyAddressChecker;
  key: () => Buffer;
  now: () => Date;
  probe: ProxyProbe;
}>;

async function probeOutcome(deps: ProxyCheckDeps, connection: Parameters<ProxyProbe>[0], signal: AbortSignal | undefined): Promise<ProxyProbeResult> {
  const deadline = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  try {
    const result = await deps.probe(connection, signal ? AbortSignal.any([signal, deadline]) : deadline);
    // The address comes back through the proxy, so it is untrusted input too. A zone id is no address a site sees.
    return result.ok && (isIP(result.exitAddress) === 0 || result.exitAddress.includes("%")) ? { code: "proxy_protocol_error", ok: false } : result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return { code: deadline.aborted ? "proxy_timeout" : "proxy_connect_failed", ok: false };
  }
}

/**
 * Checks one proxy and records the result on it. The address rule runs first,
 * so a refused endpoint never receives anything. A result that lost a race with
 * a change of the proxy is returned but not recorded.
 */
export async function checkProxy(db: Pick<PrismaClient, "networkProxy">, deps: ProxyCheckDeps, row: NetworkProxy, signal?: AbortSignal): Promise<ProxyCheckResult> {
  const address = await deps.checkAddress({ host: row.host, port: row.port }, signal ? { signal } : {});
  let outcome: ProxyProbeResult;
  if (!address.ok) {
    outcome = { code: address.code, ok: false };
  } else {
    let password: string | null;
    try {
      password = unsealProxyPassword(row, deps.key());
    } catch {
      throw new ProxyError("proxy_unavailable");
    }
    outcome = await probeOutcome(deps, { host: address.host, login: row.login, password, pinned: address.pinned, port: address.port,
      protocol: row.protocol as ProxyProtocol }, signal);
  }
  const checkedAt = deps.now();
  const status = outcome.ok ? "ok" : outcome.code;
  const exitAddress = outcome.ok ? outcome.exitAddress : null;
  await db.networkProxy.updateMany({ data: { lastCheckedAt: checkedAt, lastCheckStatus: status, lastExitAddress: exitAddress },
    where: { id: row.id, version: row.version } });
  return { checkedAt: checkedAt.toISOString(), exitAddress, status };
}

export type ProxyStoreOptions = Readonly<{
  checkAddress?: ProxyAddressChecker;
  key?: () => Buffer;
  now?: () => Date;
  probe?: ProxyProbe;
}>;

export const proxyCheckDeps = (options: ProxyStoreOptions = {}): ProxyCheckDeps => ({
  checkAddress: options.checkAddress ?? checkProxyAddress,
  key: options.key ?? getSecretEncryptionKey,
  now: options.now ?? (() => new Date()),
  probe: options.probe ?? probeExitAddress
});

export interface ProxyStore {
  /** The caller's own proxies, and what a member sees of the administrators'. */
  listPersonal(userId: string): Promise<Readonly<{ proxies: readonly ProxyWire[]; shared: readonly ProxySharedWire[] }>>;
  listAdministrator(): Promise<readonly ProxyWire[]>;
  create(scope: ProxyScope, input: unknown, signal?: AbortSignal): Promise<ProxyWire>;
  update(scope: ProxyScope, id: string, input: unknown, signal?: AbortSignal): Promise<ProxyWire>;
  remove(scope: ProxyScope, id: string, expectedVersion: number): Promise<void>;
  check(scope: ProxyScope, id: string, signal?: AbortSignal): Promise<Readonly<{ check: ProxyCheckResult; proxy: ProxyWire }>>;
}

export type ProxyStoreDatabase = Pick<PrismaClient, "$transaction" | "networkProxy">;

export function createProxyStore(db: ProxyStoreDatabase, options: ProxyStoreOptions = {}): ProxyStore {
  const deps = proxyCheckDeps(options);

  async function find(scope: ProxyScope, id: string): Promise<NetworkProxy> {
    const row = await db.networkProxy.findFirst({ where: { id, ...ownerWhere(scope) } });
    if (!row) throw new ProxyError("proxy_not_found");
    return row;
  }

  async function write<Value>(change: (tx: Prisma.TransactionClient) => Promise<Value>): Promise<Value> {
    try {
      return await db.$transaction(change);
    } catch (error) {
      throw proxyWriteFailure(error);
    }
  }

  return {
    async listPersonal(userId) {
      const rows = await db.networkProxy.findMany({ orderBy: OLDEST_FIRST, where: { OR: [{ userId }, { userId: null }] } });
      return { proxies: rows.filter((row) => row.userId === userId).map(toProxyWire),
        shared: rows.filter((row) => row.userId === null).map(toProxySharedWire) };
    },

    async listAdministrator() {
      return (await db.networkProxy.findMany({ orderBy: OLDEST_FIRST, where: { userId: null } })).map(toProxyWire);
    },

    async create(scope, input, signal) {
      const fields = parseProxyCreate(input);
      await assertProxyAddress(deps.checkAddress, fields.host, fields.port, signal);
      return toProxyWire(await write((tx) => createProxyInTransaction(tx, scope, fields, deps.key)));
    },

    async update(scope, id, input, signal) {
      const { expectedVersion, patch } = parseProxyUpdate(input);
      const current = await find(scope, id);
      if (current.version !== expectedVersion) throw new ProxyError("proxy_conflict");
      const host = patch.host ?? current.host;
      const port = patch.port ?? current.port;
      if (host !== current.host || port !== current.port) await assertProxyAddress(deps.checkAddress, host, port, signal);
      return toProxyWire(await write((tx) => updateProxyInTransaction(tx, scope, id, expectedVersion, patch, deps.key)));
    },

    async remove(scope, id, expectedVersion) {
      await write((tx) => deleteProxyInTransaction(tx, scope, id, expectedVersion));
    },

    async check(scope, id, signal) {
      const row = await find(scope, id);
      const check = await checkProxy(db, deps, row, signal);
      return { check, proxy: toProxyWire(await find(scope, id)) };
    }
  };
}

/** Freezes a run's plan at admission: the user's own proxies, then the administrators', switched-off ones included. */
export function createProxyRunPlanner(db: Pick<PrismaClient, "networkProxy">): Readonly<{ planForRun(userId: string): Promise<ProxyRunPlan | null> }> {
  return {
    async planForRun(userId) {
      const rows = await db.networkProxy.findMany({ orderBy: OLDEST_FIRST, where: { OR: [{ userId }, { userId: null }] } });
      const personalFirst = [...rows.filter((row) => row.userId !== null), ...rows.filter((row) => row.userId === null)];
      return toProxyRunPlan(personalFirst.map(toProxyWire));
    }
  };
}

/**
 * The store's `RunProxies`: the one place a run's connection gets its password.
 * A personal proxy of anyone but `userId` is not read, so it counts as missing.
 * A password that cannot be opened makes its proxy unavailable, never one sent
 * without credentials.
 */
export function createPrismaRunProxies(db: Pick<PrismaClient, "networkProxy">, options: Readonly<{ key?: () => Buffer }> = {}): RunProxies {
  const key = options.key ?? getSecretEncryptionKey;
  return {
    async load({ plan, userId }) {
      const ids = plan.entries.filter((entry) => entry.active).map((entry) => entry.id);
      const stored = ids.length === 0 ? [] : await db.networkProxy.findMany({ where: { id: { in: ids }, OR: [{ userId }, { userId: null }] } });
      const rows: RunProxyRow[] = [];
      for (const row of stored) {
        try {
          rows.push({ active: row.active, host: row.host, id: row.id, login: row.login, password: unsealProxyPassword(row, key()), port: row.port,
            protocol: row.protocol as ProxyProtocol });
        } catch (error) {
          logEvent("service_operation", { error, subsystem: "configuration", stage: "read", outcome: "failed", code: "proxy_unavailable",
            prisma_code: databaseFailureCode(error) });
        }
      }
      return runProxyConnectionsFromRows(plan, rows);
    }
  };
}
