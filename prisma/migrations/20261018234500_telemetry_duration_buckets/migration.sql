-- Finer duration histogram buckets: 45 s, 90 s and 3 min between the earlier
-- bounds, and 10, 15, 20 and 30 min above 5 min, so long runs and their
-- percentiles no longer collapse into "over 5 min". New writers store 19
-- buckets. Rows of the earlier 12-bucket layout stay exactly as written:
-- readers map them by array length until counter retention (30 days) removes
-- them, and previous-release writers keep appending them during Compose
-- replacement. Only the check changes; it still refuses any other length,
-- NULL elements and negative counts. The table holds 30 days of hourly
-- counters, so revalidating it is one short statement.
ALTER TABLE "TelemetryCounter" DROP CONSTRAINT "TelemetryCounter_duration_buckets_check";
ALTER TABLE "TelemetryCounter" ADD CONSTRAINT "TelemetryCounter_duration_buckets_check" CHECK (
  "durationBuckets" IS NOT NULL
  AND cardinality("durationBuckets") IN (12, 19)
  AND array_position("durationBuckets", NULL) IS NULL
  AND 0 <= ALL ("durationBuckets")
);
