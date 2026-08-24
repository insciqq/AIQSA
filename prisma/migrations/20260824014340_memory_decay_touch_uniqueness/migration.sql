-- A frozen binding may retain a fact version at most once. Together with the
-- immutable per-item touch marker, this makes binding + fact-version access
-- idempotency a database invariant. PostgreSQL permits multiple NULL values,
-- so recall chunks remain independently ordinal-bound and untouched.
CREATE UNIQUE INDEX "ModelRunMemoryItem_binding_fact_version_key"
ON "ModelRunMemoryItem"("userId", "bindingId", "factVersionId");
