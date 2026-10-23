"use client";

import { getAdminModelPolicy } from "@/components/admin/adminModelPolicyApi";
import { requestAdminSearchCatalog } from "@/components/admin/adminSearchApi";
import { getAdminSystemModelPolicy } from "@/components/admin/adminSystemModelPolicyApi";
import type { ProviderUsageSources } from "@/components/admin/providers/providerListView";
import { useEffect, useRef, useState } from "react";

const EMPTY: ProviderUsageSources = {
  modelPolicy: null,
  search: null,
  systemModelPolicy: null
};

/**
 * Where each provider is used (default chat, system roles, Search sources)
 * from the installation policies the Control
 * Center already serves. A source that cannot be read simply adds no tags;
 * the list itself never waits for it.
 */
export function useAdminProviderUsage(active: boolean, refreshKey: unknown): ProviderUsageSources {
  const [sources, setSources] = useState<ProviderUsageSources>(EMPTY);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    const generation = ++generationRef.current;
    void Promise.all([
      getAdminModelPolicy(),
      getAdminSystemModelPolicy(),
      requestAdminSearchCatalog()
    ]).then(([modelPolicy, systemModelPolicy, search]) => {
      if (generation !== generationRef.current) return;
      setSources({
        modelPolicy: modelPolicy.ok ? modelPolicy.data : null,
        search: search.ok ? search.search : null,
        systemModelPolicy: systemModelPolicy.ok ? systemModelPolicy.data : null
      });
    }).catch(() => undefined);
  }, [active, refreshKey]);

  return sources;
}
