"use client";

import { useEffect, useState } from "react";
import { shellFetch } from "./shellApi";
import {
  decodeChatPdfRouteAvailability,
  type ChatPdfRouteAvailability
} from "@/lib/contracts/chatPdfPreparation";

export type ChatPdfRouteTarget = Readonly<{ projectId: string | null; providerConnectionId: string; providerModelId: string }>;
type Target = ChatPdfRouteTarget;

function targetKey(target: Target): string {
  return JSON.stringify({ projectId: target.projectId, providerConnectionId: target.providerConnectionId,
    providerModelId: target.providerModelId });
}

// The composer's current preview, read again by the send gate. It is cleared
// when its target is no longer previewed, so a send never relies on an
// answer for another model, Project or an earlier attachment session.
let latestPreview: { key: string; availability: ChatPdfRouteAvailability } | null = null;

/** The current preview for exactly this target, or null (unknown). */
export function latestChatPdfRouteAvailability(target: Target): ChatPdfRouteAvailability | null {
  return latestPreview?.key === targetKey(target) ? latestPreview.availability : null;
}

/**
 * Asks the admission resolver whether a new chat PDF has a reading route for
 * the selected answer model. Null means unknown (loading or a transient
 * failure); only a definite refusal is reported as unavailable.
 */
export function useChatPdfRoutePreview(target: Target | null): ChatPdfRouteAvailability | null {
  const key = target ? targetKey(target) : null;
  const [resolved, setResolved] = useState<{ key: string; availability: ChatPdfRouteAvailability } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    let pending: AbortController | null = null;
    function publish(availability: ChatPdfRouteAvailability | null) {
      const next = availability ? { key: key!, availability } : null;
      latestPreview = next;
      setResolved(next);
    }
    async function refresh() {
      if (!active || pending || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      pending = controller;
      try {
        const response = await shellFetch("/api/uploads/pdf-route", { body: key,
          headers: { "content-type": "application/json" }, method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        const body = response.ok || response.status === 422 ? await response.json() : null;
        const availability = decodeChatPdfRouteAvailability(response.status, body);
        if (active) publish(availability);
      } catch { if (active) publish(null); }
      finally { if (pending === controller) pending = null; }
    }
    const focus = () => { void refresh(); };
    void refresh();
    const timer = setInterval(focus, 30_000);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    return () => { active = false; pending?.abort(); clearInterval(timer);
      if (latestPreview?.key === key) latestPreview = null;
      document.removeEventListener("visibilitychange", focus); window.removeEventListener("focus", focus); };
  }, [key]);
  return resolved?.key === key ? resolved.availability : null;
}
