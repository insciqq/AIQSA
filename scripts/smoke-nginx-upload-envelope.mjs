import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const nginxImage =
  "nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752";
const nodeImage =
  "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94";
const upstreamPort = 18080;
const mib = 1024 * 1024;
const ordinaryLimitError = '{"error":"request_body_too_large"}';
const uploadLimitError = '{"error":"file_too_large"}';

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("smoke_listener_address_unavailable"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(() => resolveClose());
  });
}

async function reservePort() {
  const reservation = createNetServer();
  const port = await listen(reservation, 0);
  await closeServer(reservation);
  return port;
}

function sendRequest(port, { body = Buffer.alloc(0), declaredLength, method, path, chunked }) {
  return new Promise((resolveRequest, reject) => {
    const headers = {};
    if (chunked) {
      headers["Transfer-Encoding"] = "chunked";
    } else {
      headers["Content-Length"] = String(declaredLength ?? body.length);
    }

    let settled = false;
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          settled = true;
          resolveRequest({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0
          });
        });
      }
    );

    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.setTimeout(15_000, () => {
      request.destroy(new Error("nginx_envelope_smoke_request_timeout"));
    });
    request.end(body);
  });
}

async function readUpstreamRecords(port, method = "GET") {
  const response = await sendRequest(port, {
    method,
    path: "/__smoke_records"
  });
  assert.equal(response.status, 200, `${method} upstream record control status`);
  return JSON.parse(response.body);
}

async function waitForProxy(port, exited) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (exited.value) {
      throw new Error(`nginx_exited_before_ready:${exited.value.code}`);
    }
    try {
      const response = await sendRequest(port, {
        method: "GET",
        path: "/__aiqsa_nginx_smoke_ready"
      });
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw lastError ?? new Error("nginx_ready_timeout");
}

async function main() {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const template = await readFile(
    join(repositoryRoot, "ops/nginx/aiqsa.conf.template"),
    "utf8"
  );
  const limits = await readFile(
    join(repositoryRoot, "ops/nginx/aiqsa-http-limits.conf"),
    "utf8"
  );
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "aiqsa-nginx-envelope-"));
  const configPath = join(temporaryDirectory, "nginx.conf");
  const fixturePath = join(temporaryDirectory, "upstream.mjs");
  const resourcePrefix =
    `aiqsa-nginx-envelope-${process.pid}-${randomBytes(4).toString("hex")}`;
  const containerName = `${resourcePrefix}-proxy`;
  const upstreamName = `${resourcePrefix}-upstream`;
  const networkName = `${resourcePrefix}-network`;
  const exited = { value: undefined };
  let nginxOutput = "";
  let nginxProcess;
  let networkCreated = false;
  let upstreamStarted = false;

  try {
    const proxyPort = await reservePort();
    let upstreamControlPort = await reservePort();
    while (upstreamControlPort === proxyPort) {
      upstreamControlPort = await reservePort();
    }
    const renderedSite = template
      .replace("listen 80;", `listen ${proxyPort};`)
      .replace("listen [::]:80;", "")
      .replaceAll("__AIQSA_DOMAIN__", "aiqsa-nginx-envelope.invalid")
      .replaceAll("__AIQSA_LOOPBACK_PORT__", String(upstreamPort))
      .replaceAll(
        `127.0.0.1:${upstreamPort}`,
        `${upstreamName}:${upstreamPort}`
      );
    const config = [
      "worker_processes 1;",
      "pid /tmp/nginx.pid;",
      "error_log stderr notice;",
      "events { worker_connections 128; }",
      "http {",
      limits,
      renderedSite,
      "}"
    ].join("\n");
    await writeFile(configPath, config, { mode: 0o600 });
    await writeFile(
      fixturePath,
      [
        'import { createHash } from "node:crypto";',
        'import { createServer } from "node:http";',
        "const records = [];",
        "createServer((request, response) => {",
        '  if (request.url === "/__smoke_records") {',
        "    const snapshot = [...records];",
        '    if (request.method === "DELETE") records.length = 0;',
        '    response.writeHead(200, { "Content-Type": "application/json" });',
        "    response.end(JSON.stringify(snapshot));",
        "    return;",
        "  }",
        "  const chunks = [];",
        '  request.on("data", (chunk) => chunks.push(chunk));',
        '  request.on("end", () => {',
        "    const body = Buffer.concat(chunks);",
        "    const record = {",
        "      bytes: body.length,",
        '      digest: createHash("sha256").update(body).digest("hex"),',
        "      method: request.method,",
        "      url: request.url",
        "    };",
        "    records.push(record);",
        '    response.writeHead(200, { "Content-Type": "application/json" });',
        "    response.end(JSON.stringify(record));",
        "  });",
        `}).listen(${upstreamPort}, "0.0.0.0");`
      ].join("\n"),
      { mode: 0o600 }
    );

    await execFileAsync("docker", ["network", "create", networkName]);
    networkCreated = true;
    await execFileAsync("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      upstreamName,
      "--network",
      networkName,
      "--publish",
      `127.0.0.1:${upstreamControlPort}:${upstreamPort}`,
      "--mount",
      `type=bind,src=${fixturePath},dst=/smoke/upstream.mjs,readonly`,
      nodeImage,
      "node",
      "/smoke/upstream.mjs"
    ]);
    upstreamStarted = true;

    nginxProcess = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containerName,
        "--network",
        networkName,
        "--publish",
        `127.0.0.1:${proxyPort}:${proxyPort}`,
        "--mount",
        `type=bind,src=${configPath},dst=/etc/nginx/nginx.conf,readonly`,
        nginxImage,
        "nginx",
        "-g",
        "daemon off;"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const retainOutput = (chunk) => {
      nginxOutput = `${nginxOutput}${chunk.toString("utf8")}`.slice(-32768);
    };
    nginxProcess.stdout.on("data", retainOutput);
    nginxProcess.stderr.on("data", retainOutput);
    nginxProcess.once("error", (error) => {
      nginxOutput = `${nginxOutput}${error.message}`.slice(-32768);
      exited.value = { code: "spawn_error", signal: undefined };
    });
    nginxProcess.once("exit", (code, signal) => {
      exited.value = { code, signal };
    });

    await waitForProxy(proxyPort, exited);
    await readUpstreamRecords(upstreamControlPort, "DELETE");

    const threeMib = Buffer.alloc(3 * mib, 0x6b);
    const expectedDigest = digest(threeMib);
    const successfulUploads = [
      {
        chunked: false,
        method: "POST",
        path: "/api/me/knowledge-sources/source-1/versions?transfer=declared"
      },
      {
        chunked: true,
        method: "POST",
        path: "/api/me/knowledge-sources/source-1/versions?transfer=chunked"
      },
      {
        chunked: false,
        method: "PUT",
        path: "/api/me/knowledge-bases/base-1/upload-batches/batch-1/items/item-1/content?transfer=declared"
      },
      {
        chunked: true,
        method: "PUT",
        path: "/api/me/knowledge-bases/base-1/upload-batches/batch-1/items/item-1/content?transfer=chunked"
      }
    ];

    for (const upload of successfulUploads) {
      const response = await sendRequest(proxyPort, {
        body: threeMib,
        chunked: upload.chunked,
        method: upload.method,
        path: upload.path
      });
      assert.equal(response.status, 200, `${upload.method} ${upload.path} status`);
      const upstreamRecord = JSON.parse(response.body);
      assert.deepEqual(
        upstreamRecord,
        {
          bytes: threeMib.length,
          digest: expectedDigest,
          method: upload.method,
          url: upload.path
        },
        `${upload.method} ${upload.path} upstream request`
      );
    }

    const expectRejected = async (label, request, expectedBody) => {
      const previousCount = (await readUpstreamRecords(upstreamControlPort)).length;
      const response = await sendRequest(proxyPort, request);
      assert.equal(response.status, 413, `${label} status`);
      assert.equal(response.body, expectedBody, `${label} JSON envelope`);
      assert.equal(
        (await readUpstreamRecords(upstreamControlPort)).length,
        previousCount,
        `${label} must not reach upstream`
      );
    };

    const ordinaryRejections = [
      {
        label: "declared GET",
        request: {
          body: threeMib,
          method: "GET",
          path: "/api/me/knowledge-sources/source-1/versions?transfer=declared"
        }
      },
      {
        label: "chunked GET",
        request: {
          body: threeMib,
          chunked: true,
          method: "GET",
          path: "/api/me/knowledge-bases/base-1/upload-batches/batch-1/items/item-1/content?transfer=chunked"
        }
      },
      {
        label: "declared DELETE",
        request: {
          body: threeMib,
          method: "DELETE",
          path: "/api/me/knowledge-sources/source-1/versions?transfer=declared"
        }
      },
      {
        label: "chunked DELETE",
        request: {
          body: threeMib,
          chunked: true,
          method: "DELETE",
          path: "/api/me/knowledge-bases/base-1/upload-batches/batch-1/items/item-1/content?transfer=chunked"
        }
      },
      {
        label: "lookalike POST",
        request: {
          body: threeMib,
          method: "POST",
          path: "/api/me/knowledge-sources/source-1?lookalike=1"
        }
      }
    ];
    for (const rejection of ordinaryRejections) {
      await expectRejected(rejection.label, rejection.request, ordinaryLimitError);
    }

    await expectRejected(
      "declared POST above 80 MiB",
      {
        body: Buffer.from("x"),
        declaredLength: 80 * mib + 1,
        method: "POST",
        path: "/api/me/knowledge-sources/source-1/versions?oversized=1"
      },
      uploadLimitError
    );

    const directInternalCount = (await readUpstreamRecords(upstreamControlPort)).length;
    const directInternal = await sendRequest(proxyPort, {
      body: Buffer.from("direct"),
      method: "POST",
      path:
        "/__aiqsa_internal_knowledge_upload/api/me/knowledge-sources/source-1/versions?direct=1"
    });
    assert.equal(directInternal.status, 404, "direct internal namespace status");
    assert.equal(
      (await readUpstreamRecords(upstreamControlPort)).length,
      directInternalCount,
      "direct internal namespace must not reach upstream"
    );

    const smallRequests = [
      {
        body: Buffer.from("small-get"),
        chunked: false,
        method: "GET",
        path: "/api/me/knowledge-sources/source-1/versions?small=get"
      },
      {
        body: Buffer.from("small-delete"),
        chunked: true,
        method: "DELETE",
        path: "/api/me/knowledge-bases/base-1/upload-batches/batch-1/items/item-1/content?small=delete"
      }
    ];
    for (const smallRequest of smallRequests) {
      const response = await sendRequest(proxyPort, smallRequest);
      assert.equal(response.status, 200, `${smallRequest.method} small status`);
      assert.deepEqual(
        JSON.parse(response.body),
        {
          bytes: smallRequest.body.length,
          digest: digest(smallRequest.body),
          method: smallRequest.method,
          url: smallRequest.path
        },
        `${smallRequest.method} small upstream request`
      );
    }

    assert.equal(
      (await readUpstreamRecords(upstreamControlPort)).length,
      successfulUploads.length + smallRequests.length
    );
    process.stdout.write("Nginx Knowledge upload envelope smoke passed (13 cases).\n");
  } catch (error) {
    if (nginxOutput) {
      process.stderr.write(`Bounded Nginx output:\n${nginxOutput}\n`);
    }
    throw error;
  } finally {
    if (nginxProcess && !exited.value) {
      await execFileAsync("docker", ["rm", "--force", containerName]).catch(() => undefined);
    }
    if (upstreamStarted) {
      await execFileAsync("docker", ["rm", "--force", upstreamName]).catch(() => undefined);
    }
    if (networkCreated) {
      await execFileAsync("docker", ["network", "rm", networkName]).catch(() => undefined);
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
