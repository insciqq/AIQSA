ALTER TABLE "KnowledgeChunk"
  ADD COLUMN "retrievalBucket" smallint GENERATED ALWAYS AS (
    get_byte(decode(md5("knowledgeBaseId"), 'hex'), 0) % 16
  ) STORED;

ALTER TABLE "KnowledgeChunk"
  ADD CONSTRAINT "KnowledgeChunk_retrieval_bucket_check"
  CHECK ("retrievalBucket" >= 0 AND "retrievalBucket" < 16);

CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_00_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 0;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_01_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 1;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_02_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 2;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_03_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 3;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_04_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 4;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_05_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 5;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_06_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 6;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_07_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 7;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_08_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 8;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_09_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 9;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_10_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 10;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_11_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 11;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_12_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 12;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_13_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 13;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_14_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 14;
CREATE INDEX "KnowledgeChunk_embedding_1024_bucket_15_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1024)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1024 AND "retrievalBucket" = 15;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_00_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 0;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_01_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 1;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_02_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 2;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_03_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 3;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_04_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 4;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_05_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 5;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_06_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 6;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_07_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 7;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_08_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 8;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_09_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 9;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_10_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 10;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_11_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 11;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_12_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 12;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_13_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 13;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_14_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 14;
CREATE INDEX "KnowledgeChunk_embedding_1536_bucket_15_hnsw_idx"
  ON "KnowledgeChunk" USING hnsw ((("embedding")::vector(1536)) vector_cosine_ops)
  WHERE "embeddingDimension" = 1536 AND "retrievalBucket" = 15;
