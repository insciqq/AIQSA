import type { ProxyCheckStatus, ProxyProtocol } from "@/lib/contracts/proxies";
import type { McpResolvedAddress } from "../mcp/safeFetch";

/**
 * A request through one proxy, asking what address sites see. The store takes
 * this as a port and runs the address rule first (`checkProxyAddress`), so
 * `pinned` is the only address to connect to.
 */
export type ProxyProbeConnection = Readonly<{
  host: string;
  login: string | null;
  password: string | null;
  pinned: McpResolvedAddress;
  port: number;
  protocol: ProxyProtocol;
}>;

export type ProxyProbeResult = Readonly<
  | { exitAddress: string; ok: true }
  | { code: Exclude<ProxyCheckStatus, "ok">; ok: false }
>;

export type ProxyProbe = (connection: ProxyProbeConnection, signal: AbortSignal) => Promise<ProxyProbeResult>;

/**
 * The installation's probe. Until the proxy transport (`lib/server/webFetch/`)
 * is wired here every check reads as unavailable, never as a pass.
 */
export const probeExitAddress: ProxyProbe = async () => ({ code: "proxy_address_check_unavailable", ok: false });
