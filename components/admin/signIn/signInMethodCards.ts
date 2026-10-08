import { GoogleSignInCard, YandexSignInCard } from "@/components/admin/signIn/OAuthClientSignInCard";
import { ScimSignInCard } from "@/components/admin/signIn/ScimSignInCard";
import type { AdminSignInMethodCardProps } from "@/components/admin/signIn/SignInMethodCardFrame";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import type { ComponentType } from "react";

export type AdminSignInMethodCardRegistry = {
  readonly [M in AuthSignInMethod]?: ComponentType<AdminSignInMethodCardProps<M>>;
};

/**
 * The admin card of each sign-in method. A method task registers its card with one line here
 * (`oidc: OidcSignInCard,`) next to its server definition in
 * `lib/server/auth/signInSettings/methods.ts`; a method the server lists without a card here
 * is not shown.
 */
export const adminSignInMethodCards: AdminSignInMethodCardRegistry = {
  google: GoogleSignInCard,
  scim: ScimSignInCard,
  yandex: YandexSignInCard
};
