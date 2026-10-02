// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Service = { environment?: Record<string, string>; extra_hosts?: string[]; ports?: string[] };

const load = (file: string) =>
  (parse(readFileSync(path.resolve(file), "utf8")) as { services: Record<string, Service> }).services;

describe("personal MCP host gateway topology", () => {
  it.each(["compose.yaml", "docker-compose.dev.yml"])(
    "%s maps the host gateway into the app alone and tells it the published app port",
    (file) => {
      const services = load(file);
      expect(services.app?.extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
      expect(services.app?.environment?.AIQSA_PORT).toBe("${AIQSA_PORT:-3000}");
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
});
