"use client";

import { useEffect } from "react";
import { installClientErrorListeners } from "@/lib/browser/clientErrorReporter";

/** Mounted once by the root layout: counts uncaught browser errors, never their content. */
export function ClientErrorReporter() {
  useEffect(() => installClientErrorListeners(window), []);
  return null;
}
