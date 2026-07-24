"use client";

import type {
  AdminOpenRouterDiscoveredEndpoint,
  AdminOpenRouterDiscoveredModel,
  AdminProviderConnection,
  AdminProviderCredential
} from "@/lib/contracts/adminProviders";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type OpenRouterCredentialVersionIdentity =
  | Readonly<{ kind: "active"; version: number; versionId: string }>
  | Readonly<{ kind: "draft"; version: number }>;

export type OpenRouterModelDiscoveryIdentity = Readonly<{
  connectionDraftVersion: number;
  connectionId: string;
  credentialId: string;
  credentialVersion: OpenRouterCredentialVersionIdentity;
}>;

export type OpenRouterEndpointDiscoveryIdentity = OpenRouterModelDiscoveryIdentity & Readonly<{
  modelId: string;
}>;

export type OpenRouterDiscoveryStatus = "empty" | "error" | "idle" | "loading" | "success";

export type OpenRouterDiscoveryState<T> = Readonly<{
  error: string | null;
  items: ReadonlyArray<T>;
  status: OpenRouterDiscoveryStatus;
}>;

type DiscoveryCacheEntry<T> = {
  promise: Promise<ReadonlyArray<T> | null> | null;
  requestId: number;
  state: OpenRouterDiscoveryState<T>;
};

type DiscoveryCache<T> = Map<string, DiscoveryCacheEntry<T>>;
type DiscoveryMode = "load" | "refresh" | "retry";

export type OpenRouterDiscoveryResource<T, TIdentity> = Readonly<{
  /** Return the cached state for an identity. A null identity is always idle. */
  get(identity: TIdentity | null): OpenRouterDiscoveryState<T>;
  /** Load once, deduplicating in-flight work and reusing successful, empty, or failed state. */
  load(identity: TIdentity | null): Promise<ReadonlyArray<T> | null>;
  /** Replace a failed result. In-flight work is still deduplicated. */
  retry(identity: TIdentity | null): Promise<ReadonlyArray<T> | null>;
  /** Start a fresh request even when the identity is already cached. */
  refresh(identity: TIdentity | null): Promise<ReadonlyArray<T> | null>;
}>;

export type AdminOpenRouterDiscoverySession = Readonly<{
  endpoints: OpenRouterDiscoveryResource<
    AdminOpenRouterDiscoveredEndpoint,
    OpenRouterEndpointDiscoveryIdentity
  >;
  models: OpenRouterDiscoveryResource<
    AdminOpenRouterDiscoveredModel,
    OpenRouterModelDiscoveryIdentity
  >;
}>;

type UseAdminOpenRouterDiscoveryOptions = Readonly<{
  endpointErrorMessage?: string;
  loadEndpoints(
    connectionId: string,
    credentialId: string,
    modelId: string
  ): Promise<AdminOpenRouterDiscoveredEndpoint[] | null>;
  loadModels(
    connectionId: string,
    credentialId: string
  ): Promise<AdminOpenRouterDiscoveredModel[] | null>;
  modelErrorMessage?: string;
}>;

const DEFAULT_MODEL_ERROR = "OpenRouter models could not be loaded. Try again.";
const DEFAULT_ENDPOINT_ERROR = "OpenRouter providers could not be loaded. Try again.";

const idleState = Object.freeze({
  error: null,
  items: Object.freeze([]),
  status: "idle"
}) as OpenRouterDiscoveryState<never>;

function modelCacheKey(identity: OpenRouterModelDiscoveryIdentity): string {
  const credentialVersion = identity.credentialVersion.kind === "draft"
    ? ["draft", identity.credentialVersion.version]
    : [
        "active",
        identity.credentialVersion.versionId,
        identity.credentialVersion.version
      ];
  return JSON.stringify([
    identity.connectionId,
    identity.connectionDraftVersion,
    identity.credentialId,
    ...credentialVersion
  ]);
}

function endpointCacheKey(identity: OpenRouterEndpointDiscoveryIdentity): string {
  return JSON.stringify([modelCacheKey(identity), identity.modelId]);
}

/**
 * Builds the identity for the exact key material used by server-side discovery.
 * A pending draft takes precedence over an active non-revoked version, matching
 * the provider repository contract. Credentials without usable key material
 * cannot be discovered and return null.
 */
export function openRouterModelDiscoveryIdentity(
  connection: Pick<AdminProviderConnection, "draftVersion" | "id">,
  credential: Pick<
    AdminProviderCredential,
    "activeVersion" | "draftSecretConfigured" | "draftVersion" | "id"
  > | null
): OpenRouterModelDiscoveryIdentity | null {
  if (!credential) return null;

  const credentialVersion: OpenRouterCredentialVersionIdentity | null =
    credential.draftSecretConfigured
      ? { kind: "draft", version: credential.draftVersion }
      : credential.activeVersion && !credential.activeVersion.revokedAt
        ? {
            kind: "active",
            version: credential.activeVersion.version,
            versionId: credential.activeVersion.id
          }
        : null;

  return credentialVersion
    ? {
        connectionDraftVersion: connection.draftVersion,
        connectionId: connection.id,
        credentialId: credential.id,
        credentialVersion
      }
    : null;
}

export function openRouterEndpointDiscoveryIdentity(
  identity: OpenRouterModelDiscoveryIdentity | null,
  modelId: string
): OpenRouterEndpointDiscoveryIdentity | null {
  return identity && modelId
    ? { ...identity, modelId }
    : null;
}

function cachedState<T>(
  cache: DiscoveryCache<T>,
  key: string | null
): OpenRouterDiscoveryState<T> {
  return key === null
    ? idleState
    : cache.get(key)?.state ?? idleState;
}

export function useAdminOpenRouterDiscovery({
  endpointErrorMessage = DEFAULT_ENDPOINT_ERROR,
  loadEndpoints,
  loadModels,
  modelErrorMessage = DEFAULT_MODEL_ERROR
}: UseAdminOpenRouterDiscoveryOptions): AdminOpenRouterDiscoverySession {
  const modelCacheRef = useRef<DiscoveryCache<AdminOpenRouterDiscoveredModel>>(new Map());
  const endpointCacheRef = useRef<DiscoveryCache<AdminOpenRouterDiscoveredEndpoint>>(new Map());
  const modelLoaderRef = useRef(loadModels);
  const endpointLoaderRef = useRef(loadEndpoints);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const [, setRevision] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    modelLoaderRef.current = loadModels;
    endpointLoaderRef.current = loadEndpoints;
  }, [loadEndpoints, loadModels]);

  const notify = useCallback(() => {
    if (mountedRef.current) setRevision((revision) => revision + 1);
  }, []);

  const run = useCallback(<T, TIdentity>(input: {
    cache: DiscoveryCache<T>;
    errorMessage: string;
    identity: TIdentity | null;
    key(identity: TIdentity): string;
    loader(identity: TIdentity): Promise<T[] | null>;
    mode: DiscoveryMode;
  }): Promise<ReadonlyArray<T> | null> => {
    if (!input.identity) return Promise.resolve(null);

    const key = input.key(input.identity);
    const current = input.cache.get(key);
    if (input.mode !== "refresh") {
      if (current?.state.status === "loading" && current.promise) return current.promise;
      if (input.mode === "load") {
        if (current?.state.status === "success" || current?.state.status === "empty") {
          return Promise.resolve(current.state.items);
        }
        if (current?.state.status === "error") return Promise.resolve(null);
      }
    }

    const requestId = ++requestIdRef.current;
    const priorItems = current?.state.items ?? [];
    const identity = input.identity;
    const promise = Promise.resolve()
      .then(() => input.loader(identity))
      .catch(() => null)
      .then((result): ReadonlyArray<T> | null => {
        const latest = input.cache.get(key);
        if (!latest || latest.requestId !== requestId) return null;

        if (result === null) {
          latest.promise = null;
          latest.state = {
            error: input.errorMessage,
            items: priorItems,
            status: "error"
          };
          notify();
          return null;
        }

        const items = [...result];
        latest.promise = null;
        latest.state = {
          error: null,
          items,
          status: items.length ? "success" : "empty"
        };
        notify();
        return items;
      });

    input.cache.set(key, {
      promise,
      requestId,
      state: {
        error: null,
        items: priorItems,
        status: "loading"
      }
    });
    notify();
    return promise;
  }, [notify]);

  const getModels = useCallback((identity: OpenRouterModelDiscoveryIdentity | null) =>
    cachedState(modelCacheRef.current, identity ? modelCacheKey(identity) : null), []);

  const runModels = useCallback((
    identity: OpenRouterModelDiscoveryIdentity | null,
    mode: DiscoveryMode
  ) => run({
    cache: modelCacheRef.current,
    errorMessage: modelErrorMessage,
    identity,
    key: modelCacheKey,
    loader: (current) => modelLoaderRef.current(current.connectionId, current.credentialId),
    mode
  }), [modelErrorMessage, run]);

  const getEndpoints = useCallback((identity: OpenRouterEndpointDiscoveryIdentity | null) =>
    cachedState(endpointCacheRef.current, identity ? endpointCacheKey(identity) : null), []);

  const runEndpoints = useCallback((
    identity: OpenRouterEndpointDiscoveryIdentity | null,
    mode: DiscoveryMode
  ) => run({
    cache: endpointCacheRef.current,
    errorMessage: endpointErrorMessage,
    identity,
    key: endpointCacheKey,
    loader: (current) => endpointLoaderRef.current(
      current.connectionId,
      current.credentialId,
      current.modelId
    ),
    mode
  }), [endpointErrorMessage, run]);

  return useMemo(() => ({
    endpoints: {
      get: getEndpoints,
      load: (identity) => runEndpoints(identity, "load"),
      refresh: (identity) => runEndpoints(identity, "refresh"),
      retry: (identity) => runEndpoints(identity, "retry")
    },
    models: {
      get: getModels,
      load: (identity) => runModels(identity, "load"),
      refresh: (identity) => runModels(identity, "refresh"),
      retry: (identity) => runModels(identity, "retry")
    }
  }), [getEndpoints, getModels, runEndpoints, runModels]);
}
