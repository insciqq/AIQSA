"use client";

import { adminMcpErrorMessage } from "@/components/admin/adminMcpApi";
import {
  followMcpOAuthStart,
  McpSettingsApiError,
  startMcpOAuth
} from "@/components/app-shell/mcpSettingsApi";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Starts validation OAuth with an origin-checked POST and follows the answer.
 * One start at a time: the control stays busy until the request answers and
 * the document begins to navigate; a navigation that never leaves the page
 * (cancelled, or restored from the back-forward cache) releases it again.
 */
export function useAdminMcpOAuthStart(onError: (message: string) => void) {
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const release = useCallback(() => {
    pendingRef.current = false;
    setPending(null);
  }, []);

  useEffect(() => {
    window.addEventListener("pageshow", release);
    return () => window.removeEventListener("pageshow", release);
  }, [release]);

  const start = useCallback((action: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    void startMcpOAuth(action).then((location) => {
      window.setTimeout(release, 2_000);
      followMcpOAuthStart(location);
    }, (cause: unknown) => {
      release();
      onError(adminMcpErrorMessage(cause instanceof McpSettingsApiError
        ? { code: cause.code, issues: cause.issues }
        : { code: "network_error", issues: [] }));
    });
  }, [onError, release]);

  return { pending, start } as const;
}
