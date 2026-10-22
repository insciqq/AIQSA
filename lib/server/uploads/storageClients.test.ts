// @vitest-environment node
import { once } from "node:events";
import { Agent, createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createS3StorageAdapter, S3_FREE_SOCKET_IDLE_MS, s3HttpAgentOptions } from "./storage";

type Peer = Readonly<{ server: Server; sockets: Socket[]; closed: Promise<void>[]; origin: string }>;

const peers: Server[] = [];
afterEach(async () => {
  await Promise.all(peers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Peer> {
  const server = createServer(handler);
  // The server never closes an idle connection itself: a close proves the client did.
  server.keepAliveTimeout = 60_000;
  peers.push(server);
  const sockets: Socket[] = [];
  const closed: Promise<void>[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
  });
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port_unavailable");
  return { server, sockets, closed, origin: `http://127.0.0.1:${address.port}` };
}

function get(agent: Agent, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    request(url, { agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => body += chunk);
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject).end();
  });
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed_out")), ms))]);
}

describe("S3 client keep-alive sockets", () => {
  it("closes an idle free socket after its idle period without cutting slow requests", async () => {
    const server = await peer((req, res) => {
      if (req.url === "/late") {
        setTimeout(() => res.end("late"), 1_200);
        return;
      }
      if (req.url === "/stalled") {
        res.writeHead(200, { "content-length": "7" });
        res.write("sta");
        setTimeout(() => res.end("lled"), 1_200);
        return;
      }
      res.end("fast");
    });
    // The SDK handler builds its agent the same way from these options.
    const agent = new Agent({ keepAlive: true, maxSockets: 50, ...s3HttpAgentOptions(500) });

    await expect(get(agent, `${server.origin}/late`)).resolves.toBe("late");
    await expect(get(agent, `${server.origin}/stalled`)).resolves.toBe("stalled");
    await expect(get(agent, `${server.origin}/fast`)).resolves.toBe("fast");
    expect(server.sockets).toHaveLength(1);

    const idleSince = Date.now();
    await within(server.closed[0]!, 2_000);
    expect(Date.now() - idleSince).toBeGreaterThanOrEqual(400);
    await within(new Promise<void>((resolve) => {
      const poll = () => Object.keys(agent.freeSockets).length === 0 ? resolve() : setTimeout(poll, 10);
      poll();
    }), 1_000);
    agent.destroy();
  });
});

describe("S3 client reuse", () => {
  it("shares one client per configuration and lets its idle sockets close", async () => {
    const server = await peer((_req, res) => {
      res.writeHead(200, { "content-length": "12", "content-type": "application/octet-stream" });
      res.end("object-bytes");
    });
    const env = {
      S3_ACCESS_KEY_ID: "reuse-access-key",
      S3_BUCKET: "reuse-bucket",
      S3_ENDPOINT: server.origin,
      S3_SECRET_ACCESS_KEY: "reuse-secret-key"
    };

    for (const storage of [createS3StorageAdapter(env), createS3StorageAdapter({ ...env })]) {
      const object = await storage.getObject("owned/object.bin");
      expect(object.body.toString()).toBe("object-bytes");
    }
    expect(server.sockets).toHaveLength(1);

    const rotated = await createS3StorageAdapter({ ...env, S3_SECRET_ACCESS_KEY: "rotated-secret-key" }).getObject("owned/object.bin");
    expect(rotated.body.toString()).toBe("object-bytes");
    expect(server.sockets).toHaveLength(2);

    await within(Promise.all(server.closed), S3_FREE_SOCKET_IDLE_MS + 2_000);
  }, 15_000);
});
