import { isIP } from "node:net";
import { isProxyCheckStatus, type ProxyCheckStatus, type ProxyProtocol } from "@/lib/contracts/proxies";
import type { McpResolvedAddress } from "../mcp/safeFetch";
import { fetchThroughProxy, WebFetchError } from "../webFetch/transport";

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

/** One fixed public echo of the caller's address, opened only by a proxy's check (`agent_docs/ARCHITECTURE.md`, Proxies). */
const EXIT_ADDRESS_URL = "https://api.ipify.org/?format=text";

function failureStatus(error: unknown): Exclude<ProxyCheckStatus, "ok"> {
  if (error instanceof WebFetchError) {
    if (isProxyCheckStatus(error.code) && error.code !== "ok") return error.code;
    if (error.code === "fetch_timeout") return "proxy_timeout";
  }
  return "proxy_connect_failed";
}

/** The installation's probe: asks the echo through the proxy, whose address the transport checks again before connecting. */
export const probeExitAddress: ProxyProbe = async (connection, signal) => {
  let response: Awaited<ReturnType<typeof fetchThroughProxy>>;
  try {
    response = await fetchThroughProxy(EXIT_ADDRESS_URL, connection, { acceptsContentType: () => true, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { code: failureStatus(error), ok: false };
  }
  const exitAddress = new TextDecoder().decode(response.body).trim();
  return isIP(exitAddress) === 0 ? { code: "proxy_protocol_error", ok: false } : { exitAddress, ok: true };
};
