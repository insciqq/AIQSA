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
const envExample = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
const productionCompose = readFileSync(
  resolve(process.cwd(), "docker-compose.yml"),
  "utf8"
);
const developmentCompose = readFileSync(
  resolve(process.cwd(), "docker-compose.dev.yml"),
  "utf8"
);

function locationBlock(marker: string): string {
  const start = template.indexOf(marker);
  if (start < 0) throw new Error(`Missing Nginx location: ${marker}`);
  const openingBrace = template.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < template.length; index += 1) {
    if (template[index] === "{") depth += 1;
    if (template[index] === "}") depth -= 1;
    if (depth === 0) return template.slice(start, index + 1);
  }
  throw new Error(`Unclosed Nginx location: ${marker}`);
}

describe("bundled Nginx proxy contract", () => {
  it("overwrites the client chain and removes the unused fallback header", () => {
    expect(template.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g)).toHaveLength(3);
    expect(template.match(/proxy_set_header X-Real-IP "";/g)).toHaveLength(3);
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
    expect(template.match(/proxy_buffering off;/g)).toHaveLength(3);
    expect(template.match(/proxy_read_timeout 720s;/g)).toHaveLength(3);
  });

  it("gives only the two Knowledge multipart POST shapes an 80 MiB envelope", () => {
    const internalMarker =
      "location ~ ^/__aiqsa_internal_knowledge_upload(/api/me/knowledge-bases/[^/]+/documents(?:/[^/]+/versions)?)$ {";
    const knowledgeUpload = locationBlock(internalMarker);
    const ordinaryProxy = locationBlock("location / {");
    const attachmentUpload = locationBlock("location = /api/uploads {");
    const routePattern = /^\/api\/me\/knowledge-bases\/[^/]+\/documents(?:\/[^/]+\/versions)?$/u;
    const firstLocation = template.indexOf("    location = /api/uploads {");
    const serverRewritePhase = template.slice(template.indexOf("server {"), firstLocation);

    expect(routePattern.test("/api/me/knowledge-bases/base-1/documents")).toBe(true);
    expect(routePattern.test(
      "/api/me/knowledge-bases/base-1/documents/document-1/versions"
    )).toBe(true);
    expect(routePattern.test("/api/me/knowledge-bases/base-1/documents/document-1")).toBe(false);
    expect(routePattern.test(
      "/api/me/knowledge-bases/base-1/documents/document-1/versions/version-1/retry"
    )).toBe(false);
    expect(routePattern.test("/api/me/knowledge-bases/base-1/publications")).toBe(false);

    expect(serverRewritePhase).toContain(
      "if ($request_method = POST) {\n" +
      "        rewrite ^(/api/me/knowledge-bases/[^/]+/documents(?:/[^/]+/versions)?)$ " +
      "/__aiqsa_internal_knowledge_upload$1 last;\n" +
      "    }"
    );
    expect(template).toContain(internalMarker);
    expect(template).not.toContain("@aiqsa_ordinary_knowledge_route");
    expect(template).not.toContain("if ($request_method != POST)");

    expect(knowledgeUpload).toContain("internal;");
    expect(knowledgeUpload).toContain("client_max_body_size 80m;");
    expect(knowledgeUpload).toContain("proxy_request_buffering off;");
    expect(knowledgeUpload).toContain(
      "rewrite ^/__aiqsa_internal_knowledge_upload(/.*)$ $1 break;"
    );
    expect(knowledgeUpload).toContain(
      "proxy_pass http://127.0.0.1:__AIQSA_LOOPBACK_PORT__;"
    );
    expect(knowledgeUpload).not.toContain("$request_uri");
    expect(template.match(/client_max_body_size 80m;/g)).toHaveLength(1);
    expect(template.match(/client_max_body_size 2m;/g)).toHaveLength(1);

    for (const directive of [
      "limit_conn aiqsa_upload_per_client 4;",
      "limit_conn_status 429;",
      "error_page 413 = @aiqsa_file_too_large;",
      "error_page 429 = @aiqsa_upload_busy;",
      "proxy_http_version 1.1;",
      "proxy_set_header X-Forwarded-For $remote_addr;",
      "proxy_set_header X-Real-IP \"\";",
      "proxy_buffering off;",
      "proxy_cache off;",
      "proxy_read_timeout 720s;",
      "proxy_send_timeout 720s;"
    ]) {
      expect(attachmentUpload).toContain(directive);
      expect(knowledgeUpload).toContain(directive);
    }

    expect(ordinaryProxy).not.toContain("client_max_body_size 80m;");
    expect(ordinaryProxy).not.toContain("proxy_request_buffering off;");
  });

  it("keeps the Knowledge and Chat defaults distinct across shipped configuration", () => {
    expect(envExample).toMatch(/^AIQSA_KNOWLEDGE_MAX_FILE_BYTES=50000000$/mu);
    expect(envExample).toMatch(/^AIQSA_UPLOAD_MAX_BYTES=25000000$/mu);

    for (const compose of [productionCompose, developmentCompose]) {
      expect(compose).toContain(
        "AIQSA_KNOWLEDGE_MAX_FILE_BYTES: ${AIQSA_KNOWLEDGE_MAX_FILE_BYTES:-50000000}"
      );
      expect(compose).toContain(
        "AIQSA_UPLOAD_MAX_BYTES: ${AIQSA_UPLOAD_MAX_BYTES:-25000000}"
      );
      expect(compose.match(/^\s+AIQSA_KNOWLEDGE_MAX_FILE_BYTES:/gmu)).toHaveLength(1);
    }
  });
});
