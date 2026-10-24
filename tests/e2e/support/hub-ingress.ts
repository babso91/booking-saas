import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Client Hub as it is deployed: the production build behind a TLS
// ingress that terminates HTTPS and is the only one to set the trusted
// client headers (x-booking-proxy-secret, x-booking-client-ip; the role
// Caddy has in production), with codes delivered to Mailpit. Served on
// https://app.hub.test:3443, a registrable name (unlike localhost) so that a
// sibling subdomain (https://evil.hub.test:3443, same ingress) can really
// plant `Domain=hub.test` cookies in Chromium: cookie tossing, for real. The
// browser maps *.hub.test to 127.0.0.1 (tests/e2e/support/browser.ts) and
// trusts the throwaway certificate created here.

export const HUB_HOST = "app.hub.test";
export const EVIL_HOST = "evil.hub.test";
export const INGRESS_PORT = 3443;
export const HUB_URL = `https://${HUB_HOST}:${INGRESS_PORT}`;
export const EVIL_URL = `https://${EVIL_HOST}:${INGRESS_PORT}`;
/** The hub server itself, behind the ingress (loopback only). */
export const HUB_ORIGIN_PORT = 3001;

async function waitFor(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not become ready`);
}

/** A random client address per request, as many customers' networks. */
const randomClientIp = () =>
  `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

/**
 * The hub server (production build, codes to Mailpit), on loopback only;
 * the ingress in front of it is started by the browser tests themselves
 * (startIngress), so that they can hold its answers.
 */
export async function startHubServer(options: {
  root: string;
  env: NodeJS.ProcessEnv;
  mailpitUrl: string;
}) {
  const secret = randomBytes(24).toString("hex");
  const server: ChildProcess = spawn(
    "npx",
    ["next", "start", "--port", String(HUB_ORIGIN_PORT)],
    {
      cwd: options.root,
      detached: true,
      stdio: "ignore",
      env: {
        ...options.env,
        NEXT_PUBLIC_APP_URL: HUB_URL,
        BOOKING_PROXY_SECRET: secret,
        EMAIL_TRANSPORT: "mailpit",
        EMAIL_FROM: "Booking <noreply@test.local>",
        MAILPIT_URL: options.mailpitUrl,
      },
    },
  );
  await waitFor(`http://127.0.0.1:${HUB_ORIGIN_PORT}/api/health`, 60_000);
  return {
    secret,
    stop: () => {
      if (server.pid) process.kill(-server.pid, "SIGTERM");
    },
  };
}

type Hold = {
  method: string;
  path: string;
  taken: boolean;
  processed: () => void;
  decided: Promise<"deliver" | "lose">;
};

/**
 * The TLS ingress (what Caddy is in production) in front of the hub
 * server. It can hold the answer to a request: the server has processed it
 * (its answer is complete, its database work committed), and the browser
 * receives it only when the test says, or never (the connection is cut).
 */
export async function startIngress(secret: string) {
  const dir = mkdtempSync(join(tmpdir(), "hub-ingress-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=hub.test",
      "-addext",
      "subjectAltName=DNS:hub.test,DNS:*.hub.test",
    ],
    { stdio: "ignore" },
  );
  const holds: Hold[] = [];

  const ingress = https.createServer(
    {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    },
    (incoming, outgoing) => {
      const path = new URL(incoming.url ?? "/", HUB_URL).pathname;
      const hold = holds.find(
        (item) =>
          !item.taken && item.method === incoming.method && item.path === path,
      );
      if (hold) hold.taken = true;
      // What the browser says about itself is never trusted.
      const headers = { ...incoming.headers };
      delete headers["x-booking-proxy-secret"];
      delete headers["x-booking-client-ip"];
      headers["x-booking-proxy-secret"] = secret;
      headers["x-booking-client-ip"] = randomClientIp();
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: HUB_ORIGIN_PORT,
          path: incoming.url,
          method: incoming.method,
          headers,
        },
        (answer) => {
          if (!hold) {
            outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(outgoing);
            return;
          }
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", async () => {
            hold.processed();
            if ((await hold.decided) === "lose") {
              incoming.socket.destroy();
              return;
            }
            if (outgoing.destroyed || incoming.socket.destroyed) return;
            outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
            outgoing.end(Buffer.concat(chunks));
          });
        },
      );
      upstream.on("error", () => {
        outgoing.statusCode = 502;
        outgoing.end();
      });
      incoming.pipe(upstream);
    },
  );
  await new Promise<void>((resolve) =>
    ingress.listen(INGRESS_PORT, "127.0.0.1", resolve),
  );

  return {
    /**
     * Holds the answer to the next `method path` request: `processed`
     * resolves once the server has answered it; `release()` delivers it
     * to the browser, `lose()` cuts the connection instead.
     */
    holdNext(method: string, path: string) {
      let processed!: () => void;
      const done = new Promise<void>((resolve) => (processed = resolve));
      let decide!: (how: "deliver" | "lose") => void;
      const decided = new Promise<"deliver" | "lose">(
        (resolve) => (decide = resolve),
      );
      holds.push({ method, path, taken: false, processed, decided });
      return {
        processed: done,
        release: () => decide("deliver"),
        lose: () => decide("lose"),
      };
    },
    stop: async () => {
      ingress.closeAllConnections();
      await new Promise((resolve) => ingress.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
