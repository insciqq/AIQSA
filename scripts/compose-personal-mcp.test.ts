// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = {
  environment?: Record<string, string>;
  extra_hosts?: string[];
  networks?: string[] | Record<string, unknown>;
  ports?: string[];
  profiles?: string[];
  volumes?: Array<string | { source?: string; type?: string }>;
};

const load = (file: string) =>
  (parse(readFileSync(path.resolve(file), "utf8")) as { services: Record<string, Service> }).services;

describe("personal MCP host gateway topology", () => {
  it.each(["compose.yaml", "docker-compose.dev.yml"])(
    "%s maps the host gateway into the app alone, pins container rules and tells it the published app port",
    (file) => {
      const services = load(file);
      expect(services.app?.extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
      expect(services.app?.environment?.AIQSA_PORT).toBe("${AIQSA_PORT:-3000}");
      // Never left to runtime detection: an unrecognised runtime must not get host rules.
      expect(services.app?.environment?.AIQSA_PERSONAL_MCP_NETWORK_MODE).toBe("container");
      for (const [name, service] of Object.entries(services)) {
        if (name !== "app") expect(service.extra_hosts, name).toBeUndefined();
      }
    }
  );

  it("tells the development app every data-service port it publishes on the host", () => {
    const services = load("docker-compose.dev.yml");
    const environment = services.app?.environment ?? {};
    for (const [service, variable] of [
      ["minio", "AIQSA_DEV_MINIO_PORT"],
      ["opensearch", "AIQSA_DEV_OPENSEARCH_PORT"],
      ["postgres", "AIQSA_DEV_POSTGRES_PORT"]
    ] as const) {
      const published = services[service]?.ports?.find((port) => port.includes(variable));
      const fallback = published?.match(new RegExp(`\\$\\{${variable}:-(\\d+)\\}`, "u"))?.[1];
      expect(fallback, service).toBeDefined();
      expect(environment[variable]).toBe(`\${${variable}:-${fallback}}`);
    }
  });

  it("production stack runs no Docker-socket controller and mounts no host path", () => {
    const services = load("compose.yaml");
    for (const [name, service] of Object.entries(services)) {
      for (const volume of service.volumes ?? []) {
        const source = typeof volume === "string" ? volume.split(":")[0] : volume.type === "bind" ? volume.source : undefined;
        expect(source ?? "", `${name} volume`).not.toMatch(/^[./~]/u);
      }
      const networks = Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {});
      expect(networks, name).not.toContain("mcp-control");
      expect(service.profiles ?? [], name).not.toContain("maintenance");
    }
    // The bootstrap gate reads the operator's acknowledgement only through this passthrough.
    expect(services["migrate-bootstrap"]?.environment?.AIQSA_ACCEPT_LOCAL_MCP_REMOVAL)
      .toBe("${AIQSA_ACCEPT_LOCAL_MCP_REMOVAL:-}");
  });
});
