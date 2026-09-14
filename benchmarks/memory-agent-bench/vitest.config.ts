import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["benchmarks/memory-agent-bench/*.test.ts"] } });
