/** The installation switches sign-in handlers enforce; a missing policy row means both on. */
export type SignInPolicySnapshot = {
  passwordLoginEnabled: boolean;
  registrationEnabled: boolean;
};

/** Reads the current switches; handlers without one (fixtures, tooling) keep both on. */
export type SignInPolicyReader = () => Promise<SignInPolicySnapshot>;

const BOTH_ON: SignInPolicySnapshot = { passwordLoginEnabled: true, registrationEnabled: true };

async function currentPolicy(reader: SignInPolicyReader | undefined): Promise<SignInPolicySnapshot> {
  return reader ? reader() : BOTH_ON;
}

/**
 * Refuses a local-password operation (password login, registration and its password step,
 * password-based invite acceptance, password reset) while password sign-in is off. The
 * refusal names an installation switch the login page already shows, so it reveals nothing
 * about any account. The bootstrap token login never consults it.
 */
export async function refuseWhenPasswordSignInOff(reader: SignInPolicyReader | undefined): Promise<Response | null> {
  return (await currentPolicy(reader)).passwordLoginEnabled
    ? null
    : Response.json({ error: "password_login_disabled" }, { status: 403 });
}

/** Refuses self-service registration while it is off or local passwords are off; invites still work. */
export async function refuseWhenRegistrationOff(
  reader: SignInPolicyReader | undefined,
  input: { invited: boolean }
): Promise<Response | null> {
  const policy = await currentPolicy(reader);
  if (!policy.passwordLoginEnabled) return Response.json({ error: "password_login_disabled" }, { status: 403 });
  return policy.registrationEnabled || input.invited
    ? null
    : Response.json({ error: "registration_disabled" }, { status: 403 });
}
