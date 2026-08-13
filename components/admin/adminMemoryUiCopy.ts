import type { AdminMemoryDestinationId } from "@/lib/contracts/adminMemory";
import type { AdminMemoryHealth } from "@/lib/contracts/memoryHealth";

export type AdminMemoryLocale = "EN" | "RU";

type Copy = Readonly<{
  active: string;
  acknowledge: string;
  acknowledging: string;
  acknowledgedFingerprint: string;
  advanced: string;
  advancedDescription: string;
  currentFingerprint: string;
  currentPolicy: string;
  deletion: string;
  blocked: string;
  destinationMatrix: string;
  destinationMissing: string;
  fingerprintNever: string;
  heading: string;
  installationPolicy: string;
  intro: string;
  lastAcknowledgment: string;
  loading: string;
  notice: string;
  operationalEvidence: string;
  oldest: string;
  outcomeUnknown: string;
  perUser: string;
  policyRevision: string;
  provider: string;
  queue: string;
  refresh: string;
  recentFailures: string;
  reviewDescription: string;
  reviewTitle: string;
  scheduler: string;
  safetyBlocked: string;
  safetyTemporary: string;
  trustDescription: string;
  usageIncomplete: string;
  destinationReview: string;
  failed: string;
  waitingJobs: string;
}>;

const COPY: Readonly<Record<"EN", Copy>> = {
  EN: {
    active: "Active",
    acknowledge: "Acknowledge current destinations",
    acknowledging: "Acknowledging…",
    acknowledgedFingerprint: "Acknowledged fingerprint",
    advanced: "Advanced",
    advancedDescription: "Bounded queue evidence, destination bindings, fingerprints, and policy revisions.",
    currentFingerprint: "Current fingerprint",
    currentPolicy: "Policy",
    deletion: "Cleanup",
    blocked: "Blocked",
    destinationMatrix: "Memory destination matrix",
    destinationMissing: "No current destination",
    fingerprintNever: "Not acknowledged",
    heading: "Memory health",
    installationPolicy: "Installation Memory",
    intro: "See whether personalization is working and act only when the installation needs attention.",
    lastAcknowledgment: "Last acknowledgment",
    loading: "Loading Memory health…",
    notice: "Current Memory destinations acknowledged. Waiting work will resume automatically.",
    operationalEvidence: "Operational evidence",
    oldest: "Oldest wait",
    outcomeUnknown: "Outcome unknown",
    perUser: "This installation uses per-user destination review. No administrator acknowledgment is available here.",
    policyRevision: "Policy revision",
    provider: "Provider work",
    queue: "Background queue",
    refresh: "Refresh",
    recentFailures: "Recent failures",
    reviewDescription: "New or changed destinations keep only affected external Memory work waiting.",
    reviewTitle: "Destination review required",
    scheduler: "Background allowance",
    safetyBlocked: "A durable Memory cleanup has exhausted fast retries. Retrieval remains fenced and slow reconciliation continues.",
    safetyTemporary: "At least one Temporary chat is past its retention deadline and remains hidden while cleanup continues.",
    trustDescription: "Destination acknowledgment is an installation trust decision. Per-call evidence remains inspectable without exposing personal Memory content here.",
    usageIncomplete: "Usage incomplete",
    destinationReview: "Destination review",
    failed: "Failed",
    waitingJobs: "Waiting external jobs"
  }
};

export function adminMemoryCopy(locale: AdminMemoryLocale): Copy {
  void locale;
  return COPY.EN;
}

export function adminMemoryOverallCopy(
  locale: AdminMemoryLocale,
  overall: AdminMemoryHealth["overall"]
): Readonly<{ description: string; title: string }> {
  const copy = {
    EN: {
      ACTION_REQUIRED: {
        description: "A safety or trust obligation needs administrator attention. Core chat remains available.",
        title: "Memory needs attention"
      },
      DEGRADED: {
        description: "Personalization remains available, but some background work is delayed or degraded.",
        title: "Memory is running with delays"
      },
      HEALTHY: {
        description: "Queues, provider work, and durable cleanup are within their normal operating state.",
        title: "Memory is healthy"
      },
      UNAVAILABLE: {
        description: "Destination settings remain available, but aggregate operational health could not be checked. Refresh to try again.",
        title: "Memory health is unavailable"
      }
    }
  } as const;
  void locale;
  return copy.EN[overall];
}

export function adminMemoryStateCopy(
  locale: AdminMemoryLocale,
  domain: "deletion" | "provider" | "queue" | "scheduler",
  state: string
): string {
  const values: Readonly<Record<"EN", Readonly<Record<string, string>>>> = {
    EN: {
      ATTENTION_REQUIRED: "Administrator attention required",
      BLOCKED: "Recent failures need review",
      CLEAR: "No waiting work",
      DEGRADED: "Recent provider work is incomplete",
      DEFERRED: "Daily background allowance reached",
      DELAYED: "Some work is delayed",
      HEALTHY: "Ready",
      IDLE: "No recent provider work",
      READY: "Ready",
      UNAVAILABLE: "Status unavailable",
      UNKNOWN: "Unknown",
      WORKING: domain === "deletion" ? "Cleanup in progress" : "Processing normally"
    }
  };
  void locale;
  return values.EN[state] ?? state;
}

export function adminMemoryCountCopy(
  locale: AdminMemoryLocale,
  band: AdminMemoryHealth["queue"]["active"]
): string {
  void locale;
  return ({
    EN: { MANY: "Many", NONE: "None", SOME: "Some", UNKNOWN: "Unknown" }
  } as const).EN[band];
}

export function adminMemoryLagCopy(
  locale: AdminMemoryLocale,
  lag: AdminMemoryHealth["queue"]["oldestLag"]
): string {
  void locale;
  return ({
    EN: {
      NONE: "No active queue",
      OVER_24_HOURS: "Over 24 hours",
      UNDER_15_MINUTES: "Under 15 minutes",
      UNDER_1_HOUR: "Under 1 hour",
      UNDER_24_HOURS: "Under 24 hours",
      UNDER_5_MINUTES: "Under 5 minutes",
      UNKNOWN: "Unknown"
    }
  } as const).EN[lag];
}

export function adminMemoryDestinationCopy(
  locale: AdminMemoryLocale,
  id: AdminMemoryDestinationId
): Readonly<{ description: string; label: string }> {
  void locale;
  const rows = {
    EN: {
      answer_provider: {
        description: "Selected snippets travel only with an accepted answer request; each run pins its exact binding.",
        label: "Selected answer model"
      },
      embedding: {
        description: "Eligible bounded text may use these embedding deployments.",
        label: "Embedding deployment"
      },
      remote_reranker: {
        description: "Bounded candidates use this destination only when remote reranking is active.",
        label: "Remote reranker"
      },
      system_model: {
        description: "Background extraction, verification, profiles, and query expansion use this role.",
        label: "System Memory model"
      }
    }
  } as const;
  return rows.EN[id];
}

export function adminMemoryDestinationStateCopy(
  locale: AdminMemoryLocale,
  state: "AVAILABLE" | "BOUND_PER_RUN" | "REVIEW_REQUIRED" | "UNAVAILABLE"
): string {
  void locale;
  return ({
    EN: {
      AVAILABLE: "Available",
      BOUND_PER_RUN: "Bound per run",
      REVIEW_REQUIRED: "Review required",
      UNAVAILABLE: "Not configured"
    }
  } as const).EN[state];
}
