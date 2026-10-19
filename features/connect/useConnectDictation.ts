"use client";

import { shellFetch } from "@/components/app-shell/shellApi";
import { decodeCatalogDictation, type CatalogDictation } from "@/lib/contracts/speechToText";
import { useEffect, useState } from "react";

let loaded: Promise<CatalogDictation | null> | null = null;

async function loadDictation(): Promise<CatalogDictation | null> {
  const response = await shellFetch("/api/me/catalog", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("catalog_unavailable");
  const value: unknown = await response.json();
  const catalog = typeof value === "object" && value !== null ? (value as Record<string, unknown>).catalog : null;
  const dictation = typeof catalog === "object" && catalog !== null ? (catalog as Record<string, unknown>).dictation : undefined;
  // A catalog without the field has no dictation, as in the chat composer.
  if (dictation === undefined) return null;
  const decoded = decodeCatalogDictation(dictation);
  if (!decoded) throw new Error("catalog_malformed");
  return decoded;
}

/** Forgets the loaded availability; tests start from an empty page. */
export function resetConnectDictationForTests(): void {
  loaded = null;
}

/**
 * Dictation availability from the user's catalog, which the Connect shell
 * does not otherwise load: read once per page, and again on the next compose
 * field after a failed read. Null (no microphone) until it is known.
 */
export function useConnectDictation(enabled: boolean): CatalogDictation | null {
  const [dictation, setDictation] = useState<CatalogDictation | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const pending = loaded ?? loadDictation();
    loaded = pending;
    pending.then(
      (value) => {
        if (current) setDictation(value);
      },
      () => {
        if (loaded === pending) loaded = null;
      }
    );
    return () => {
      current = false;
    };
  }, [enabled]);
  return enabled ? dictation : null;
}
