-- A finding keeps a public rating of one option in a column of its own (operator decision 2026-11-05: ratings count, for products and
-- services alike; `agent_docs/RUN_CONTRACTS.md`, Research). Additive and nullable: every existing row reads as no rating, and the previous
-- release's writers and client never name the column, so they stay safe while Compose replaces containers. The decoder bounds its fields
-- (`decodeResearchRecord`, `lib/contracts/research.ts`); the database keeps it to a finding and to one object.
ALTER TABLE "ResearchEvidence" ADD COLUMN "rating" JSONB;
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_rating_check" CHECK ("rating" IS NULL OR ("kind" = 'finding' AND jsonb_typeof("rating") = 'object'));
