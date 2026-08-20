import { describe, expect, it } from "vitest";
import {
  knowledgeProfileBenchmarkCliErrorCode,
  KNOWLEDGE_PROFILE_BENCHMARK_CLI_USAGE,
  parseKnowledgeProfileBenchmarkCliArgs,
  runKnowledgeProfileBenchmarkCli
} from "./profileBenchmarkCli";

describe("Knowledge profile benchmark CLI", () => {
  it("keeps every external execution lane explicit and off by default", () => {
    expect(parseKnowledgeProfileBenchmarkCliArgs([])).toEqual({
      executePaidRealEmbedding: false,
      executePaidSystemModel: false,
      help: false,
      localRunnerConfigPath: null,
      prepareReviewDirectory: null,
      reviewDirectory: null
    });
    expect(parseKnowledgeProfileBenchmarkCliArgs([
      "--local-runner-config",
      "/tmp/local-reranker.json",
      "--execute-paid-real-embedding",
      "--execute-paid-system-model",
      "--prepare-review-directory",
      "/tmp/aiqsa-knowledge-reranker-review-ghijkl"
    ])).toEqual({
      executePaidRealEmbedding: true,
      executePaidSystemModel: true,
      help: false,
      localRunnerConfigPath: "/tmp/local-reranker.json",
      prepareReviewDirectory: "/tmp/aiqsa-knowledge-reranker-review-ghijkl",
      reviewDirectory: null
    });
  });

  it("rejects ambiguous or relative runtime paths", () => {
    expect(() => parseKnowledgeProfileBenchmarkCliArgs([
      "--local-runner-config",
      "./runner.json"
    ])).toThrow("knowledge_profile_benchmark_cli_path_invalid");
    expect(() => parseKnowledgeProfileBenchmarkCliArgs([
      "--review-directory",
      "/tmp/one",
      "--review-directory",
      "/tmp/two"
    ])).toThrow("knowledge_profile_benchmark_cli_argument_duplicate");
    expect(() => parseKnowledgeProfileBenchmarkCliArgs(["--execute-system-model"]))
      .toThrow("knowledge_profile_benchmark_cli_argument_invalid");
    expect(() => parseKnowledgeProfileBenchmarkCliArgs([
      "--prepare-review-directory",
      "/tmp/aiqsa-knowledge-reranker-review-abcdef"
    ])).toThrow("knowledge_profile_benchmark_real_embedding_required");
    expect(() => parseKnowledgeProfileBenchmarkCliArgs([
      "--review-directory",
      "/tmp/aiqsa-knowledge-reranker-review-abcdef"
    ])).toThrow("knowledge_profile_benchmark_real_embedding_required");
  });

  it("serves help without resolving a database or candidate runtime", async () => {
    expect(KNOWLEDGE_PROFILE_BENCHMARK_CLI_USAGE).toContain("--execute-paid-system-model");
    await expect(runKnowledgeProfileBenchmarkCli(["--help"])).resolves.toBeNull();
  });

  it("normalizes parser/provider failures without echoing private error detail", () => {
    expect(knowledgeProfileBenchmarkCliErrorCode(
      new Error("knowledge_reranker_review_directory_invalid")
    )).toBe("knowledge_reranker_review_directory_invalid");
    expect(knowledgeProfileBenchmarkCliErrorCode(
      new Error("invalid value contained private review text")
    )).toBe("knowledge_profile_benchmark_failed");
  });
});
