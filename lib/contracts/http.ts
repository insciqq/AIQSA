export type SessionErrorCode = "unauthorized";

export type AdminAuthErrorCode = SessionErrorCode | "forbidden";

export type MutationOriginErrorCode = "invalid_origin";

export type ErrorResponse<Code extends string> = {
  error: Code;
};
