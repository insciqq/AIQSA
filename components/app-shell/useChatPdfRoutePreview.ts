"use client";

import { useEffect, useState } from "react";
import { shellFetch } from "./shellApi";
import type { ChatPdfRoute } from "@/lib/contracts/chatPdfPreparation";

type Target = Readonly<{ projectId: string | null; providerConnectionId: string; providerModelId: string }>;

export function useChatPdfRoutePreview(target: Target | null): ChatPdfRoute | null {
  const key = target ? JSON.stringify(target) : null;
  const [resolved, setResolved] = useState<{ key: string; route: ChatPdfRoute } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    let pending: AbortController | null = null;
    async function refresh() {
      if (!active || pending || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      pending = controller;
      try {
        const response = await shellFetch("/api/uploads/pdf-route", { body: key,
          headers: { "content-type": "application/json" }, method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        const body = response.ok ? await response.json() : null;
        const route = body?.version === 1 && ["direct_pdf", "system_vision", "selected_model_vision", "local_text"].includes(body.route)
          ? body.route as ChatPdfRoute : null;
        if (active) setResolved(route ? { key: key!, route } : null);
      } catch { if (active) setResolved(null); }
      finally { if (pending === controller) pending = null; }
    }
    const focus = () => { void refresh(); };
    void refresh();
    const timer = setInterval(focus, 30_000);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    return () => { active = false; pending?.abort(); clearInterval(timer);
      document.removeEventListener("visibilitychange", focus); window.removeEventListener("focus", focus); };
  }, [key]);
  return resolved?.key === key ? resolved.route : null;
}
