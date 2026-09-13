// @vitest-environment node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("development HTTP preload", () => {
  it("wraps multiple dev servers with fresh traces and leaves peer auth and upgrade handling unchanged", () => {
    const result = spawnSync(process.execPath, ["--require", path.resolve("scripts/dev-bootstrap.cjs"), "-e", `
      const http = require('node:http');
      const net = require('node:net');
      const { getContext } = require('./lib/server/observability/runtime.cjs');
      const { installDevBootstrap } = require('./scripts/dev-bootstrap.cjs');
      installDevBootstrap();
      const servers = [0, 1].map(() => http.createServer((req, res) => {
        res.end(JSON.stringify({ trace: getContext()?.trace_id, peer: req.headers['x-aiqsa-runtime-peer'], secretInstalled: !!globalThis[Symbol.for('aiqsa.runtime-peer-secret.v1')] }));
      }));
      let upgrade = false;
      servers[0].on('upgrade', (req, socket) => {
        upgrade = req.url === '/_next/webpack-hmr';
        socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
      });
      Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))))
        .then(async () => {
          const responses = await Promise.all(servers.map((server) => fetch('http://127.0.0.1:' + server.address().port + '/secret-canary?query=canary', { method: 'POST', headers: { 'x-aiqsa-trace-id': 'a'.repeat(32), 'x-aiqsa-runtime-peer': 'dev-peer-unchanged' } })));
          const traces = await Promise.all(responses.map(async (response) => ({ header: response.headers.get('x-aiqsa-trace-id'), body: await response.json() })));
          await new Promise((resolve, reject) => {
            const socket = net.connect(servers[0].address().port, '127.0.0.1', () => socket.write('GET /_next/webpack-hmr HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n'));
            socket.on('data', () => socket.end());
            socket.on('end', resolve);
            socket.on('error', reject);
          });
          process.stdout.write(JSON.stringify({ test_result: true, traces, upgrade }) + '\\n');
          await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
        }).catch(() => process.exit(1));
    `], { encoding: "utf8", timeout: 10_000, cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "" } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const evidence = records.find((record) => record.test_result);
    expect(evidence.upgrade).toBe(true);
    expect(new Set(evidence.traces.map((item: { header: string }) => item.header)).size).toBe(2);
    for (const item of evidence.traces) {
      expect(item.header).toMatch(/^[0-9a-f]{32}$/);
      expect(item.header).not.toBe("a".repeat(32));
      expect(item.body.trace).toBe(item.header);
      expect(item.body.peer).toBe("dev-peer-unchanged");
      expect(item.body.secretInstalled).toBe(false);
    }
    expect(records.filter((record) => record.event === "process.started")).toHaveLength(1);
    const logs = records.filter((record) => record.event === "http.request_completed");
    expect(logs).toHaveLength(2);
    for (const record of logs) {
      expect(record.route_source).toBe("unknown");
      expect(record).not.toHaveProperty("routePath");
    }
    expect(JSON.stringify(logs)).not.toContain("canary");
  });
});
