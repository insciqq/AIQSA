export const RUN_FOLLOWUPS_MIGRATION = "20260922103000_run_followups";
export const runFollowupsFixtureSql = `
INSERT INTO "User" (id,"displayName",status,"updatedAt") VALUES ('followup-owner','Fixture owner','active',now());
INSERT INTO "Chat" (id,"userId",title,"updatedAt") VALUES ('followup-chat','followup-owner','Fixture',now());
INSERT INTO "Message" (id,"chatId",role,content,"updatedAt")
VALUES ('followup-question','followup-chat','user','{"blocks":[{"type":"text","text":"Original"}]}',now());
INSERT INTO "ModelRun" (id,"userId","chatId","userMessageId",provider,"modelId",status,"normalizedRequest","updatedAt")
VALUES ('followup-existing','followup-owner','followup-chat','followup-question','fake','fake-qsa','complete','{}',now());
CREATE TABLE "FollowupPredecessorFixture" AS SELECT to_jsonb(run) snapshot FROM "ModelRun" run WHERE id='followup-existing';
`;
export const runFollowupsProofSql = `
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM "ModelRun" run, "FollowupPredecessorFixture" old
   WHERE run.id='followup-existing' AND to_jsonb(run) - ARRAY['followupMode','followupRevision','followupBudgetTokens',
     'followupClosedAt','followupKnowledgeRevision','followupKnowledgeOffset'] = old.snapshot
     AND run."followupMode" IS NULL AND run."followupRevision"=0) THEN
   RAISE EXCEPTION 'followup_predecessor_changed'; END IF;
END $$;
BEGIN;
-- A previous writer still creates and completes an ordinary run.
INSERT INTO "ModelRun" (id,"userId","chatId","userMessageId",provider,"modelId",status,"normalizedRequest","updatedAt")
VALUES ('followup-probe','followup-owner','followup-chat','followup-question','fake','fake-qsa','streaming','{}',now());
UPDATE "ModelRun" SET status='complete' WHERE id='followup-probe';
UPDATE "ModelRun" SET status='streaming',"followupMode"='chat',"followupBudgetTokens"=100 WHERE id='followup-probe';
INSERT INTO "RunFollowup" (id,"chatId","modelRunId",ordinal,nonce,text,"authorUserId","authorName")
VALUES ('followup-receipt','followup-chat','followup-probe',1,'nonce','Clarification','followup-owner','Fixture owner');
UPDATE "ModelRun" SET "followupRevision"=1 WHERE id='followup-probe';
DO $$ BEGIN
 BEGIN
  UPDATE "ModelRun" SET status='complete' WHERE id='followup-probe';
  RAISE EXCEPTION 'followup_early_completion_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "RunFollowup" SET text='Overwritten' WHERE id='followup-receipt';
  RAISE EXCEPTION 'followup_history_mutation_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  INSERT INTO "RunFollowup" (id,"chatId","modelRunId",ordinal,nonce,text,"authorName")
  VALUES ('followup-foreign','wrong-chat','followup-probe',2,'another','Text','Fixture');
  SET CONSTRAINTS "RunFollowup_chatId_modelRunId_fkey" IMMEDIATE;
  RAISE EXCEPTION 'followup_foreign_chat_accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
UPDATE "RunFollowup" SET "deliveredAt"=now(),"precedingText"='Partial' WHERE id='followup-receipt';
UPDATE "ModelRun" SET status='complete',"followupClosedAt"=now() WHERE id='followup-probe';
INSERT INTO "Message" (id,"chatId",role,content,"branchFollowups","updatedAt")
VALUES ('followup-copy','followup-chat','assistant','{"blocks":[]}','{"available":false,"entries":[]}',now());
DO $$ BEGIN
 BEGIN
  UPDATE "RunFollowup" SET "precedingText"='Overwritten' WHERE id='followup-receipt';
  RAISE EXCEPTION 'followup_partial_mutation_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "Message" SET "branchFollowups"=NULL WHERE id='followup-copy';
  RAISE EXCEPTION 'followup_copy_mutation_accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
DELETE FROM "User" WHERE id='followup-owner';
SET CONSTRAINTS "RunFollowup_chatId_modelRunId_fkey" IMMEDIATE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "RunFollowup" WHERE id='followup-receipt') THEN
  RAISE EXCEPTION 'followup_cascade_failed'; END IF;
END $$;
ROLLBACK;
`;
