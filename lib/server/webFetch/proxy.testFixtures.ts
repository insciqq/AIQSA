import { createServer, type Socket } from "node:net";
import type { ProxyProtocol } from "../../contracts/proxies";
import type { RunProxyConnection } from "../proxies/runProxies";

export const proxyConnection = (port: number, protocol: ProxyProtocol = "http", id = "proxy-one"): RunProxyConnection => ({
  active: true, country: null, domainHints: ["example.com"], host: "proxy.example.net", id,
  login: "synthetic-user", name: id, owner: "personal", password: "synthetic-password-:/@?", port, protocol
});

export const pageResponse = (body = "Synthetic page content", status = 200, headers = "") =>
  `HTTP/1.1 ${status} Result\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${headers}\r\n${body}`;

/** Loopback only. Emulates the origin behind a tunnel or an absolute-form request; never contacts external targets. */
export async function localProxy(options: {
  protocol?: "http" | "socks5";
  behavior?: "close" | "garbage" | "silent" | "bad_password";
  response?: (request: string) => string | Buffer;
} = {}) {
  const sockets = new Set<Socket>();
  const connects: string[] = [];
  const proxyRequests: string[] = [];
  const requests: string[] = [];
  const logins: string[] = [];
  const passwords: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined).once("close", () => sockets.delete(socket));
    if (options.behavior === "close") { socket.destroy(); return; }
    if (options.behavior === "garbage") { socket.end("not a proxy\r\n\r\n"); return; }
    if (options.behavior === "silent") return;
    let pending = Buffer.alloc(0);
    let stage = options.protocol === "socks5" ? "hello" : "http";
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        if (stage === "hello") {
          if (pending.length < 2 || pending.length < 2 + pending[1]!) return;
          const method = pending[2]!;
          pending = pending.subarray(2 + pending[1]!);
          socket.write(Buffer.from([5, method]));
          stage = method === 2 ? "auth" : "socks";
        } else if (stage === "auth") {
          if (pending.length < 2 || pending.length < 3 + pending[1]!) return;
          const length = 3 + pending[1]! + pending[2 + pending[1]!]!;
          if (pending.length < length) return;
          logins.push(pending.subarray(2, 2 + pending[1]!).toString());
          passwords.push(pending.subarray(3 + pending[1]!, length).toString());
          pending = pending.subarray(length);
          if (options.behavior === "bad_password") { socket.end(Buffer.from([1, 1])); return; }
          socket.write(Buffer.from([1, 0]));
          stage = "socks";
        } else if (stage === "socks") {
          if (pending.length < 5 || pending.length < 7 + pending[4]!) return;
          const length = 7 + pending[4]!;
          connects.push(`${pending.subarray(5, 5 + pending[4]!).toString()}:${pending.readUInt16BE(length - 2)}`);
          pending = pending.subarray(length);
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          stage = "page";
        } else {
          const end = pending.indexOf("\r\n\r\n");
          if (end < 0) return;
          let request = pending.subarray(0, end + 4).toString();
          pending = pending.subarray(end + 4);
          if (stage === "http" && !request.startsWith("CONNECT ")) {
            proxyRequests.push(request);
            if (options.behavior === "bad_password") { socket.end(pageResponse("", 407)); return; }
            const target = new URL(request.split(" ")[1]!);
            request = request.replace(/^GET [^ ]+ /u, `GET ${target.pathname}${target.search} `)
              .replace(/^proxy-authorization:[^\r\n]*\r\n/gimu, "");
            stage = "page";
          }
          if (stage === "http") {
            connects.push(request);
            if (options.behavior === "bad_password") { socket.end(pageResponse("", 407)); return; }
            socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
            stage = "page";
          } else {
            requests.push(request);
            socket.end(options.response?.(request) ?? pageResponse());
            return;
          }
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic_proxy_address");
  return { connects, proxyRequests, logins, passwords, port: address.port, requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } };
}
