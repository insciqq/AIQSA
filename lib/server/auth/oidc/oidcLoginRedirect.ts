import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";

/**
 * Whether `/login` sends the browser straight to the IdP (`autoRedirect`). Never with
 * `?local=1` (the administrator's way back to the other methods), while an outcome or an
 * expired session is shown, or on an invitation, reset or verification link, which belong to
 * this page.
 */
export function oidcAutoRedirectPath(input: {
  config: AuthSignInMethodConfig<"oidc"> | null | undefined;
  nextPath: string;
  params: Readonly<Record<string, string | string[] | undefined>>;
}): string | null {
  const { params } = input;
  if (!input.config?.autoRedirect) return null;
  if (params.local === "1" || params.oauth !== undefined || params.reason !== undefined) return null;
  if (params.invite !== undefined || params.reset !== undefined || params.verify !== undefined) return null;
  return `/api/auth/oauth/oidc?${new URLSearchParams({ next: input.nextPath }).toString()}`;
}
