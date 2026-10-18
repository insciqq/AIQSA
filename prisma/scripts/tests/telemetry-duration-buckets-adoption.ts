export const TELEMETRY_DURATION_BUCKETS_MIGRATION = "20261018153700_telemetry_duration_buckets";

const columns = `"bucketStart", "role", "event", "level", "appVersion", "dimensionHash", "dimensions",
  "count", "valueSum", "durationCount", "durationSumMs", "durationMaxMs", "durationBuckets", "firstSeenAt", "lastSeenAt"`;
const row = (hash: string, buckets: string) => `('2026-10-18 10:00:00', 'app', 'run_execution', 'info', '0.3.18',
  repeat('${hash}', 64), '{}', 3, 0, 3, 900, 400, ${buckets}, '2026-10-18 10:00:01', '2026-10-18 10:00:02')`;

// Release 0.3.18 writes 12-bucket histograms. They stay exactly as written; the
// relaxed check admits them and the 19-bucket layout, and no other length.
export const telemetryDurationBucketsFixtureSql = `
INSERT INTO "TelemetryCounter" (${columns})
VALUES ${row("a", "ARRAY[1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[]")};
`;

export const telemetryDurationBucketsProofSql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM "TelemetryCounter" WHERE "dimensionHash" = repeat('a', 64)
      AND "durationBuckets" = ARRAY[1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]::bigint[]) THEN
    RAISE EXCEPTION 'telemetry duration buckets: an earlier-layout row changed';
  END IF;
  INSERT INTO "TelemetryCounter" (${columns}) VALUES ${row("b", "array_fill(0::bigint, ARRAY[19])")};
  BEGIN
    INSERT INTO "TelemetryCounter" (${columns}) VALUES ${row("c", "array_fill(0::bigint, ARRAY[15])")};
    RAISE EXCEPTION 'telemetry duration buckets: a 15-bucket row was admitted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DELETE FROM "TelemetryCounter" WHERE "dimensionHash" = repeat('b', 64);
END $$;
`;
