import { describe, expect, it, vi } from "vitest";
import {
  TOOLHIVE_EXPECTED_VERSION,
  ToolHiveClient,
  ToolHiveClientError,
  type ToolHiveFetch,
  type ToolHiveWorkloadSummary
} from "./toolhiveClient";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function workload(overrides: Partial<ToolHiveWorkloadSummary> = {}): ToolHiveWorkloadSummary {
  return {
    group: "aiqsa-0123456789abcdef",
    name: "aiqsa-0123456789abcdef-0123456789abcdef01234567",
    port: 31_337,
    proxyMode: "streamable-http",
    remote: false,
    status: "running",
    transportType: "stdio",
    url: "http://127.0.0.1:31337/mcp",
    ...overrides
  };
}

describe("ToolHive REST client", () => {
  it("checks health/version and tolerates ToolHive null collections", async () => {
    const fetch = vi.fn<ToolHiveFetch>(async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/health") return new Response(null, { status: 204 });
      if (url.pathname === "/api/v1beta/version") {
        return json({ version: TOOLHIVE_EXPECTED_VERSION });
      }
      if (url.pathname === "/api/v1beta/groups") return json({ groups: null });
      if (url.pathname === "/api/v1beta/workloads") return json({ workloads: null });
      return new Response(null, { status: 404 });
    });
    const client = new ToolHiveClient({ baseUrl: "http://toolhive-runtime:8080", fetch });

    await expect(client.checkHealth()).resolves.toBeUndefined();
    await expect(client.assertCompatibleVersion()).resolves.toBeUndefined();
    await expect(client.listGroups()).resolves.toEqual([]);
    await expect(client.listWorkloads({ group: "aiqsa-0123456789abcdef" })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("treats a missing scoped group as an empty workload collection", async () => {
    const fetch = vi.fn<ToolHiveFetch>(async () =>
      new Response("group not found", { status: 404 }));
    const client = new ToolHiveClient({ baseUrl: "http://toolhive-runtime:8080", fetch });

    await expect(client.listWorkloads({
      group: "aiqsa-0123456789abcdef"
    })).resolves.toEqual([]);
    await expect(client.listWorkloads()).rejects.toMatchObject({
      code: "toolhive_http_error",
      status: 404
    });
  });

  it("creates only a fixed local stdio request with the exact supplied environment", async () => {
    let body: Record<string, unknown> | null = null;
    const fetch = vi.fn<ToolHiveFetch>(async (input, init) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/api/v1beta/workloads");
      expect(init?.method).toBe("POST");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ name: body.name, port: 31_337 }, 201);
    });
    const client = new ToolHiveClient({ baseUrl: "http://toolhive-runtime:8080", fetch });

    await expect(client.createLocalWorkload({
      cmdArguments: ["--stdio"],
      envVars: { MEM0_API_KEY: "personal-key", MEM0_DEFAULT_USER_ID: "user123" },
      group: "aiqsa-0123456789abcdef",
      image: "example.invalid/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "aiqsa-0123456789abcdef-0123456789abcdef01234567"
    })).resolves.toEqual({
      name: "aiqsa-0123456789abcdef-0123456789abcdef01234567",
      port: 31_337
    });

    expect(body).toEqual({
      cmd_arguments: ["--stdio"],
      env_vars: {
        MEM0_API_KEY: "personal-key",
        MEM0_DEFAULT_USER_ID: "user123"
      },
      group: "aiqsa-0123456789abcdef",
      host: "0.0.0.0",
      image: "example.invalid/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "aiqsa-0123456789abcdef-0123456789abcdef01234567",
      network_isolation: false,
      proxy_mode: "streamable-http",
      proxy_port: 0,
      transport: "stdio"
    });
    expect(body).not.toHaveProperty("labels");
    expect(body).not.toHaveProperty("secrets");
    expect(body).not.toHaveProperty("url");
    expect(body).not.toHaveProperty("volumes");
  });

  it("classifies a missing generated image without exposing ToolHive's response body", async () => {
    const secret = "environment-secret-must-not-escape";
    const client = new ToolHiveClient({
      baseUrl: "http://toolhive-runtime:8080",
      fetch: vi.fn<ToolHiveFetch>(async () => new Response(
        `pull access denied for toolhivelocal/example:resolved; env=${secret}`,
        { status: 500 }
      ))
    });

    let failure: unknown;
    try {
      await client.createLocalWorkload({
        cmdArguments: [],
        envVars: { API_KEY: secret },
        group: "aiqsa-0123456789abcdef",
        image: "toolhivelocal/example:resolved",
        name: "aiqsa-0123456789abcdef-0123456789abcdef01234567"
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "toolhive_artifact_missing",
      operation: "create_workload",
      status: 500
    });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(secret);
  });

  it("classifies a missing generated image while recovering an existing workload", async () => {
    const secret = "restart-secret-must-not-escape";
    const client = new ToolHiveClient({
      baseUrl: "http://toolhive-runtime:8080",
      fetch: vi.fn<ToolHiveFetch>(async () => new Response(
        `no such image: toolhivelocal/example:resolved; env=${secret}`,
        { status: 500 }
      ))
    });

    let failure: unknown;
    try {
      await client.restartWorkload(
        "aiqsa-0123456789abcdef-0123456789abcdef01234567",
        { expectedImage: "toolhivelocal/example:resolved" }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "toolhive_artifact_missing",
      operation: "restart_workload",
      status: 500
    });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(secret);
  });

  it("parses the narrow sensitive detail shape without adding data to errors", async () => {
    const secret = "secret-that-must-not-escape";
    let fail = false;
    const fetch = vi.fn<ToolHiveFetch>(async () => {
      if (fail) return new Response(`env_vars: MEM0_API_KEY=${secret}`, { status: 500 });
      return json({
        cmd_arguments: null,
        env_vars: { MEM0_API_KEY: secret },
        group: "aiqsa-0123456789abcdef",
        host: "0.0.0.0",
        image: "toolhivelocal/mem0:resolved",
        name: "aiqsa-0123456789abcdef-0123456789abcdef01234567",
        network_isolation: false,
        proxy_mode: "streamable-http",
        proxy_port: 31_337,
        transport: "stdio"
      });
    });
    const client = new ToolHiveClient({ baseUrl: "http://toolhive-runtime:8080", fetch });

    await expect(client.getWorkload(
      "aiqsa-0123456789abcdef-0123456789abcdef01234567"
    )).resolves.toMatchObject({
      cmdArguments: [],
      envVars: { MEM0_API_KEY: secret },
      networkIsolation: false
    });

    fail = true;
    let failure: unknown;
    try {
      await client.getWorkload("aiqsa-0123456789abcdef-0123456789abcdef01234567");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "toolhive_http_error",
      operation: "get_workload",
      status: 500
    });
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain(secret);
  });

  it("retrieves workload output only through the exact bounded logs endpoint", async () => {
    const name = "aiqsa-0123456789abcdef-0123456789abcdef01234567";
    const output = "canvas-mcp: missing CANVAS_BASE_URL.\n";
    const fetch = vi.fn<ToolHiveFetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(requestUrl(input).pathname).toBe(`/api/v1beta/workloads/${name}/logs`);
      return new Response(output, { headers: { "content-type": "text/plain" } });
    });
    const client = new ToolHiveClient({ baseUrl: "http://toolhive-runtime:8080", fetch });

    await expect(client.getWorkloadLogs(name)).resolves.toBe(output);
  });

  it("caps workload output below the general ToolHive response limit", async () => {
    const client = new ToolHiveClient({
      baseUrl: "http://toolhive-runtime:8080",
      fetch: vi.fn<ToolHiveFetch>(async () => new Response("x".repeat(16 * 1_024 + 1)))
    });

    await expect(client.getWorkloadLogs(
      "aiqsa-0123456789abcdef-0123456789abcdef01234567"
    )).rejects.toMatchObject({
      code: "toolhive_response_too_large",
      operation: "get_workload_logs"
    });
  });

  it("bounds successful responses and exposes only a stable failure", async () => {
    const fetch = vi.fn<ToolHiveFetch>(async () => json({ version: "x".repeat(128) }));
    const client = new ToolHiveClient({
      baseUrl: "http://toolhive-runtime:8080",
      fetch,
      maxResponseBytes: 16
    });

    await expect(client.getVersion()).rejects.toMatchObject({
      code: "toolhive_response_too_large",
      operation: "version",
      status: null
    });
  });

  it("normalizes only the expected loopback stdio proxy URL", () => {
    const client = new ToolHiveClient({
      baseUrl: "http://toolhive-runtime:8080",
      fetch: vi.fn<ToolHiveFetch>()
    });

    expect(client.normalizeStdioProxyUrl(workload())).toBe(
      "http://toolhive-runtime:31337/mcp"
    );
    expect(() => client.normalizeStdioProxyUrl(workload({
      url: "http://attacker.invalid:31337/mcp"
    }))).toThrowError(ToolHiveClientError);
    expect(() => client.normalizeStdioProxyUrl(workload({
      remote: true
    }))).toThrowError("toolhive_response_invalid");
    expect(() => client.normalizeStdioProxyUrl(workload({
      url: "http://127.0.0.1:31337/other"
    }))).toThrowError("toolhive_response_invalid");
  });

  it("uses the exact lifecycle endpoints and treats delete 404 as success", async () => {
    const calls: string[] = [];
    const fetch = vi.fn<ToolHiveFetch>(async (input, init) => {
      const url = requestUrl(input);
      calls.push(`${init?.method}:${url.pathname}`);
      if (url.pathname.endsWith("/status")) return json({ status: "unhealthy" });
      if (init?.method === "DELETE") return new Response("not found", { status: 404 });
      return new Response(null, { status: 202 });
    });
    const client = new ToolHiveClient({ baseUrl: "http://toolhive-runtime:8080", fetch });
    const name = "aiqsa-0123456789abcdef-0123456789abcdef01234567";

    await expect(client.getWorkloadStatus(name)).resolves.toBe("unhealthy");
    await expect(client.restartWorkload(name)).resolves.toBeUndefined();
    await expect(client.stopWorkload(name)).resolves.toBeUndefined();
    await expect(client.deleteWorkload(name)).resolves.toBeUndefined();
    expect(calls).toEqual([
      `GET:/api/v1beta/workloads/${name}/status`,
      `POST:/api/v1beta/workloads/${name}/restart`,
      `POST:/api/v1beta/workloads/${name}/stop`,
      `DELETE:/api/v1beta/workloads/${name}`
    ]);
  });
});
