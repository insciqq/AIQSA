import type { NetworkProxy, Prisma, PrismaClient } from "@prisma/client";
import {
  PROXY_UNAVAILABLE_CODE,
  type ProxyCheckResult,
  type ProxySharedWire,
  type ProxyWire
} from "@/lib/contracts/proxies";
import {
  commitSelfServiceChange,
  type SelfServiceCallStore,
  type SelfServiceChange,
  type SelfServiceCommitOutcome,
  type SelfServiceScope
} from "../tools/selfServiceCall";
import type { ToolExecutionResult } from "../tools/types";
import {
  assertProxyAddress,
  checkProxy,
  createProxyInTransaction,
  personalProxyScope,
  proxyCheckDeps,
  proxyPatchChanges,
  proxyWriteFailure,
  sameProxyName,
  toProxySharedWire,
  toProxyWire,
  unsealProxyPassword,
  updateProxyInTransaction,
  type ProxyStoreOptions
} from "./store";
import { ProxyError, type ProxyErrorCode, type ProxyFields, type ProxyPatch } from "./validation";

/**
 * The agent's access to proxies (`manage_proxy`): the same validation, limits
 * and writes as the settings routes, committed with the tool call. Only the
 * run's user's own proxies can change. An administrator's is listed and may be
 * read, and is never changed from here; another user's reads as a missing one.
 */

export type AgentProxySelector = Readonly<{ name: string }> | Readonly<{ proxyId: string }>;

export type AgentProxyLists = Readonly<{ administrator: readonly ProxySharedWire[]; personal: readonly ProxyWire[] }>;

export type AgentProxyChangeDone = Readonly<{
  action: "created" | "updated";
  passwordChanged: boolean;
  /** The proxy before an update. */
  previous: ProxyWire | null;
  proxy: ProxyWire;
}>;

export type AgentProxyRefusal =
  /** The name or id is no proxy this user can reach; `lists` names the ones there are. */
  | Readonly<{ code: "proxy_not_found"; lists: AgentProxyLists }>
  | Readonly<{ code: "proxy_administrator_read_only"; proxy: ProxySharedWire }>
  | Readonly<{ code: "proxy_inactive"; proxy: ProxySharedWire }>
  | Readonly<{ code: "proxy_unchanged"; proxy: ProxyWire }>
  | Readonly<{ code: Exclude<ProxyErrorCode, "proxy_not_found"> }>;

export type AgentProxyLookup =
  | Readonly<{ kind: "personal"; proxy: ProxyWire }>
  | Readonly<{ kind: "refused"; value: AgentProxyRefusal }>;

/** One proxy with its password: reaches the model, and only through this tool's read. */
export type AgentProxyConnection = Readonly<{
  active: boolean;
  country: string | null;
  domainHints: readonly string[];
  host: string;
  id: string;
  login: string | null;
  name: string;
  owner: ProxyWire["owner"];
  password: string | null;
  port: number;
  protocol: ProxyWire["protocol"];
}>;

export type AgentProxyService = Readonly<{
  list(): Promise<AgentProxyLists>;
  /** The user's own proxy, for a deletion proposal. */
  findPersonal(selector: AgentProxySelector): Promise<AgentProxyLookup>;
  create(fields: ProxyFields, result: (done: AgentProxyChangeDone) => ToolExecutionResult, signal?: AbortSignal):
    Promise<SelfServiceCommitOutcome<AgentProxyChangeDone, AgentProxyRefusal>>;
  update(selector: AgentProxySelector, patch: ProxyPatch, result: (done: AgentProxyChangeDone) => ToolExecutionResult, signal?: AbortSignal):
    Promise<SelfServiceCommitOutcome<AgentProxyChangeDone, AgentProxyRefusal>>;
  /** A personal proxy, or an administrator's that is switched on, with its password. */
  read(selector: AgentProxySelector): Promise<Readonly<{ connection: AgentProxyConnection; kind: "found" } | { kind: "refused"; value: AgentProxyRefusal }>>;
  test(selector: AgentProxySelector, signal?: AbortSignal): Promise<Readonly<{ check: ProxyCheckResult; kind: "tested"; proxy: ProxyWire } | { kind: "refused"; value: AgentProxyRefusal }>>;
}>;

type ProxyReader = Pick<Prisma.TransactionClient, "networkProxy" | "user">;
type Reach = Readonly<{ administrator: readonly NetworkProxy[]; personal: readonly NetworkProxy[] }>;

async function reachable(db: ProxyReader, userId: string): Promise<Reach> {
  const owner = await db.user.findFirst({ select: { id: true }, where: { id: userId, status: "active" } });
  if (!owner) throw new ProxyError("proxy_unavailable");
  const rows = await db.networkProxy.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { OR: [{ userId }, { userId: null }] } });
  return { administrator: rows.filter((row) => row.userId === null), personal: rows.filter((row) => row.userId !== null) };
}

const listsOf = (reach: Reach): AgentProxyLists => ({ administrator: reach.administrator.map(toProxySharedWire), personal: reach.personal.map(toProxyWire) });

function select(rows: readonly NetworkProxy[], selector: AgentProxySelector): NetworkProxy | undefined {
  return "proxyId" in selector ? rows.find((row) => row.id === selector.proxyId) : rows.find((row) => sameProxyName(row.name, selector.name));
}

/** The user's own proxy that a change may touch, or why not. */
function personalTarget(reach: Reach, selector: AgentProxySelector): Readonly<{ row: NetworkProxy } | { value: AgentProxyRefusal }> {
  const row = select(reach.personal, selector);
  if (row) return { row };
  const shared = select(reach.administrator, selector);
  return { value: shared ? { code: "proxy_administrator_read_only", proxy: toProxySharedWire(shared) } : { code: "proxy_not_found", lists: listsOf(reach) } };
}

const refusedError = (error: unknown): AgentProxyRefusal | null => {
  const failure = proxyWriteFailure(error);
  if (!(failure instanceof ProxyError)) return null;
  return failure.code === "proxy_not_found" ? { code: "proxy_not_found", lists: { administrator: [], personal: [] } } : { code: failure.code };
};

export function createAgentProxyService(input: Readonly<{
  db: Pick<PrismaClient, "$transaction" | "networkProxy" | "user">;
  options?: ProxyStoreOptions;
  scope: SelfServiceScope;
  store: SelfServiceCallStore;
}>): AgentProxyService {
  const { db, scope: { userId } } = input;
  const deps = proxyCheckDeps(input.options);
  const scope = personalProxyScope(userId);

  async function commit(change: (tx: Prisma.TransactionClient) => Promise<SelfServiceChange<AgentProxyChangeDone, AgentProxyRefusal>>):
    Promise<SelfServiceCommitOutcome<AgentProxyChangeDone, AgentProxyRefusal>> {
    try {
      return await commitSelfServiceChange<AgentProxyChangeDone, AgentProxyRefusal>(db, input.store, change);
    } catch (error) {
      // Thrown inside the transaction, so nothing was written and the call stays unsettled.
      const value = refusedError(error);
      if (value) return { kind: "refused", value };
      throw error;
    }
  }

  return {
    async list() {
      return listsOf(await reachable(db, userId));
    },

    async findPersonal(selector) {
      const target = personalTarget(await reachable(db, userId), selector);
      return "row" in target ? { kind: "personal", proxy: toProxyWire(target.row) } : { kind: "refused", value: target.value };
    },

    async create(fields, result, signal) {
      try {
        await assertProxyAddress(deps.checkAddress, fields.host, fields.port, signal);
      } catch (error) {
        const value = refusedError(error);
        if (value) return { kind: "refused", value };
        throw error;
      }
      return commit(async (tx) => {
        const proxy = toProxyWire(await createProxyInTransaction(tx, scope, fields, deps.key));
        const done: AgentProxyChangeDone = { action: "created", passwordChanged: false, previous: null, proxy };
        return { kind: "changed", result: result(done), value: done };
      });
    },

    async update(selector, patch, result, signal) {
      // The address rule may wait on DNS, so it runs before the transaction, and the version keeps what it saw true.
      const seen = select((await reachable(db, userId)).personal, selector) ?? null;
      if (seen) {
        const host = patch.host ?? seen.host;
        const port = patch.port ?? seen.port;
        if (host !== seen.host || port !== seen.port) {
          try {
            await assertProxyAddress(deps.checkAddress, host, port, signal);
          } catch (error) {
            const value = refusedError(error);
            if (value) return { kind: "refused", value };
            throw error;
          }
        }
      }
      return commit(async (tx) => {
        const target = personalTarget(await reachable(tx, userId), selector);
        if (!("row" in target)) return { kind: "refused", value: target.value };
        const current = target.row;
        if (!seen || current.version !== seen.version) return { kind: "refused", value: { code: "proxy_conflict" } };
        if (!proxyPatchChanges(current, patch)) return { kind: "refused", value: { code: "proxy_unchanged", proxy: toProxyWire(current) } };
        const proxy = toProxyWire(await updateProxyInTransaction(tx, scope, current.id, current.version, patch, deps.key));
        const passwordChanged = patch.password !== undefined && (patch.password !== null || current.passwordEnvelope !== null);
        const done: AgentProxyChangeDone = { action: "updated", passwordChanged, previous: toProxyWire(current), proxy };
        return { kind: "changed", result: result(done), value: done };
      });
    },

    async read(selector) {
      const reach = await reachable(db, userId);
      const row = select(reach.personal, selector) ?? select(reach.administrator, selector);
      if (!row) return { kind: "refused", value: { code: "proxy_not_found", lists: listsOf(reach) } };
      if (row.userId === null && !row.active) return { kind: "refused", value: { code: "proxy_inactive", proxy: toProxySharedWire(row) } };
      let password: string | null;
      try {
        password = unsealProxyPassword(row, deps.key());
      } catch {
        return { kind: "refused", value: { code: PROXY_UNAVAILABLE_CODE } };
      }
      const wire = toProxyWire(row);
      return { connection: { active: wire.active, country: wire.country, domainHints: wire.domainHints, host: wire.host, id: wire.id, login: wire.login,
        name: wire.name, owner: wire.owner, password, port: wire.port, protocol: wire.protocol }, kind: "found" };
    },

    async test(selector, signal) {
      const target = personalTarget(await reachable(db, userId), selector);
      if (!("row" in target)) return { kind: "refused", value: target.value };
      try {
        return { check: await checkProxy(db, deps, target.row, signal), kind: "tested", proxy: toProxyWire(target.row) };
      } catch (error) {
        const value = refusedError(error);
        if (value) return { kind: "refused", value };
        throw error;
      }
    }
  };
}
