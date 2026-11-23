-- A turn the server wrote saves a browser sign-in only when the user finished it there (operator decision 2026-11-23,
-- `lib/server/workspace/secrets/browserSignInAuthority.ts`); a refused file still stays on the chat's Workspace disk, and
-- a later run of the chat would collect it again. Each refusal is kept with the session it happened on, as the file's
-- name and the refused bytes' SHA-256, so collecting the same bytes later never saves them. The value is bounded by the
-- application and goes with the session.
--
-- Expand only: a nullable column the previous release's writers never name, and no existing row changes.
ALTER TABLE "WorkspaceSession" ADD COLUMN "browserRefusedRevisions" JSONB;
