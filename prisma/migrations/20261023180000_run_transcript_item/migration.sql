-- The native agent engine's provider-neutral transcript: one immutable row per
-- item of a native run (user follow-up, assistant text, reasoning, tool call,
-- tool result, compaction) in run order. A chat's transcript is the items of
-- the native runs on its branch; earlier old-core answers stay `Message` text.
-- Rows belong to their run through the run's owner and chat, so a row can
-- never name another user's or another chat's run, and they go with it. A
-- large tool output is bounded here and kept whole as its call's
-- `ToolObservation`. Expand only: previous-release writers never read or write
-- the table.

-- CreateEnum
CREATE TYPE "RunTranscriptItemKind" AS ENUM ('user', 'assistant_text', 'reasoning', 'tool_call', 'tool_result', 'compaction');

-- CreateTable
CREATE TABLE "RunTranscriptItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "modelRunId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "RunTranscriptItemKind" NOT NULL,
    "callId" VARCHAR(256),
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunTranscriptItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RunTranscriptItem_sequence_check" CHECK ("sequence" >= 0),
    CONSTRAINT "RunTranscriptItem_body_check" CHECK (jsonb_typeof("body") = 'object'),
    -- Exactly tool calls and their results carry the provider call id that pairs them.
    CONSTRAINT "RunTranscriptItem_call_check" CHECK (
        ("kind" IN ('tool_call', 'tool_result')) = ("callId" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "RunTranscriptItem_modelRunId_sequence_key" ON "RunTranscriptItem"("modelRunId", "sequence");

-- AddForeignKey
ALTER TABLE "RunTranscriptItem" ADD CONSTRAINT "RunTranscriptItem_modelRun_fkey" FOREIGN KEY ("userId", "chatId", "modelRunId") REFERENCES "ModelRun"("userId", "chatId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
