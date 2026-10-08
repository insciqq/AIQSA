import type { SignInMethodServerDefinition } from "../signInSettings/registry";

/**
 * SCIM in the sign-in settings: Save, then Activate (no tester: an IdP connection proves
 * itself with its first request, recorded on the card). Its identities carry no source.
 */
export const scimSignInMethod: SignInMethodServerDefinition<"scim"> = {};
