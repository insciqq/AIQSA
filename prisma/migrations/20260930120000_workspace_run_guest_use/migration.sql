-- Existing bindings and previous-release writers cannot prove non-use.
-- Current admission explicitly writes NULL until the first guest dispatch.
ALTER TABLE "WorkspaceRunBinding" ADD COLUMN "guestUsedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
