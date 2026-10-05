-- The links of a scheduled task's prompt its runs may read with `fetch_url`:
-- SHA-256 digests of the normalized http(s) URLs the prompt's author
-- authorized (every link of an owner-written prompt, only already
-- user-authorized ones of a tool-written prompt). A prompt's text authorizes
-- nothing by itself, so existing tasks start without any: an owner edit of
-- the prompt authorizes its links. The check is valid at once, as every
-- existing row starts empty.
ALTER TABLE "ScheduledTask"
  ADD COLUMN "promptUrlDigests" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD CONSTRAINT "ScheduledTask_prompt_url_digests_check" CHECK (
    cardinality("promptUrlDigests") <= 100
  );
