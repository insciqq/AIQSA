import type { ConnectAdminPolicy } from "@/lib/contracts/connect";

/** How long a read of the installation switch is reused; a committed change replaces it at once. */
export const CONNECT_POLICY_CACHE_MS = 5_000;

type ConnectPolicyCacheState = {
  /** Bumped by every remembered change, so an older read in flight cannot overwrite it. */
  generation: number;
  pending: Promise<ConnectAdminPolicy> | null;
  value: Readonly<{ expiresAt: number; policy: ConnectAdminPolicy }> | null;
};

export type ConnectPolicyGate = Readonly<{
  /** Whether AIQSA Connect is on; throws while the policy cannot be read. */
  enabled(): Promise<boolean>;
  /** Forgets the cached switch; the next check reads the store. */
  invalidate(): void;
  read(): Promise<ConnectAdminPolicy>;
  /** Uses a committed change at once instead of the cached read. */
  remember(policy: ConnectAdminPolicy): void;
}>;

export function createConnectPolicyGate(input: Readonly<{
  load: () => Promise<ConnectAdminPolicy>;
  now?: () => number;
  state?: ConnectPolicyCacheState;
  ttlMs?: number;
}>): ConnectPolicyGate {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? CONNECT_POLICY_CACHE_MS;
  const state = input.state ?? { generation: 0, pending: null, value: null };

  async function read(): Promise<ConnectAdminPolicy> {
    if (state.value && state.value.expiresAt > now()) return state.value.policy;
    if (state.pending) return state.pending;
    const generation = state.generation;
    const pending = input.load().then((policy) => {
      if (state.generation === generation) state.value = { expiresAt: now() + ttlMs, policy };
      return policy;
    }).finally(() => {
      if (state.pending === pending) state.pending = null;
    });
    state.pending = pending;
    return pending;
  }

  return {
    async enabled() {
      return (await read()).enabled;
    },
    invalidate() {
      state.generation += 1;
      state.pending = null;
      state.value = null;
    },
    read,
    remember(policy) {
      state.generation += 1;
      state.pending = null;
      state.value = { expiresAt: now() + ttlMs, policy };
    }
  };
}

const globalForConnectPolicy = globalThis as typeof globalThis & {
  __aiqsaConnectPolicy?: ConnectPolicyCacheState;
};

/**
 * One process-wide cache: route bundles may load separate module instances,
 * and an administrator's change must reach every one of them at once.
 */
export function getConnectPolicyGate(): ConnectPolicyGate {
  const state = globalForConnectPolicy.__aiqsaConnectPolicy ??= { generation: 0, pending: null, value: null };
  return createConnectPolicyGate({
    async load() {
      const [{ prisma }, { createPrismaConnectPolicyRepository }] = await Promise.all([
        import("../prisma"),
        import("./policyRepository")
      ]);
      return createPrismaConnectPolicyRepository(prisma).read();
    },
    state
  });
}

/** Whether the administrator turned AIQSA Connect on; false while the policy cannot be read. */
export async function isConnectEnabled(): Promise<boolean> {
  try {
    return await getConnectPolicyGate().enabled();
  } catch {
    return false;
  }
}
