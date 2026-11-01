import { PROPOSE_RESEARCH_PLAN_TOOL_NAME } from "../../contracts/research";

/** A proposal as `propose_research_plan` takes it, around the questions of a test's plan. */
export const proposalArguments = (plan: Readonly<{ questions: readonly unknown[]; skipped_source_classes?: readonly unknown[] }>) => ({
  assumptions: ["The buyer sleeps on their side."],
  branches: [],
  criteria: [{ criterion: "Durability", key: "durability", why: "It is bought for years." }],
  questions: plan.questions,
  rows: [],
  skipped_source_classes: plan.skipped_source_classes ?? [],
  steps: ["Find what matters", "Read the tests", "Read what owners say", "Compare and pick"],
  understood: "A mattress for many years."
});

export const proposeCall = (plan: Parameters<typeof proposalArguments>[0], id = "call-plan") =>
  ({ arguments: proposalArguments(plan) as Record<string, unknown>, id, name: PROPOSE_RESEARCH_PLAN_TOOL_NAME });
