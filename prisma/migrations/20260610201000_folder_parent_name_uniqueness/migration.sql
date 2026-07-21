-- Scope folder name uniqueness to sibling folders while keeping top-level names unique per user.
DROP INDEX "Folder_userId_name_key";

CREATE UNIQUE INDEX "Folder_userId_parentId_name_key"
ON "Folder"("userId", "parentId", "name");

CREATE UNIQUE INDEX "Folder_userId_top_level_name_key"
ON "Folder"("userId", "name")
WHERE "parentId" IS NULL;
