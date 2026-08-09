"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

export type AdminDraftOwner = string;

type DraftEntry = {
  dirty: boolean;
  discard(): void;
  pending: boolean;
  token: symbol;
};

export type AdminDraftRegistry = Readonly<{
  dirty: boolean;
  discard(owners?: readonly AdminDraftOwner[]): void;
  hasDirty(owners?: readonly AdminDraftOwner[]): boolean;
  hasPending(owners?: readonly AdminDraftOwner[]): boolean;
  pending: boolean;
  register(
    owner: AdminDraftOwner,
    entry: Readonly<{ dirty: boolean; discard(): void; pending?: boolean }>
  ): () => void;
}>;

type RequestDiscardAction = (
  action: () => void,
  owners?: readonly AdminDraftOwner[]
) => boolean;

const AdminDraftProtectionContext = createContext<Readonly<{
  register: AdminDraftRegistry["register"];
  requestDiscardAction: RequestDiscardAction;
}> | null>(null);

function selectedEntries(
  entries: Map<AdminDraftOwner, DraftEntry>,
  owners?: readonly AdminDraftOwner[]
): DraftEntry[] {
  if (!owners) return [...entries.values()];
  const selected = new Set(owners);
  return [...entries.entries()]
    .filter(([owner]) => selected.has(owner))
    .map(([, entry]) => entry);
}

export function useAdminDraftRegistry(): AdminDraftRegistry {
  const entriesRef = useRef(new Map<AdminDraftOwner, DraftEntry>());
  const [snapshot, setSnapshot] = useState({ dirty: false, pending: false });
  const refresh = useCallback(() => {
    const entries = [...entriesRef.current.values()];
    const next = {
      dirty: entries.some((entry) => entry.dirty),
      pending: entries.some((entry) => entry.pending)
    };
    setSnapshot((current) => current.dirty === next.dirty && current.pending === next.pending
      ? current
      : next);
  }, []);

  const register = useCallback<AdminDraftRegistry["register"]>((owner, input) => {
    const token = Symbol(owner);
    const previous = entriesRef.current.get(owner);
    entriesRef.current.set(owner, {
      dirty: input.dirty,
      discard: input.discard,
      pending: input.pending ?? false,
      token
    });
    if (
      previous?.dirty !== input.dirty ||
      previous?.pending !== (input.pending ?? false)
    ) {
      refresh();
    }

    return () => {
      if (entriesRef.current.get(owner)?.token !== token) return;
      const removed = entriesRef.current.get(owner);
      entriesRef.current.delete(owner);
      if (removed?.dirty || removed?.pending) refresh();
    };
  }, [refresh]);

  const hasDirty = useCallback((owners?: readonly AdminDraftOwner[]) =>
    selectedEntries(entriesRef.current, owners).some((entry) => entry.dirty), []);
  const hasPending = useCallback((owners?: readonly AdminDraftOwner[]) =>
    selectedEntries(entriesRef.current, owners).some((entry) => entry.pending), []);
  const discard = useCallback((owners?: readonly AdminDraftOwner[]) => {
    const entries = selectedEntries(entriesRef.current, owners).filter((entry) => entry.dirty);
    if (!entries.length) return;

    // Clear the registry first. A confirmed action may synchronously trigger a
    // full-document navigation before React effects have committed the reset.
    entries.forEach((entry) => {
      entry.dirty = false;
      entry.pending = false;
    });
    entries.forEach((entry) => entry.discard());
    refresh();
  }, [refresh]);

  return useMemo(() => ({
    dirty: snapshot.dirty,
    discard,
    hasDirty,
    hasPending,
    pending: snapshot.pending,
    register
  }), [discard, hasDirty, hasPending, register, snapshot.dirty, snapshot.pending]);
}

export function AdminDraftProtectionProvider({
  children,
  registry,
  requestDiscardAction
}: Readonly<{
  children: ReactNode;
  registry: AdminDraftRegistry;
  requestDiscardAction: RequestDiscardAction;
}>) {
  const value = useMemo(() => ({
    register: registry.register,
    requestDiscardAction
  }), [registry.register, requestDiscardAction]);

  return (
    <AdminDraftProtectionContext.Provider value={value}>
      {children}
    </AdminDraftProtectionContext.Provider>
  );
}

export function useAdminDraftProtection({
  dirty,
  onDiscard,
  owner,
  pending = false
}: Readonly<{
  dirty: boolean;
  onDiscard(): void;
  owner: AdminDraftOwner;
  pending?: boolean;
}>) {
  const context = useContext(AdminDraftProtectionContext);
  const discardRef = useRef(onDiscard);

  useEffect(() => {
    discardRef.current = onDiscard;
  }, [onDiscard]);

  useEffect(() => {
    if (!context) return;
    return context.register(owner, {
      dirty,
      discard: () => discardRef.current(),
      pending
    });
  }, [context, dirty, owner, pending]);

  return useCallback((
    action: () => void,
    owners: readonly AdminDraftOwner[] = [owner]
  ) => {
    if (context) return context.requestDiscardAction(action, owners);
    action();
    return true;
  }, [context, owner]);
}

export function useAdminDiscardAction(): RequestDiscardAction {
  const context = useContext(AdminDraftProtectionContext);

  return useCallback((action, owners) => {
    if (context) return context.requestDiscardAction(action, owners);
    action();
    return true;
  }, [context]);
}

export function AdminDraftRegistration(props: Readonly<{
  dirty: boolean;
  onDiscard(): void;
  owner: AdminDraftOwner;
  pending?: boolean;
}>) {
  useAdminDraftProtection(props);
  return null;
}
