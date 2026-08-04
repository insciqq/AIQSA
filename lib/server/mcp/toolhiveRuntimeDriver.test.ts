import { describe, expect, it, vi } from "vitest";
import { McpClientSessionError } from "./clientSession";
import { ToolHiveClient, type ToolHiveFetch, type ToolHiveWorkloadStatus } from "./toolhiveClient";
import {
  ToolHiveMcpRuntimeDriver,
  toolHiveOwnedWorkloadName,
  toolHiveOwnerGroupName
} from "./toolhiveRuntimeDriver";

const ownerToken = "0123456789abcdef";
const generationOne = "0123456789abcdef01234567";
const generationTwo = "89abcdef0123456789abcdef";
const groupName = `aiqsa-${ownerToken}`;
const image = "example.invalid/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

type FakeWorkload = {
  detail: Record<string, unknown>;
  group: string;
  name: string;
  port: number;
  proxyMode: string;
  remote: boolean;
  status: ToolHiveWorkloadStatus;
  transport: string;
  url: string;
};

function fakeToolHive() {
  const groups = new Set<string>();
  const workloads = new Map<string, FakeWorkload>();
  const requests: Array<Readonly<{
    body: Record<string, unknown> | null;
    method: string;
    path: string;
  }>> = [];

  function add(input: {
    cmdArguments?: readonly string[];
    envVars?: Readonly<Record<string, string>>;
    generationToken: string;
    group?: string;
    name?: string;
    status?: ToolHiveWorkloadStatus;
  }): FakeWorkload {
    const selectedGroup = input.group ?? groupName;
    const name = input.name ?? toolHiveOwnedWorkloadName(ownerToken, input.generationToken);
    const port = 31_337 + workloads.size;
    const workload: FakeWorkload = {
      detail: {
        cmd_arguments: [...(input.cmdArguments ?? ["--stdio"])],
        env_vars: {
          ...(input.envVars ?? { MEM0_API_KEY: "personal-key" }),
          MCP_TRANSPORT: "stdio"
        },
        group: selectedGroup,
        host: "0.0.0.0",
        image,
        name,
        network_isolation: false,
        proxy_mode: "streamable-http",
        proxy_port: port,
        transport: "stdio"
      },
      group: selectedGroup,
      name,
      port,
      proxyMode: "streamable-http",
      remote: false,
      status: input.status ?? "running",
      transport: "stdio",
      url: `http://127.0.0.1:${port}/mcp`
    };
    workloads.set(name, workload);
    return workload;
  }

  const fetch = vi.fn<ToolHiveFetch>(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    requests.push({ body, method, path: `${url.pathname}${url.search}` });

    if (url.pathname === "/health") return new Response(null, { status: 204 });
    if (url.pathname === "/api/v1beta/version") return json({ version: "v0.40.1" });
    if (url.pathname === "/api/v1beta/groups" && method === "GET") {
      return json({ groups: [...groups].map((name) => ({ name })) });
    }
    if (url.pathname === "/api/v1beta/groups" && method === "POST") {
      const name = String(body?.name);
      if (groups.has(name)) return new Response("already exists", { status: 409 });
      groups.add(name);
      return json({ name }, 201);
    }
    if (url.pathname.startsWith("/api/v1beta/groups/") && method === "DELETE") {
      groups.delete(decodeURIComponent(url.pathname.slice("/api/v1beta/groups/".length)));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/v1beta/workloads" && method === "GET") {
      const selectedGroup = url.searchParams.get("group");
      return json({
        workloads: [...workloads.values()]
          .filter((workload) => !selectedGroup || workload.group === selectedGroup)
          .map((workload) => ({
            group: workload.group,
            name: workload.name,
            port: workload.port,
            proxy_mode: workload.proxyMode,
            remote: workload.remote,
            status: workload.status,
            transport_type: workload.transport,
            url: workload.url
          }))
      });
    }
    if (url.pathname === "/api/v1beta/workloads" && method === "POST") {
      const name = String(body?.name);
      if (workloads.has(name)) return new Response("already exists", { status: 409 });
      const port = 31_337 + workloads.size;
      const requestedImage = String(body?.image);
      const selectedImage = /^(?:npx|uvx):\/\//u.test(requestedImage)
        ? "toolhivelocal/example-mcp:resolved-1-2-3"
        : requestedImage;
      const requestedEnvironment = body?.env_vars && typeof body.env_vars === "object"
        ? body.env_vars as Record<string, unknown>
        : {};
      workloads.set(name, {
        detail: {
          ...body,
          env_vars: { ...requestedEnvironment, MCP_TRANSPORT: "stdio" },
          image: selectedImage,
          proxy_port: port
        },
        group: String(body?.group),
        name,
        port,
        proxyMode: String(body?.proxy_mode),
        remote: false,
        status: "starting",
        transport: String(body?.transport),
        url: `http://127.0.0.1:${port}/mcp`
      });
      return json({ name, port }, 201);
    }

    const workloadPath = "/api/v1beta/workloads/";
    if (url.pathname.startsWith(workloadPath)) {
      const suffix = url.pathname.slice(workloadPath.length);
      const [encodedName, action] = suffix.split("/");
      const name = decodeURIComponent(encodedName ?? "");
      const workload = workloads.get(name);
      if (!workload) return new Response("not found", { status: 404 });
      if (!action && method === "GET") return json(workload.detail);
      if (action === "status" && method === "GET") return json({ status: workload.status });
      if (action === "restart" && method === "POST") {
        workload.status = "running";
        return new Response(null, { status: 202 });
      }
      if (action === "stop" && method === "POST") {
        workload.status = "stopping";
        return new Response(null, { status: 202 });
      }
      if (!action && method === "DELETE") {
        workload.status = "removing";
        return new Response(null, { status: 202 });
      }
    }
    return new Response("unexpected route", { status: 500 });
  });

  return {
    add,
    advance() {
      for (const [name, workload] of workloads) {
        if (workload.status === "starting") workload.status = "running";
        else if (workload.status === "stopping") workload.status = "stopped";
        else if (workload.status === "removing") workloads.delete(name);
      }
    },
    fetch,
    groups,
    requests,
    workloads
  };
}

function harness() {
  const api = fakeToolHive();
  let now = 0;
  const client = new ToolHiveClient({
    baseUrl: "http://toolhive-runtime:8080",
    fetch: api.fetch
  });
  const driver = new ToolHiveMcpRuntimeDriver({
    client,
    lifecycleTimeoutMs: 1_000,
    now: () => now,
    ownerToken,
    pollIntervalMs: 10,
    sleep: async (ms) => {
      now += ms;
      api.advance();
    }
  });
  return { api, client, driver };
}

describe("ToolHive MCP runtime driver", () => {
  it("uses opaque deterministic ownership names", () => {
    expect(toolHiveOwnerGroupName(ownerToken)).toBe(groupName);
    expect(toolHiveOwnedWorkloadName(ownerToken, generationOne)).toBe(
      `${groupName}-${generationOne}`
    );
    expect(() => toolHiveOwnerGroupName("user@example.com")).toThrowError(
      "toolhive_ownership_invalid"
    );
    expect(() => toolHiveOwnedWorkloadName(ownerToken, "short")).toThrowError(
      "toolhive_ownership_invalid"
    );
  });

  it("initializes the exact group, creates a fixed local workload, polls and probes it", async () => {
    const test = harness();
    const probe = vi.fn(async () => undefined);
    await test.driver.initialize();

    await expect(test.driver.ensureReadyWorkload({
      cmdArguments: ["--stdio"],
      envVars: { MEM0_API_KEY: "personal-key" },
      generationToken: generationOne,
      image
    }, { probe })).resolves.toEqual({
      name: `${groupName}-${generationOne}`,
      port: 31_337,
      status: "running",
      url: "http://toolhive-runtime:31337/mcp"
    });

    expect(test.api.groups).toEqual(new Set([groupName]));
    const create = test.api.requests.find((request) =>
      request.method === "POST" && request.path === "/api/v1beta/workloads"
    );
    expect(create?.body).toEqual({
      cmd_arguments: ["--stdio"],
      env_vars: { MEM0_API_KEY: "personal-key" },
      group: groupName,
      host: "0.0.0.0",
      image,
      name: `${groupName}-${generationOne}`,
      network_isolation: false,
      proxy_mode: "streamable-http",
      proxy_port: 0,
      transport: "stdio"
    });
    expect(probe).toHaveBeenCalledWith("http://toolhive-runtime:31337/mcp", undefined);
  });

  it("accepts ToolHive's generated local image when first materializing an exact package URI", async () => {
    const test = harness();

    await expect(test.driver.ensureReadyWorkload({
      cmdArguments: [],
      envVars: {},
      generationToken: generationOne,
      image: "npx://example-mcp@1.2.3"
    }, { probe: async () => undefined })).resolves.toMatchObject({ status: "running" });

    expect(test.api.workloads.get(`${groupName}-${generationOne}`)?.detail.image).toBe(
      "toolhivelocal/example-mcp:resolved-1-2-3"
    );
  });

  it("rejects environment fields beyond ToolHive's fixed stdio marker", async () => {
    const test = harness();
    test.api.groups.add(groupName);
    const workload = test.api.add({ generationToken: generationOne });
    workload.detail.env_vars = {
      MEM0_API_KEY: "personal-key",
      MCP_TRANSPORT: "stdio",
      UNEXPECTED: "value"
    };

    await expect(test.driver.ensureReadyWorkload({
      cmdArguments: ["--stdio"],
      envVars: { MEM0_API_KEY: "personal-key" },
      generationToken: generationOne,
      image
    }, { probe: async () => undefined })).rejects.toMatchObject({
      code: "toolhive_workload_conflict"
    });
  });

  it("restarts a matching running workload when its proxy probe fails", async () => {
    const test = harness();
    test.api.groups.add(groupName);
    test.api.add({ generationToken: generationOne });
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error("raw proxy failure"))
      .mockResolvedValueOnce(undefined);

    await expect(test.driver.ensureReadyWorkload({
      cmdArguments: ["--stdio"],
      envVars: { MEM0_API_KEY: "personal-key" },
      generationToken: generationOne,
      image
    }, { probe })).resolves.toMatchObject({ status: "running" });

    expect(test.api.requests).toContainEqual({
      body: null,
      method: "POST",
      path: `/api/v1beta/workloads/${groupName}-${generationOne}/restart`
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    "mcp_call_result_too_large",
    "mcp_initialize_response_too_large",
    "mcp_inventory_response_too_large",
    "mcp_response_too_large"
  ] as const)("preserves terminal MCP response error %s without restarting or polling", async (code) => {
    const test = harness();
    test.api.groups.add(groupName);
    test.api.add({ generationToken: generationOne });
    const failure = new McpClientSessionError({ code, operation: "initialize" });
    const probe = vi.fn(async () => {
      throw failure;
    });

    const readiness = test.driver.ensureReadyWorkload({
      cmdArguments: ["--stdio"],
      envVars: { MEM0_API_KEY: "personal-key" },
      generationToken: generationOne,
      image
    }, { probe });

    await expect(readiness).rejects.toBe(failure);
    expect(probe).toHaveBeenCalledOnce();
    expect(test.api.requests).not.toContainEqual({
      body: null,
      method: "POST",
      path: `/api/v1beta/workloads/${groupName}-${generationOne}/restart`
    });
  });

  it("rejects an existing workload with different secret configuration without exposing it", async () => {
    const test = harness();
    const hidden = "wrong-secret-value";
    test.api.groups.add(groupName);
    test.api.add({
      envVars: { MEM0_API_KEY: hidden },
      generationToken: generationOne
    });

    let failure: unknown;
    try {
      await test.driver.ensureReadyWorkload({
        cmdArguments: ["--stdio"],
        envVars: { MEM0_API_KEY: "expected-secret-value" },
        generationToken: generationOne,
        image
      }, { probe: async () => undefined });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "toolhive_workload_conflict" });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(hidden);
  });

  it("polls stop and delete to completion", async () => {
    const test = harness();
    test.api.groups.add(groupName);
    test.api.add({ generationToken: generationOne });

    await expect(test.driver.stopOwnedWorkload(generationOne)).resolves.toBe(true);
    expect(test.api.workloads.get(`${groupName}-${generationOne}`)?.status).toBe("stopped");
    await expect(test.driver.deleteOwnedWorkload(generationOne)).resolves.toBe(true);
    expect(test.api.workloads.has(`${groupName}-${generationOne}`)).toBe(false);
  });

  it("cleanup deletes only exact owned names and leaves unknown group members alone", async () => {
    const test = harness();
    test.api.groups.add(groupName);
    test.api.add({ generationToken: generationOne });
    test.api.add({ generationToken: generationTwo });
    const unknownName = `${groupName}-not-an-opaque-generation`;
    test.api.add({
      generationToken: generationTwo,
      name: unknownName
    });

    await expect(test.driver.cleanupOwnedWorkloads({
      keepGenerationTokens: [generationOne]
    })).resolves.toEqual([`${groupName}-${generationTwo}`]);

    expect(test.api.workloads.has(`${groupName}-${generationOne}`)).toBe(true);
    expect(test.api.workloads.has(`${groupName}-${generationTwo}`)).toBe(false);
    expect(test.api.workloads.has(unknownName)).toBe(true);
    await expect(test.driver.cleanupOwnedInstallation()).resolves.toMatchObject({
      groupDeleted: false
    });
    expect(test.api.groups.has(groupName)).toBe(true);
    expect(test.api.workloads.has(unknownName)).toBe(true);
  });
});
