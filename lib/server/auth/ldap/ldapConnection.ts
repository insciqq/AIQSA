import { X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import net, { isIP } from "node:net";
import tls from "node:tls";
import { Client, ResultCodeError, type Entry } from "ldapts";
import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import type { McpAddressPolicy, McpResolvedAddress } from "../../mcp/safeFetch";
import { isBlankLdapPassword, type LdapEntry } from "./ldapValues";

type LdapConfig = AuthSignInMethodConfig<"ldap">;

export const LDAP_CONNECT_TIMEOUT_MS = 5_000;
export const LDAP_OPERATION_TIMEOUT_MS = 10_000;

/** How the connection is protected, as the tester reports it. */
export type LdapTransport = "ldaps" | "plain" | "starttls";

/** Content-free reasons a connection could not be used. */
export type LdapConnectionFailure = "connect_failed" | "destination_forbidden" | "tls_failed";

export class LdapConnectionError extends Error {
  constructor(readonly code: LdapConnectionFailure) {
    super(code);
    this.name = "LdapConnectionError";
  }
}

export type LdapSearchRequest = {
  attributes: readonly string[];
  /** Attributes returned as bytes (binary GUIDs). */
  binaryAttributes: readonly string[];
  filter: string;
  scope: "base" | "sub";
  sizeLimit: number;
};

/** One open directory connection. Callers always `close()` it. */
export type LdapSession = {
  /** A simple bind; a blank password is refused before anything is sent. */
  bind(dn: string, password: string): Promise<void>;
  close(): Promise<void>;
  search(base: string, request: LdapSearchRequest): Promise<LdapEntry[]>;
  readonly transport: LdapTransport;
};

export type LdapConnect = (input: { config: LdapConfig; signal?: AbortSignal }) => Promise<LdapSession>;

/** Whether an error is the directory's answer to a request (a result code), not a broken connection. */
export function isLdapResultError(error: unknown): boolean {
  return error instanceof ResultCodeError;
}

/** The connection failure an error stands for; anything unknown is a failed connection. */
export function ldapConnectionFailure(error: unknown): LdapConnectionFailure {
  return error instanceof LdapConnectionError ? error.code : "connect_failed";
}

/** Each pasted PEM block parsed as an X.509 certificate; null when any block is not one. */
export function parseLdapCaCertificates(pem: string): string[] | null {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];
  if (!blocks.length) return null;
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    return null;
  }
  return blocks;
}

type Target = {
  address: string;
  /** The name the certificate must carry: the configured host. */
  identityHost: string;
  port: number;
  secure: boolean;
};

function withTimeout<T>(promise: Promise<T>, milliseconds: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), milliseconds);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

async function defaultLookupHostname(hostname: string): Promise<McpResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
}

/**
 * Resolves the configured host and checks every address against the destination policy before
 * any connection: cloud metadata, link-local and AIQSA's own services are refused, private
 * ranges are allowed. The connection then goes to the checked address only.
 */
async function resolveTarget(
  config: LdapConfig,
  deps: { addressPolicy: McpAddressPolicy; lookupHostname: (hostname: string) => Promise<readonly McpResolvedAddress[]> }
): Promise<Target> {
  const url = new URL(config.url);
  const secure = url.protocol === "ldaps:";
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port ? Number(url.port) : secure ? 636 : 389;
  const family = isIP(hostname);
  let records: readonly McpResolvedAddress[];
  try {
    records = family
      ? [{ address: hostname, family: family === 6 ? 6 : 4 }]
      : await withTimeout(Promise.resolve(deps.lookupHostname(hostname)), LDAP_CONNECT_TIMEOUT_MS, () => new LdapConnectionError("connect_failed"));
  } catch {
    throw new LdapConnectionError("connect_failed");
  }
  if (!records.length || records.some((record) => isIP(record.address) !== record.family)) {
    throw new LdapConnectionError("connect_failed");
  }
  const policyUrl = new URL(`${url.protocol}//${family === 6 ? `[${hostname}]` : hostname}:${port}`);
  for (const record of records) {
    let decision: string | null;
    try {
      decision = await deps.addressPolicy(record, policyUrl);
    } catch {
      decision = "refused";
    }
    if (decision !== null) throw new LdapConnectionError("destination_forbidden");
  }
  return { address: records[0]!.address, identityHost: hostname, port, secure };
}

function tlsOptions(config: LdapConfig): tls.ConnectionOptions {
  const ca = config.caCertificatePem ? parseLdapCaCertificates(config.caCertificatePem) : null;
  if (config.caCertificatePem && !ca) throw new LdapConnectionError("tls_failed");
  return {
    // A pasted CA is the only trust anchor; otherwise the system roots apply.
    ...(ca ? { ca } : {}),
    minVersion: "TLSv1.2",
    rejectUnauthorized: config.tlsRejectUnauthorized
  };
}

/** SNI and identity: the configured host name, or the literal address it is. */
function identityOptions(target: Target): tls.ConnectionOptions {
  return isIP(target.identityHost) ? { host: target.identityHost } : { servername: target.identityHost };
}

/**
 * Whether the certificate names the configured host. With verification on Node already checked
 * chain and name; with it off the name is still checked, so a certificate for another host
 * never passes.
 */
function tlsIdentityHolds(socket: tls.TLSSocket, target: Target, rejectUnauthorized: boolean): boolean {
  if (rejectUnauthorized) return socket.authorized;
  return tls.checkServerIdentity(target.identityHost, socket.getPeerCertificate()) === undefined;
}

function ignoreSocketError(): void {
  // The operation using the socket reports the failure.
}

function connectTransport(target: Target, secureOptions: tls.ConnectionOptions | null): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let tcpConnected = false;
    let settled = false;
    const socket: net.Socket = secureOptions
      ? tls.connect({ ...secureOptions, ...identityOptions(target), host: target.address, port: target.port })
      : net.connect({ host: target.address, port: target.port });
    const fail = (code: LdapConnectionFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new LdapConnectionError(code));
    };
    const onError = () => fail(secureOptions && tcpConnected ? "tls_failed" : "connect_failed");
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ldapts attaches its own handler once it takes the socket; until then an error must not
      // go unhandled.
      socket.off("error", onError);
      socket.on("error", ignoreSocketError);
      resolve(socket);
    };
    const timer = setTimeout(onError, LDAP_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once("connect", () => {
      tcpConnected = true;
      if (!secureOptions) succeed();
    });
    if (secureOptions) {
      socket.once("secureConnect", () => {
        if (tlsIdentityHolds(socket as tls.TLSSocket, target, secureOptions.rejectUnauthorized !== false)) succeed();
        else fail("tls_failed");
      });
    }
    socket.on("error", onError);
  });
}

function entryValues(value: Entry[string]): (string | Uint8Array)[] {
  return (Array.isArray(value) ? value : [value]).map((item) => (typeof item === "string" ? item : new Uint8Array(item)));
}

function toLdapEntry(entry: Entry, binaryAttributes: ReadonlySet<string>): LdapEntry {
  const attributes: Record<string, (string | Uint8Array)[]> = {};
  for (const [name, value] of Object.entries(entry)) {
    if (name === "dn") continue;
    const key = name.toLowerCase();
    const values = entryValues(value);
    // A binary attribute that arrived as text (all bytes happened to be UTF-8) goes back to bytes.
    attributes[key] = binaryAttributes.has(key)
      ? values.map((item) => (typeof item === "string" ? new Uint8Array(Buffer.from(item, "utf8")) : item))
      : values;
  }
  return { attributes, dn: entry.dn };
}

/**
 * Opens directory connections with `ldapts`: the host is resolved and checked by the
 * destination policy, the socket goes to that address only, TLS (LDAPS or StartTLS) verifies
 * the certificate against the pasted CA or the system roots and always checks the host name,
 * and every operation is bounded. A connection that drops is never silently reopened.
 */
export function createLdapConnect(deps: {
  addressPolicy: McpAddressPolicy;
  lookupHostname?: (hostname: string) => Promise<readonly McpResolvedAddress[]>;
}): LdapConnect {
  return async ({ config, signal }) => {
    if (signal?.aborted) throw new LdapConnectionError("connect_failed");
    const target = await resolveTarget(config, {
      addressPolicy: deps.addressPolicy,
      lookupHostname: deps.lookupHostname ?? defaultLookupHostname
    });
    const secureOptions = target.secure || config.startTls ? tlsOptions(config) : null;
    const transportSocket = await connectTransport(target, target.secure ? secureOptions : null);
    const sockets: net.Socket[] = [transportSocket];
    if (signal?.aborted) {
      transportSocket.destroy();
      throw new LdapConnectionError("connect_failed");
    }
    let handedOut = false;
    const handOut = () => {
      // ldapts reconnects a dropped connection on the next operation; this one never does.
      if (handedOut) throw new LdapConnectionError("connect_failed");
      handedOut = true;
      return transportSocket;
    };
    const client = new Client({
      connectTimeout: LDAP_CONNECT_TIMEOUT_MS,
      createConnection: (() => handOut()) as unknown as typeof net.connect,
      createSecureConnection: ((...args: unknown[]) => {
        if (typeof args[0] === "number") return handOut();
        // StartTLS: upgrade the established socket, verifying as for LDAPS.
        const upgraded = tls.connect({ ...(args[0] as tls.ConnectionOptions), ...secureOptions, ...identityOptions(target) });
        sockets.push(upgraded);
        return upgraded;
      }) as unknown as typeof tls.connect,
      strictDN: false,
      timeout: LDAP_OPERATION_TIMEOUT_MS,
      url: config.url
    });
    const destroy = () => {
      for (const socket of sockets) socket.destroy();
    };
    signal?.addEventListener("abort", destroy, { once: true });
    const session: LdapSession = {
      async bind(dn, password) {
        if (isBlankLdapPassword(password)) throw new Error("ldap_blank_password_refused");
        await client.bind(dn, password);
      },
      async close() {
        signal?.removeEventListener("abort", destroy);
        try {
          await withTimeout(client.unbind(), LDAP_CONNECT_TIMEOUT_MS, () => new LdapConnectionError("connect_failed"));
        } catch {
          // Closing never fails a sign-in.
        } finally {
          destroy();
        }
      },
      async search(base, request) {
        const binary = new Set(request.binaryAttributes.map((name) => name.toLowerCase()));
        const result = await client.search(base, {
          attributes: [...request.attributes],
          explicitBufferAttributes: [...request.binaryAttributes],
          filter: request.filter,
          scope: request.scope,
          sizeLimit: request.sizeLimit,
          timeLimit: Math.ceil(LDAP_OPERATION_TIMEOUT_MS / 1_000)
        });
        return result.searchEntries.map((entry) => toLdapEntry(entry, binary));
      },
      transport: target.secure ? "ldaps" : config.startTls ? "starttls" : "plain"
    };

    if (config.startTls) {
      try {
        await withTimeout(
          client.startTLS({ ...secureOptions }),
          LDAP_CONNECT_TIMEOUT_MS,
          () => new LdapConnectionError("tls_failed")
        );
        const upgraded = sockets[1] as tls.TLSSocket | undefined;
        if (!upgraded || !tlsIdentityHolds(upgraded, target, config.tlsRejectUnauthorized)) {
          throw new LdapConnectionError("tls_failed");
        }
      } catch {
        await session.close();
        throw new LdapConnectionError("tls_failed");
      }
    }
    return session;
  };
}
