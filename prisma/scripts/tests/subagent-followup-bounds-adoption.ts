/**
 * `20261030020000_subagent_background_runs` widens the follow-up bounds so an
 * answer's revision and ordinals hold the user's 32 follow-ups beside up to
 * 64 sub-agent callbacks. Widen only: a run and follow-up at the old bound
 * stay untouched, the previous release's writers keep working, the new
 * bound refuses what is past it, and the completion guard still holds.
 */
export const SUBAGENT_FOLLOWUP_BOUNDS_MIGRATION = "20261030020000_subagent_background_runs";

export const subagentFollowupBoundsFixtureSql = `
INSERT INTO "User" (id,"displayName",status,"updatedAt") VALUES ('bounds-owner','Fixture owner','active',now());
INSERT INTO "Chat" (id,"userId",title,"updatedAt") VALUES ('bounds-chat','bounds-owner','Fixture',now());
INSERT INTO "Message" (id,"chatId",role,content,"updatedAt")
VALUES ('bounds-question','bounds-chat','user','{"blocks":[{"type":"text","text":"Original"}]}',now());
INSERT INTO "ModelRun" (id,"userId","chatId","userMessageId",provider,"modelId",status,"normalizedRequest","followupMode",
  "followupRevision","updatedAt")
VALUES ('bounds-run','bounds-owner','bounds-chat','bounds-question','fake','fake-qsa','streaming','{}','chat',32,now());
INSERT INTO "RunFollowup" (id,"chatId","modelRunId",ordinal,nonce,text,"authorUserId","authorName")
VALUES ('bounds-last-old','bounds-chat','bounds-run',32,'nonce-32','Clarification','bounds-owner','Fixture owner');
CREATE TABLE "FollowupBoundsFixture" AS
  SELECT (SELECT to_jsonb(run) FROM "ModelRun" run WHERE id='bounds-run') AS run,
    (SELECT to_jsonb(followup) FROM "RunFollowup" followup WHERE id='bounds-last-old') AS followup;
`;

export const subagentFollowupBoundsProofSql = `
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "FollowupBoundsFixture" old
   WHERE old.run = (SELECT to_jsonb(run) FROM "ModelRun" run WHERE id='bounds-run')
     AND old.followup = (SELECT to_jsonb(followup) FROM "RunFollowup" followup WHERE id='bounds-last-old')) THEN
   RAISE EXCEPTION 'followup_bounds_existing_rows_changed'; END IF;
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('ModelRun_followup_bounds','RunFollowup_bounds') AND NOT convalidated) THEN
   RAISE EXCEPTION 'followup_bounds_not_validated'; END IF;
END $$;
BEGIN;
-- A callback past the user's 32 goes in, up to the widened bound.
INSERT INTO "RunFollowup" (id,"chatId","modelRunId",ordinal,nonce,text,"authorName",origin,"subagentTurnId")
VALUES ('bounds-user-only','bounds-chat','bounds-run',96,'nonce-96','Clarification','Fixture owner','user',NULL);
UPDATE "ModelRun" SET "followupRevision"=96 WHERE id='bounds-run';
DO $$ BEGIN
 BEGIN
  INSERT INTO "RunFollowup" (id,"chatId","modelRunId",ordinal,nonce,text,"authorName")
  VALUES ('bounds-past','bounds-chat','bounds-run',97,'nonce-97','Too late','Fixture owner');
  RAISE EXCEPTION 'followup_ordinal_past_bound_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "ModelRun" SET "followupRevision"=97 WHERE id='bounds-run';
  RAISE EXCEPTION 'followup_revision_past_bound_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "ModelRun" SET status='complete' WHERE id='bounds-run';
  RAISE EXCEPTION 'followup_completion_guard_lost';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
`;
