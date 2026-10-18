// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Logging = { driver?: string; options?: Record<string, string> };
type ComposeFile = { services: Record<string, { logging?: Logging }> };

const load = (file: string) => parse(readFileSync(path.resolve(file), "utf8")) as ComposeFile;
const production = load("compose.yaml");
const fallback = load("compose.json-file-logging.yaml");

describe("production container logging", () => {
  it("logs every service to the host journal with the Compose project and service as fields", () => {
    for (const [name, service] of Object.entries(production.services)) {
      expect(service.logging, name).toEqual({
        driver: "journald",
        options: {
          tag: "{{.Name}}",
          labels: "com.docker.compose.project,com.docker.compose.service",
          mode: "non-blocking",
          "max-buffer-size": "4m"
        }
      });
    }
  });

  it("gives the json-file fallback every service and nothing else, with operator-overridable rotation", () => {
    expect(Object.keys(fallback.services).sort()).toEqual(Object.keys(production.services).sort());
    for (const [name, service] of Object.entries(fallback.services)) {
      expect(service, name).toEqual({
        logging: { driver: "json-file", options: { "max-file": "${AIQSA_LOG_MAX_FILES:-5}", "max-size": "${AIQSA_LOG_MAX_SIZE:-10m}" } }
      });
    }
  });

  it("documents the fallback selector that aiqsa.sh configure uncomments", () => {
    expect(readFileSync(path.resolve(".env.example"), "utf8"))
      .toContain("\n# COMPOSE_FILE=compose.yaml:compose.json-file-logging.yaml\n");
    expect(readFileSync(path.resolve("aiqsa.sh"), "utf8"))
      .toContain("readonly JSON_FILE_LOGGING=compose.json-file-logging.yaml\n");
  });
});
