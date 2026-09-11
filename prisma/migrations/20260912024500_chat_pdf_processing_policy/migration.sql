CREATE TYPE "ChatPdfProcessingMode" AS ENUM ('PREFER_CHAT_MODEL', 'USE_PDF_READER', 'READ_PAGE_IMAGES');
CREATE TYPE "ChatPdfFallbackMethod" AS ENUM ('PDF_READER', 'PAGE_IMAGES');

ALTER TABLE "SystemModelPolicy"
  ADD COLUMN "chatPdfProcessingMode" "ChatPdfProcessingMode" NOT NULL DEFAULT 'PREFER_CHAT_MODEL',
  ADD COLUMN "chatPdfFallbackMethod" "ChatPdfFallbackMethod" NOT NULL DEFAULT 'PAGE_IMAGES';

-- Existing Chat PDF assignments are page-image readers. The explicit default
-- keeps those installations on the prior route while making the fallback
-- choice durable for future admissions.
