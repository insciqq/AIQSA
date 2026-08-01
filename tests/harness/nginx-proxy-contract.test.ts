// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(process.cwd(), "ops/nginx/aiqsa.conf.template"),
  "utf8"
);

describe("bundled Nginx client-identity boundary", () => {
  it("overwrites the client chain and removes the unused fallback header", () => {
    expect(template).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(template).toContain('proxy_set_header X-Real-IP "";');
    expect(template).not.toMatch(
      /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/
    );
  });
});
