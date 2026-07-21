# Schema integrity hardening migration notes

`migration.sql` is authoritative. Its explicit `BEGIN`/`COMMIT` wrapper keeps preflight, the known backfill, type conversion, index replacement, and constraint publication atomic when `prisma migrate deploy` executes the file. It never deletes ambiguous rows or guesses ownership/terminal state.

## Operator preflight

The migration performs these checks itself and reports a bounded sample of internal ids. An operator can inspect the complete affected rows before deploy with read-only queries:

```sql
SELECT child."id", child."chatId", child."parentMessageId", parent."chatId" AS "parentChatId"
FROM "Message" child
LEFT JOIN "Message" parent ON parent."id" = child."parentMessageId"
WHERE child."parentMessageId" IS NOT NULL
  AND (parent."id" IS NULL OR child."chatId" IS DISTINCT FROM parent."chatId")
ORDER BY child."id";

SELECT chat."id", chat."activeLeafMessageId", leaf."chatId" AS "leafChatId"
FROM "Chat" chat
LEFT JOIN "Message" leaf ON leaf."id" = chat."activeLeafMessageId"
WHERE chat."activeLeafMessageId" IS NOT NULL
  AND (leaf."id" IS NULL OR chat."id" IS DISTINCT FROM leaf."chatId")
ORDER BY chat."id";

SELECT "id", "userId", "groupId", "provider", "modelId", "searchStrategy"
FROM "AccessGrant"
WHERE num_nonnulls("userId", "groupId") <> 1
   OR NOT (
     (
       "provider" IS NOT NULL
       AND btrim("provider") <> ''
       AND "searchStrategy" IS NULL
       AND ("modelId" IS NULL OR btrim("modelId") <> '')
     )
     OR (
       "provider" IS NULL
       AND "modelId" IS NULL
       AND "searchStrategy" IS NOT NULL
       AND btrim("searchStrategy") <> ''
     )
   )
ORDER BY "id";
```

The status preflights and accepted values are kept directly beside their enum conversion in `migration.sql`. A known legacy `Message.status = 'in_progress'` is the only automatic backfill; it maps to the equivalent message state `streaming`. Any other unknown value aborts the migration with a hint.

## Verification

After deploy, run the repeatable seed and both database smokes through the repository-owned Compose environment:

```bash
docker compose run --rm app sh -lc 'npm run db:migrate:deploy && npm run db:seed && npm run db:seed:smoke && npm run db:integrity:smoke'
npm run db:migration:contract
```

`db:integrity:smoke` verifies validated catalog constraints, positive same-chat/delete behavior, explicit cross-user rejection, all six supported grant shapes, and exact negative FK/check/enum failures. Every fixture mutation runs in a transaction that is rolled back. The host-side `db:migration:contract` creates and removes disposable pre-target databases to prove exact dirty-legacy preflight failures, whole-file rollback after failure, and the allowed `in_progress` to `streaming` backfill.

## Manual rollback

`rollback.sql` is the data-preserving schema down path. Quiesce application writes, take the normal database backup, execute that file with stop-on-error enabled, and only then deploy the compatible previous application version. It preserves all rows, restores the former single-column parent/active-leaf FKs and TEXT status columns, and removes the composite/check protection. The known `Message.status` normalization is intentionally not reversible: a pre-migration `in_progress` row remains `streaming` because it cannot be distinguished safely from rows that were already streaming. The down path does not reverse unrelated later migrations; review the migration ledger before using it.
