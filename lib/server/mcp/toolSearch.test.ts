import { describe, expect, it } from "vitest";
import type { McpCapabilityCatalog } from "./runPlan";
import { mcpToolSearchTokens, searchMcpCatalog } from "./toolSearch";

type Tool = McpCapabilityCatalog["servers"][number]["tools"][number];

function server(serverName: string, description: string, tools: readonly Omit<Tool, "namespacedName">[]) {
  const namespace = serverName.toLowerCase().replace(/\W+/gu, "_");
  return { description, namespace, revisionId: `${namespace}-r1`, serverId: `${namespace}-id`, serverName,
    tools: tools.map((tool) => ({ ...tool, namespacedName: `${namespace}__${tool.originalName}` })) };
}

const catalog: McpCapabilityCatalog = { version: 1, servers: [
  server("GitHub", "Repositories, issues and pull requests", [
    { originalName: "create_issue", description: "Create a new issue in a repository.",
      arguments: [{ name: "repo", description: "Repository owner/name", types: ["string"] }] },
    { originalName: "list_issues", description: "List issues in a repository." },
    { originalName: "create_issue_comment", description: "Add a comment to an issue." },
    { originalName: "search", description: "Search code." }
  ]),
  server("Jira", "Задачи и проекты Jira", [
    { originalName: "createIssue", title: "Создать задачу", description: "Создаёт задачу в проекте." },
    { originalName: "searchIssues", title: "Найти задачи", description: "Ищет задачи по JQL." }
  ]),
  server("Calendar", "", [
    { originalName: "list-events", description: "List upcoming calendar events." },
    { originalName: "search", description: "Search events." }
  ])
] };

const names = (query: string, limit = 8) =>
  searchMcpCatalog(catalog, { query, limit }).matches.map((match) => match.namespacedName);

describe("MCP tool search tokens", () => {
  it("splits identifiers, normalizes script forms and stems light inflection", () => {
    expect(mcpToolSearchTokens("createIssueComment list_issues search-Events")).toEqual(
      mcpToolSearchTokens("create issue comments, listing issue search events"));
    expect(mcpToolSearchTokens("creating created create")).toEqual(["creat", "creat", "creat"]);
    expect(new Set(mcpToolSearchTokens("задача задачи задачу задачам"))).toEqual(new Set(["задач"]));
    expect(mcpToolSearchTokens("Ёлка ＡＢＣ")).toEqual(mcpToolSearchTokens("елка abc"));
    expect(mcpToolSearchTokens("the a x 7 for")).toEqual(["7"]);
  });
});

describe("MCP tool search", () => {
  it("ranks keyword queries across English and Russian forms", () => {
    expect(names("github create issue", 1)).toEqual(["github__create_issue"]);
    expect(names("list issues in a repository")[0]).toBe("github__list_issues");
    expect(names("создать задачу в jira")[0]).toBe("jira__createIssue");
    expect(names("найти задачи")[0]).toBe("jira__searchIssues");
    expect(names("upcoming calendar events")[0]).toBe("calendar__list-events");
  });

  it("gives a spelled full name a dominant bonus, longer names first", () => {
    const result = searchMcpCatalog(catalog, { query: "create_issue_comment please", limit: 3 });
    expect(result.matches.map((match) => [match.namespacedName, match.exact])).toEqual([
      ["github__create_issue_comment", true], ["github__create_issue", true], ["jira__createIssue", true]
    ]);
    // A one-word name is exact only as the whole query.
    expect(searchMcpCatalog(catalog, { query: "search issues", limit: 8 }).matches
      .filter((match) => match.exact).map((match) => match.namespacedName)).toEqual(["jira__searchIssues"]);
    expect(searchMcpCatalog(catalog, { query: "search", limit: 8 }).matches.filter((match) => match.exact))
      .toHaveLength(2);
  });

  it("returns only positive scores, honors the limit and orders ties deterministically", () => {
    expect(names("unrelated weather forecast")).toEqual([]);
    expect(names("search", 8)).toEqual(["calendar__search", "github__search", "jira__searchIssues"]);
    expect(names("issue", 2)).toHaveLength(2);
    expect(names("issue", 0)).toEqual([]);
    const copy = structuredClone(catalog);
    copy.servers.reverse();
    expect(searchMcpCatalog(copy, { query: "issue repository", limit: 8 }).matches)
      .toEqual(searchMcpCatalog(catalog, { query: "issue repository", limit: 8 }).matches);
  });

  it("loads exact select: names in entry order and reports unknown ones", () => {
    const result = searchMcpCatalog(catalog, {
      query: "SELECT: jira__searchIssues, github / Create_Issue, search, `missing_tool`, Создать задачу, jira__searchIssues",
      limit: 8
    });
    expect(result).toMatchObject({ mode: "select", unknownNames: ["missing_tool"], candidateCount: 8 });
    expect(result.matches.map((match) => match.namespacedName)).toEqual([
      "jira__searchIssues", "github__create_issue", "calendar__search", "github__search", "jira__createIssue"
    ]);
    expect(result.matches.every((match) => match.exact)).toBe(true);
    expect(searchMcpCatalog(catalog, { query: "select:search,list_issues", limit: 2 }).matches
      .map((match) => match.namespacedName)).toEqual(["calendar__search", "github__search"]);
  });

  it("treats ineligible tools exactly like absent ones", () => {
    const eligible = (name: string) => !name.startsWith("github__");
    expect(searchMcpCatalog(catalog, { query: "select:github__create_issue", limit: 8, eligible }))
      .toEqual({ mode: "select", matches: [], unknownNames: ["github__create_issue"], candidateCount: 4 });
    expect(searchMcpCatalog(catalog, { query: "create issue", limit: 8, eligible }).matches
      .map((match) => match.namespacedName)).toEqual(["jira__createIssue", "jira__searchIssues"]);
  });

  it("stays fast for the plan's largest catalog", () => {
    const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const large: McpCapabilityCatalog = { version: 1, servers: Array.from({ length: 64 }, (_, s) =>
      server(`Server ${s}`, `Service ${words[s % 8]}`, Array.from({ length: 1_024 }, (_, t) => ({
        originalName: `${words[t % 8]}_${words[(t >> 3) % 8]}_tool_${t}`,
        description: `Handles ${words[(t >> 6) % 8]} records for ${words[s % 8]} accounts.`,
        arguments: [{ name: `${words[t % 8]}Id`, description: "Record identifier", types: ["string"] }]
      })))) };
    const started = performance.now();
    const first = searchMcpCatalog(large, { query: "gamma delta records", limit: 8 });
    const second = searchMcpCatalog(large, { query: "select:Server 3/beta_alpha_tool_1", limit: 8 });
    expect(first.matches).toHaveLength(8);
    expect(first.candidateCount).toBe(65_536);
    expect(second.matches.map((match) => match.namespacedName)).toEqual(["server_3__beta_alpha_tool_1"]);
    expect(performance.now() - started).toBeLessThan(10_000);
    const cached = performance.now();
    searchMcpCatalog(large, { query: "epsilon theta accounts", limit: 8 });
    expect(performance.now() - cached).toBeLessThan(1_000);
  }, 30_000);
});
