import { describe, expect, it } from "vitest";
import { PROXY_BLOCKED_HTTP_STATUSES } from "@/lib/contracts/proxies";
import {
  EMPTY_PROXY_ROTATION_STATE,
  normalizeProxyHint,
  normalizeProxySiteHost,
  proxiesToTry,
  proxySiteKey,
  recordProxyFailure,
  selectProxy,
  type ProxyExplicitChoice,
  type ProxyRotationState,
  type ProxySelectionEntry
} from "./proxySelection";
import rawVectors from "./proxySelection.vectors.json";

type VectorStep = Readonly<{
  op: string;
  host: string;
  explicit?: ProxyExplicitChoice;
  expect?: unknown;
  proxyId?: string;
  state?: ProxyRotationState;
}>;

type Vectors = Readonly<{
  blockedHttpStatuses: readonly number[];
  hints: readonly Readonly<{ input: string; name: string; output: string | null }>[];
  hosts: readonly Readonly<{ host: string | null; input: string; name: string; site?: string }>[];
  selection: readonly Readonly<{
    name: string;
    proxies: readonly ProxySelectionEntry[];
    state?: ProxyRotationState;
    steps: readonly VectorStep[];
  }>[];
  toTry: readonly Readonly<{ host: string; name: string; output: readonly string[]; proxies: readonly ProxySelectionEntry[] }>[];
  version: number;
}>;

const vectors = rawVectors as unknown as Vectors;

function deepFrozen<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFrozen);
    Object.freeze(value);
  }
  return value;
}

describe("shared proxy selection vectors", () => {
  it.each(vectors.hints.map((vector) => [vector.name, vector] as const))("hint: %s", (_name, vector) => {
    expect(normalizeProxyHint(vector.input)).toBe(vector.output);
  });

  it.each(vectors.hosts.map((vector) => [vector.name, vector] as const))("host: %s", (_name, vector) => {
    const host = normalizeProxySiteHost(vector.input);
    expect(host).toBe(vector.host);
    if (host !== null) expect(proxySiteKey(host)).toBe(vector.site);
  });

  it.each(vectors.selection.map((vector) => [vector.name, vector] as const))("selection: %s", (_name, vector) => {
    let state = deepFrozen(vector.state ?? EMPTY_PROXY_ROTATION_STATE);
    for (const step of vector.steps) {
      if (step.op === "select") {
        const result = selectProxy({ entries: vector.proxies, explicit: step.explicit ?? null, host: step.host, state });
        expect(result.selection).toEqual(step.expect);
        state = deepFrozen(result.state);
      } else {
        expect(step.op).toBe("fail");
        state = deepFrozen(recordProxyFailure({ host: step.host, proxyId: step.proxyId!, state }));
      }
      if (step.state) expect(state).toEqual(step.state);
    }
  });

  it.each(vectors.toTry.map((vector) => [vector.name, vector] as const))("to try: %s", (_name, vector) => {
    expect(proxiesToTry(vector.proxies, vector.host)).toEqual(vector.output);
  });

  it("keeps the blocked statuses of the contract", () => {
    expect(vectors.blockedHttpStatuses).toEqual([...PROXY_BLOCKED_HTTP_STATUSES]);
  });

  it("stays plain JSON for another language", () => {
    expect(JSON.parse(JSON.stringify(vectors))).toEqual(vectors);
    expect(vectors.version).toBe(1);
  });
});

describe("proxy selection beyond the vectors", () => {
  it("refuses values that are no text and text too long to be a hostname", () => {
    for (const value of [null, undefined, 7, {}, "a".repeat(5_000)]) {
      expect(normalizeProxyHint(value)).toBeNull();
      expect(normalizeProxySiteHost(value)).toBeNull();
    }
  });

  it("refuses a name over the total hostname length", () => {
    const longest = `${"a.".repeat(125)}example.kz`;
    expect(longest.length).toBeGreaterThan(253);
    expect(normalizeProxyHint(longest)).toBeNull();
  });

  it("cannot write through an object's special names", () => {
    const entries: readonly ProxySelectionEntry[] = [
      { active: true, domainHints: [".__proto__"], id: "a", name: "A", owner: "personal" }
    ];
    const { selection, state } = selectProxy({ entries, host: "x.__proto__", state: EMPTY_PROXY_ROTATION_STATE });
    expect(selection).toMatchObject({ kind: "proxy", proxyId: "a" });
    expect(Object.keys(state.sites)).toEqual(["x.__proto__"]);
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it("returns the same answer for the same input", () => {
    const entries: readonly ProxySelectionEntry[] = [
      { active: true, domainHints: [".kz"], id: "a", name: "A", owner: "personal" },
      { active: true, domainHints: [".kz"], id: "b", name: "B", owner: "personal" }
    ];
    const first = selectProxy({ entries, host: "one.kz", state: EMPTY_PROXY_ROTATION_STATE });
    const second = selectProxy({ entries, host: "one.kz", state: EMPTY_PROXY_ROTATION_STATE });
    expect(second).toEqual(first);
  });
});
