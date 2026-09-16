CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Announcement_publication_check" CHECK (NOT "published" OR "publishedAt" IS NOT NULL),
    CONSTRAINT "Announcement_content_check" CHECK (
      char_length(btrim("title")) BETWEEN 1 AND 160 AND
      char_length(btrim("body")) BETWEEN 1 AND 20000 AND "version" > 0
    )
);

CREATE TABLE "AnnouncementRead" (
    "userId" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnnouncementRead_pkey" PRIMARY KEY ("userId", "announcementId"),
    CONSTRAINT "AnnouncementRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AnnouncementRead_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Announcement_published_publishedAt_id_idx" ON "Announcement"("published", "publishedAt", "id");
CREATE INDEX "Announcement_createdAt_id_idx" ON "Announcement"("createdAt", "id");
CREATE INDEX "AnnouncementRead_announcementId_idx" ON "AnnouncementRead"("announcementId");
