import { validateIanaTimeZone } from "@/lib/domain/promptTemplates";
import {
  WORKSPACE_BROWSER_LOCALE_ENV, WORKSPACE_BROWSER_TIME_ZONE_ENV, isWorkspaceBrowserLocale, isWorkspaceBrowserTimeZone
} from "./codeMcp";

/**
 * The Workspace browser's language and time zone, frozen with the run at
 * admission (`NormalizedRunWorkspace.browser`) and handed to guest commands in
 * the run-bound environment, where `aiqsa.browser` reads them
 * (`ops/workspace-guest/python/aiqsa/browser/_identity.py`). The zone is the
 * run's own admitted zone (`prompt.baseline`); AIQSA stores no interface
 * language yet, so the language is the documented default until it does.
 */
export type WorkspaceBrowserBinding = Readonly<{ locale: string; timeZone: string }>;

export const WORKSPACE_BROWSER_DEFAULT_LOCALE = "en-US";
export const WORKSPACE_BROWSER_DEFAULT_TIME_ZONE = "UTC";

export function workspaceBrowserBinding(input: Readonly<{ timeZone?: string | null }>): WorkspaceBrowserBinding {
  const zone = validateIanaTimeZone(input.timeZone);
  return {
    locale: WORKSPACE_BROWSER_DEFAULT_LOCALE,
    timeZone: zone && isWorkspaceBrowserTimeZone(zone) ? zone : WORKSPACE_BROWSER_DEFAULT_TIME_ZONE
  };
}

/** Values every guest command of the run gets; nothing for a run admitted before the binding existed. */
export function workspaceBrowserEnvironment(binding: WorkspaceBrowserBinding | undefined): Readonly<Record<string, string>> {
  if (!binding || !isWorkspaceBrowserLocale(binding.locale) || !isWorkspaceBrowserTimeZone(binding.timeZone)) return {};
  return { [WORKSPACE_BROWSER_LOCALE_ENV]: binding.locale, [WORKSPACE_BROWSER_TIME_ZONE_ENV]: binding.timeZone };
}
