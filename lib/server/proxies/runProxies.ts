import { PROXY_UNAVAILABLE_CODE, type ProxyProtocol, type ProxyRunPlan, type ProxyRunPlanEntry } from "@/lib/contracts/proxies";

/**
 * The one place that returns proxy credentials. The store implements
 * `RunProxies`; the Workspace and `fetch_url` take it as a dependency, and
 * tests give them `runProxiesFromRows`. Keep its result out of logs, telemetry
 * and persisted rows. The model may read it by decision (`agent_docs/SECURITY.md`,
 * Proxies), and that goes through the Workspace or a tool, never through here.
 */
export type RunProxyConnection = ProxyRunPlanEntry & Readonly<{
  login: string | null;
  password: string | null;
}>;

export type RunProxyConnections = Readonly<{
  /** Available proxies of the plan, in plan order. */
  connections: readonly RunProxyConnection[];
  /**
   * Proxies of the plan that cannot be used now. A caller treats each as failed
   * on every site (`recordProxyFailure`), so a site that matches one moves on
   * or fails visibly and never goes direct.
   */
  unavailable: readonly Readonly<{ code: typeof PROXY_UNAVAILABLE_CODE; id: string; name: string }>[];
}>;

export interface RunProxies {
  /** A personal proxy of anyone but `userId` counts as missing. */
  load(input: Readonly<{ plan: ProxyRunPlan; userId: string }>): Promise<RunProxyConnections>;
}

/** A proxy as the store reads it now, its password unsealed. */
export type RunProxyRow = Readonly<{
  active: boolean;
  host: string;
  id: string;
  login: string | null;
  password: string | null;
  port: number;
  protocol: ProxyProtocol;
}>;

/**
 * Joins a run's frozen plan with the current rows. A proxy deleted, switched off
 * or moved to another endpoint since admission is unavailable, so a password is
 * only ever sent to the endpoint admission saw, and a replaced password on the
 * same endpoint simply takes effect. Inactive plan entries load nothing: naming
 * one is refused by selection.
 */
export function runProxyConnectionsFromRows(plan: ProxyRunPlan, rows: readonly RunProxyRow[]): RunProxyConnections {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const connections: RunProxyConnection[] = [];
  const unavailable: { code: typeof PROXY_UNAVAILABLE_CODE; id: string; name: string }[] = [];
  for (const entry of plan.entries) {
    if (!entry.active) continue;
    const row = byId.get(entry.id);
    if (row?.active && row.host === entry.host && row.port === entry.port && row.protocol === entry.protocol) {
      connections.push({ ...entry, login: row.login, password: row.password });
    } else {
      unavailable.push({ code: PROXY_UNAVAILABLE_CODE, id: entry.id, name: entry.name });
    }
  }
  return { connections, unavailable };
}

/** A `RunProxies` over fixed rows, whoever asks: for tests. */
export function runProxiesFromRows(rows: readonly RunProxyRow[]): RunProxies {
  return { load: async ({ plan }) => runProxyConnectionsFromRows(plan, rows) };
}
