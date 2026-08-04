// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(process.cwd(), "ops/nginx/aiqsa.conf.template"),
  "utf8"
);
const limits = readFileSync(
  resolve(process.cwd(), "ops/nginx/aiqsa-http-limits.conf"),
  "utf8"
);

describe("bundled Nginx client-identity boundary", () => {
  it("overwrites the client chain and removes the unused fallback header", () => {
    expect(template.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)).toHaveLength(2);
    expect(template.match(/proxy_set_header X-Real-IP "";/g)).toHaveLength(2);
    expect(template).not.toMatch(
      /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/
    );
  });

  it("bounds ordinary and upload requests without changing SSE proxy behavior", () => {
    expect(limits).toContain("limit_conn_zone $binary_remote_addr zone=aiqsa_upload_per_client:10m;");
    expect(template).toContain("client_max_body_size 2m;");
    expect(template).toContain("location = /api/uploads {");
    expect(template).toContain("client_max_body_size 32m;");
    expect(template).toContain("limit_conn aiqsa_upload_per_client 4;");
    expect(template).toContain("limit_conn_status 429;");
    expect(template).toContain("error_page 413 = @aiqsa_request_body_too_large;");
    expect(template).toContain("error_page 413 = @aiqsa_file_too_large;");
    expect(template).toContain("error_page 429 = @aiqsa_upload_busy;");
    expect(template).toContain("return 413 '{\"error\":\"request_body_too_large\"}';");
    expect(template).toContain("return 413 '{\"error\":\"file_too_large\"}';");
    expect(template.match(/add_header X-Request-ID \$request_id always;/g)).toHaveLength(2);
    expect(template).toContain("add_header Retry-After 1 always;");
    expect(template).toContain("return 429 '{\"error\":\"upload_busy\"}';");
    expect(template.match(/proxy_buffering off;/g)).toHaveLength(2);
    expect(template.match(/proxy_read_timeout 720s;/g)).toHaveLength(2);
  });
});
