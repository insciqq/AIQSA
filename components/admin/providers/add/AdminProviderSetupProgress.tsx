"use client";

import type { AdminProviderSetupProgress as Progress } from "@/lib/contracts/adminProviderSetupProgress";
import { CAPABILITY_LABELS } from "./AdminProviderSetupResults";
import { useEffect, useState } from "react";

const titles: Record<Progress["phase"], string> = {
  validating: "Preparing provider checks…",
  discovering: "Checking the key and finding available models…",
  checking: "Checking models…",
  saving: "Saving the provider and checked results…",
  finishing: "Starting Search and default assignments…"
};

export function AdminProviderSetupProgress({ progress }: Readonly<{ progress: Progress }>) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1_000)), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <section className="min-w-0 rounded-[10px] border border-proof/30 px-4 py-3" data-testid="provider-setup-progress">
      <div aria-live="polite" role="status">
        <p className="text-sm font-medium text-ink">{titles[progress.phase]}</p>
        <p className="mt-1 text-xs leading-5 text-ink-secondary">
          {progress.total === null ? "Waiting for this step to finish." : `${progress.completed} of ${progress.total} models checked.`}
          {progress.phase === "checking" ? " Verified settings are saved for each model as checking finishes." : ""}
        </p>
        {progress.capability ? <p className="mt-1 text-xs text-ink-secondary">Checking {CAPABILITY_LABELS[progress.capability]}…</p> : null}
      </div>
      <div
        aria-label={progress.total === null ? titles[progress.phase] : "Models checked"}
        aria-valuemax={progress.total ?? undefined}
        aria-valuemin={0}
        aria-valuenow={progress.total === null ? undefined : progress.completed}
        className="mt-2 h-1 overflow-hidden rounded-pill bg-trace-strong"
        role="progressbar"
      >
        {progress.total === null ? null : <span className="block h-full rounded-pill bg-proof" style={{ width: `${100 * progress.completed / progress.total}%` }} />}
      </div>
      <p className="mt-2 text-xs text-ink-muted">Elapsed: {elapsed}s</p>
    </section>
  );
}
