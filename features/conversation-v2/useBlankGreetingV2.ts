"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  AIQSA_TIME_ZONE_COOKIE_NAME,
  greetingPeriodAt,
  greetingText,
  isGreetingTimeZone,
  type GreetingPeriod
} from "@/lib/domain/greeting";

function subscribeToMinutes(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(timer);
}

function browserPeriod(): GreetingPeriod {
  return greetingPeriodAt(new Date().getHours());
}

/** Lets the server render the same greeting on the next load. */
function rememberBrowserTimeZone(): void {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isGreetingTimeZone(timeZone)) return;
  const entry = `${AIQSA_TIME_ZONE_COOKIE_NAME}=${timeZone}`;
  if (document.cookie.split("; ").includes(entry)) return;
  document.cookie = `${entry}; max-age=31536000; path=/; samesite=lax`;
}

/**
 * The blank chat's greeting by local time of day. Hydration uses the period
 * the server derived from the time-zone cookie; then the browser clock takes
 * over and is rechecked every minute.
 */
export function useBlankGreetingV2(displayName: string, serverPeriod: GreetingPeriod | null): string {
  const period = useSyncExternalStore(subscribeToMinutes, browserPeriod, () => serverPeriod);
  useEffect(rememberBrowserTimeZone, []);
  return greetingText(period, displayName);
}
