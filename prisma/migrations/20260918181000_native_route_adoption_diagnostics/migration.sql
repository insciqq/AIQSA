-- Rejected native-route checks are separate from the working model's evidence.
-- Historical attempts have no detailed receipt; never infer one or replay them.
ALTER TABLE "ProviderModel" ADD COLUMN "nativeRoutingAdoptionEvidence" JSONB;
