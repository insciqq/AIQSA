export const NATIVE_ROUTING_MIGRATION = "20260917140000_openrouter_native_routing_adoption";

export const nativeRoutingFixtureSql = `
INSERT INTO "ProviderConnection" (id, "displayName", family, "updatedAt")
VALUES ('native-upgrade-fixture', 'Native routing upgrade fixture', 'openrouter', now());
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", "draftConfig", "updatedAt")
VALUES ('native-upgrade-automatic', 'native-upgrade-fixture', 'openrouter', 'deepseek/deepseek-v4-flash', 'Legacy model', '{}', '{}',
  '{"openRouterRouting":{"mode":"automatic","providers":[]}}', now()),
  ('native-upgrade-custom', 'native-upgrade-fixture', 'openrouter', 'openai/example', 'Custom model', '{}', '{}',
  '{"openRouterRouting":{"mode":"only_selected","providers":["custom"]}}', now());
CREATE TABLE "NativeRoutingAdoptionFixture" AS SELECT id, to_jsonb(model) AS snapshot
FROM "ProviderModel" model WHERE id IN ('native-upgrade-automatic', 'native-upgrade-custom');
`;

export const nativeRoutingProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "NativeRoutingAdoptionFixture" fixture JOIN "ProviderModel" model ON model.id = fixture.id
    WHERE fixture.snapshot = to_jsonb(model) - 'nativeRoutingAdoptionVersion' - 'nativeRoutingAdoptionReason'
      AND model."nativeRoutingAdoptionVersion" = 0 AND model."nativeRoutingAdoptionReason" IS NULL) <> 2 THEN
    RAISE EXCEPTION 'native_migration_changed_routes_or_legacy_models';
  END IF;
  BEGIN
    UPDATE "ProviderModel" SET "nativeRoutingAdoptionReason" = 'applied' WHERE id = 'native-upgrade-automatic';
    RAISE EXCEPTION 'native_adoption_reason_without_version_accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
-- Simulate a previous writer that cannot set the new marker itself.
UPDATE "ProviderModel" SET "draftVersion" = "draftVersion" + 1 WHERE id = 'native-upgrade-automatic';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'native-upgrade-automatic'
    AND "nativeRoutingAdoptionVersion" = 1 AND "nativeRoutingAdoptionReason" = 'preserved') THEN
    RAISE EXCEPTION 'previous_writer_operator_override_was_not_preserved';
  END IF;
END $$;
UPDATE "ProviderModel" SET "nativeRoutingAdoptionVersion" = 1, "nativeRoutingAdoptionReason" = 'preserved'
WHERE id IN ('native-upgrade-automatic', 'native-upgrade-custom');
INSERT INTO "ProviderModel" (id, "connectionId", provider, "modelId", "displayName", capabilities, "defaultParams", "updatedAt")
VALUES ('native-upgrade-new', 'native-upgrade-fixture', 'openrouter', 'new/model', 'New operator model', '{}', '{}', now());
`;

export const nativeRoutingRepeatProofSql = `
DO $$ BEGIN
  IF (SELECT count(*) FROM "ProviderModel" WHERE id IN ('native-upgrade-automatic', 'native-upgrade-custom')
    AND "nativeRoutingAdoptionVersion" = 1 AND "nativeRoutingAdoptionReason" = 'preserved') <> 2 OR
    NOT EXISTS (SELECT 1 FROM "ProviderModel" WHERE id = 'native-upgrade-new' AND "nativeRoutingAdoptionVersion" = 1) THEN
    RAISE EXCEPTION 'native_route_migration_replayed_or_claimed_new_operator_model';
  END IF;
END $$;
`;
