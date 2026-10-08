-- OIDC IdP logout: a session signed in through OIDC while IdP logout is on
-- keeps the ID token of that sign-in, sealed under AIQSA_ENCRYPTION_KEY to the
-- session's id, so signing out can send it as `id_token_hint` (Okta ends its
-- session only with one; Keycloak and Auth0 then skip their confirmation).
-- Only OIDC sessions carry one. Expand only: existing rows and
-- previous-release writers leave it NULL, which the check accepts.
ALTER TABLE "AuthSession" ADD COLUMN "idTokenHintEnvelope" TEXT,
  ADD CONSTRAINT "AuthSession_id_token_hint_check" CHECK ("idTokenHintEnvelope" IS NULL OR "signInMethod" = 'oidc');

-- A revoked session never holds a hint: every write that leaves one on a
-- revoked row (logout, password change or reset, administrator revocation,
-- account disable, SCIM deactivation, previous-release writers) clears it.
CREATE FUNCTION aiqsa_revoked_session_id_token_hint_clear() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."idTokenHintEnvelope" := NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuthSession_revoked_id_token_hint_clear"
  BEFORE INSERT OR UPDATE ON "AuthSession"
  FOR EACH ROW WHEN (NEW."revokedAt" IS NOT NULL AND NEW."idTokenHintEnvelope" IS NOT NULL)
  EXECUTE FUNCTION aiqsa_revoked_session_id_token_hint_clear();
