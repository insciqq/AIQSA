/** The content-free projection of a caught value. */
export type ErrorProjection = Readonly<{ error_class?: string; error_site?: string; error_fingerprint?: string }>;
export function describeError(value: unknown): ErrorProjection;
export function resetErrorSiteCaches(): void;
