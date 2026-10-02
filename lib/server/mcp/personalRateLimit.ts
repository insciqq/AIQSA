import type { LoginRateLimiter } from "@/lib/server/auth/rateLimit";

/** Personal MCP actions that cause outbound discovery, validation or
 * third-party client registration share one ten-minute window per user. */
export const PERSONAL_MCP_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;

export const PERSONAL_MCP_RATE_LIMITS = {
  /** Create, confirmation resubmit and credential replacement. */
  create: 10,
  "oauth-start": 20
} as const;

export type PersonalMcpRateLimitAction = keyof typeof PERSONAL_MCP_RATE_LIMITS;

export type PersonalMcpRateLimiter = Pick<LoginRateLimiter, "check">;

export function personalMcpRateLimitKey(action: PersonalMcpRateLimitAction, userId: string): string {
  return `personal-mcp:${action}:user:${userId}`;
}

/**
 * Counts one attempt and returns the refusal to send, or null when admitted.
 * The refusal carries only the stable code and `retry-after`; an unavailable
 * limiter fails closed.
 */
export async function personalMcpRateLimitResponse(
  limiter: PersonalMcpRateLimiter,
  action: PersonalMcpRateLimitAction,
  userId: string
): Promise<Response | null> {
  let decision: Awaited<ReturnType<PersonalMcpRateLimiter["check"]>>;
  try {
    decision = await limiter.check(personalMcpRateLimitKey(action, userId), {
      maxAttempts: PERSONAL_MCP_RATE_LIMITS[action]
    });
  } catch {
    return Response.json({ error: "mcp_unavailable" }, { headers: { "cache-control": "no-store" }, status: 503 });
  }
  if (decision.allowed) return null;
  return Response.json({ error: "personal_mcp_rate_limited" }, {
    headers: {
      "cache-control": "no-store",
      "retry-after": String(Math.max(1, Math.ceil(decision.retryAfterSeconds)))
    },
    status: 429
  });
}
