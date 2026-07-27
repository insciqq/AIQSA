export type SessionErrorCode = "unauthorized";

export const CLIENT_SESSION_EXPIRED_CODE = "session_expired" as const;

export type ClientSessionErrorCode = typeof CLIENT_SESSION_EXPIRED_CODE;

export function clientSessionErrorFromStatus(status: number): ClientSessionErrorCode | null {
  return status === 401 ? CLIENT_SESSION_EXPIRED_CODE : null;
}

export type AdminAuthErrorCode = SessionErrorCode | "forbidden";

export type MutationOriginErrorCode = "invalid_origin";

export type ErrorResponse<Code extends string> = {
  error: Code;
};
