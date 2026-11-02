import type { ProxyOwner, ProxySelectionFailureCode } from "@/lib/contracts/proxies";

/**
 * Which proxy opens a site. Pure: no clock, randomness or I/O, and the rotation
 * state goes in and comes out as plain JSON. The Workspace forwarder implements
 * the same rules in Python; both pass `lib/domain/proxySelection.vectors.json`,
 * so a rule changes there and in both languages together.
 *
 * Order: an explicit choice wins (direct included, and a named proxy opens any
 * site, because a hint is advice). Otherwise the matching active proxies form
 * tiers, the most specific hint first and personal before administrator within
 * a hint. Rotation runs inside a tier; a site stays on its proxy within a chat;
 * a failure moves on, through later tiers too. With every match failed the
 * selection fails visibly and never goes direct. With no matching hint, a host
 * follows its site's active, unfailed proxy; without one it goes direct.
 */

export type ProxySelectionEntry = Readonly<{
  active: boolean;
  /** Canonical hints (`normalizeProxyHint`), as the run plan holds them. */
  domainHints: readonly string[];
  id: string;
  name: string;
  owner: ProxyOwner;
}>;

/** Keys always hold a dot, so none can be an object's own special name. */
export type ProxyRotationState = Readonly<{
  /** Next index per tier, `<hint>|<owner>`. */
  cursors: Readonly<Record<string, number>>;
  /** Proxies that failed per site, in order of failure. */
  failed: Readonly<Record<string, readonly string[]>>;
  /** The proxy each site stays on. */
  sites: Readonly<Record<string, string>>;
}>;

export const EMPTY_PROXY_ROTATION_STATE: ProxyRotationState = Object.freeze({
  cursors: Object.freeze({}),
  failed: Object.freeze({}),
  sites: Object.freeze({})
});

/** `ref` is a proxy id or a name in any case. */
export type ProxyExplicitChoice = Readonly<{ kind: "direct" } | { kind: "proxy"; ref: string }>;

export type ProxySelection = Readonly<
  | { kind: "direct"; reason: "explicit" | "no_match" }
  | { kind: "failed"; code: ProxySelectionFailureCode; tried: readonly string[] }
  /** `explicit` was named, `hint` is a new choice, `site` kept the site's proxy. */
  | { hint: string | null; kind: "proxy"; proxyId: string; reason: "explicit" | "hint" | "site" }
>;

const HOST_MAX_LENGTH = 253;
/** Longer text cannot shorten into a hostname by more than this; refused before any parsing. */
const RAW_MAX_LENGTH = HOST_MAX_LENGTH * 4;
/** Underscores occur in real hostnames, and a site that loses its hint must not go direct. */
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u;
/** What WHATWG URL parsing reads as an IPv4 address, whatever comes before it. */
const NUMERIC_LAST_LABEL = /^(?:\d+|0x[0-9a-f]*)$/u;
const ASCII_ONLY = /^[\u0000-\u007f]*$/u;
/** Would be read as URL syntax instead of a hostname when the IDNA conversion parses it. */
const URL_SYNTAX = /[\s/\\?#@:[\]%]/u;
/** The second level of a public zone such as `co.uk` or `com.kz`, under a two-letter country. */
const PUBLIC_SECOND_LEVEL: ReadonlySet<string> = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

function asciiHostname(value: string): string | null {
  let host = value.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!ASCII_ONLY.test(host)) {
    if (URL_SYNTAX.test(host)) return null;
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      return null;
    }
  }
  if (!host || host.length > HOST_MAX_LENGTH) return null;
  const labels = host.split(".");
  if (!labels.every((label) => LABEL.test(label))) return null;
  return NUMERIC_LAST_LABEL.test(labels[labels.length - 1]!) ? null : host;
}

function trimmedInput(value: unknown): string | null {
  if (typeof value !== "string" || value.length > RAW_MAX_LENGTH) return null;
  return value.trim() || null;
}

/**
 * The canonical hint, or null when the text is not one. One label is a zone and
 * keeps its dot (`.kz`, and `kz` means the same); more labels stand without one
 * (`ozon.ru`, and `.ozon.ru` means the same). Lower case, IDNA ASCII, no
 * trailing dot; no scheme, port, path, wildcard or IP address.
 */
export function normalizeProxyHint(value: unknown): string | null {
  const text = trimmedInput(value);
  if (text === null) return null;
  const domain = asciiHostname(text.startsWith(".") ? text.slice(1) : text);
  if (domain === null) return null;
  return domain.includes(".") ? domain : `.${domain}`;
}

/** A hostname in the form hints match, or null: IP addresses and single labels are no domains and match no hint. */
export function normalizeProxySiteHost(value: unknown): string | null {
  const text = trimmedInput(value);
  if (text === null) return null;
  const host = asciiHostname(text);
  return host !== null && host.includes(".") ? host : null;
}

/**
 * The site a normalized host belongs to: what stays on one proxy, because a
 * site's subdomains share its sign-ins and its bot checks. The last two labels,
 * or three under a public second level. No public suffix list exists on both
 * sides; a zone it misses only shares a proxy between unrelated sites.
 */
export function proxySiteKey(host: string): string {
  const labels = host.split(".");
  const count = labels.length >= 3 && labels[labels.length - 1]!.length === 2 &&
    PUBLIC_SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-count).join(".");
}

function hintDomain(hint: string): string {
  return hint.startsWith(".") ? hint.slice(1) : hint;
}

function hintMatches(hint: string, host: string): boolean {
  const domain = hintDomain(hint);
  return host === domain || host.endsWith(`.${domain}`);
}

function specificity(hint: string): number {
  return hintDomain(hint).split(".").length;
}

function bestHint(hints: readonly string[], host: string): string | null {
  let best: string | null = null;
  for (const hint of hints) {
    if (hintMatches(hint, host) && (best === null || specificity(hint) > specificity(best))) best = hint;
  }
  return best;
}

type ProxyTier = Readonly<{ hint: string; key: string; members: readonly string[]; owner: ProxyOwner }>;

/** Two matching hints of equal length are the same string, so one hint and owner name a tier. */
function candidateTiers(entries: readonly ProxySelectionEntry[], host: string): ProxyTier[] {
  const tiers = new Map<string, { hint: string; key: string; members: string[]; owner: ProxyOwner }>();
  for (const entry of entries) {
    if (!entry.active) continue;
    const hint = bestHint(entry.domainHints, host);
    if (hint === null) continue;
    const key = `${hint}|${entry.owner}`;
    const tier = tiers.get(key);
    if (tier) tier.members.push(entry.id);
    else tiers.set(key, { hint, key, members: [entry.id], owner: entry.owner });
  }
  const ownerRank = (owner: ProxyOwner) => (owner === "personal" ? 0 : 1);
  return [...tiers.values()].sort((left, right) =>
    specificity(right.hint) - specificity(left.hint) || ownerRank(left.owner) - ownerRank(right.owner));
}

function withoutKey<Value>(record: Readonly<Record<string, Value>>, key: string): Record<string, Value> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function explicitSelection(entries: readonly ProxySelectionEntry[], ref: string): ProxySelection {
  const lowered = ref.toLowerCase();
  const named = entries.filter((entry) => entry.name.toLowerCase() === lowered)
    .sort((left, right) => Number(right.owner === "personal") - Number(left.owner === "personal"));
  const entry = entries.find((candidate) => candidate.id === ref) ?? named.find((candidate) => candidate.active) ?? named[0];
  if (!entry) return { code: "proxy_not_found", kind: "failed", tried: [] };
  if (!entry.active) return { code: "proxy_inactive", kind: "failed", tried: [] };
  return { hint: null, kind: "proxy", proxyId: entry.id, reason: "explicit" };
}

/**
 * One decision and the state after it; the input state is never changed. An
 * explicit choice reads and writes no state, and is never moved on from: the
 * caller reports its failure. A proxy of the plan that cannot be loaded counts
 * as failed (`recordProxyFailure`), never as inactive, so a host with matching
 * hints cannot go direct.
 */
export function selectProxy(input: Readonly<{
  entries: readonly ProxySelectionEntry[];
  explicit?: ProxyExplicitChoice | null;
  host: string;
  state: ProxyRotationState;
}>): Readonly<{ selection: ProxySelection; state: ProxyRotationState }> {
  const { entries, explicit, state } = input;
  if (explicit?.kind === "direct") return { selection: { kind: "direct", reason: "explicit" }, state };
  if (explicit?.kind === "proxy") return { selection: explicitSelection(entries, explicit.ref), state };

  const host = normalizeProxySiteHost(input.host);
  if (host === null) return { selection: { kind: "direct", reason: "no_match" }, state };

  const tiers = candidateTiers(entries, host);
  const site = proxySiteKey(host);
  const failed = state.failed[site] ?? [];
  const stayedOn = state.sites[site];
  if (tiers.length === 0) {
    if (stayedOn !== undefined && !failed.includes(stayedOn) && entries.some((entry) => entry.id === stayedOn && entry.active)) {
      return { selection: { hint: null, kind: "proxy", proxyId: stayedOn, reason: "site" }, state };
    }
    return { selection: { kind: "direct", reason: "no_match" }, state };
  }
  const stayedTier = stayedOn === undefined || failed.includes(stayedOn)
    ? undefined
    : tiers.find((tier) => tier.members.includes(stayedOn));
  if (stayedOn !== undefined && stayedTier) {
    return { selection: { hint: stayedTier.hint, kind: "proxy", proxyId: stayedOn, reason: "site" }, state };
  }

  for (const tier of tiers) {
    const size = tier.members.length;
    const start = (state.cursors[tier.key] ?? 0) % size;
    for (let offset = 0; offset < size; offset += 1) {
      const proxyId = tier.members[(start + offset) % size]!;
      if (failed.includes(proxyId)) continue;
      return {
        selection: { hint: tier.hint, kind: "proxy", proxyId, reason: "hint" },
        state: {
          ...state,
          cursors: { ...state.cursors, [tier.key]: (start + offset + 1) % size },
          sites: { ...state.sites, [site]: proxyId }
        }
      };
    }
  }

  // Reported once: the site's next request tries again, because no clock can
  // say when a failed proxy has recovered.
  return {
    selection: { code: "proxy_all_failed", kind: "failed", tried: tiers.flatMap((tier) => tier.members) },
    state: { ...state, failed: withoutKey(state.failed, site), sites: withoutKey(state.sites, site) }
  };
}

/**
 * A connection through a proxy failed: the site's next selection moves on. A
 * site that answers, even with a refusal, is not a failure of its proxy.
 */
export function recordProxyFailure(input: Readonly<{
  host: string;
  proxyId: string;
  state: ProxyRotationState;
}>): ProxyRotationState {
  const { proxyId, state } = input;
  const host = normalizeProxySiteHost(input.host);
  if (host === null) return state;
  const site = proxySiteKey(host);
  const failed = state.failed[site] ?? [];
  return {
    ...state,
    failed: failed.includes(proxyId) ? state.failed : { ...state.failed, [site]: [...failed, proxyId] },
    sites: state.sites[site] === proxyId ? withoutKey(state.sites, site) : state.sites
  };
}

/**
 * The active proxies a blocked result names, by id: those matching the site in
 * selection order, then the rest in plan order, since any proxy may open any
 * site when named.
 */
export function proxiesToTry(entries: readonly ProxySelectionEntry[], hostValue: string): readonly string[] {
  const host = normalizeProxySiteHost(hostValue);
  const matching = host === null ? [] : candidateTiers(entries, host).flatMap((tier) => tier.members);
  const others = entries.filter((entry) => entry.active && !matching.includes(entry.id)).map((entry) => entry.id);
  return [...matching, ...others];
}
