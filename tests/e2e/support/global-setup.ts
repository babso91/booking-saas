import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import {
  assertLocal,
  resolveEnv,
  type SupabaseTestEnv,
} from "../../integration/support/global-setup";
import {
  HUB_ORIGIN_PORT,
  HUB_URL,
  INGRESS_PORT,
  startHubServer,
} from "./hub-ingress";

// End-to-end tests run against the production build served by `next start`
// on the canonical local origin, http://localhost:3000, and the local
// Supabase stack (with email confirmation and Mailpit). The Client Hub
// browser tests also get the same build as deployed, behind a TLS ingress
// with codes delivered to Mailpit (support/hub-ingress.ts).

export const APP_URL = "http://localhost:3000";
const MAILPIT_URL = "http://127.0.0.1:54324";

declare module "vitest" {
  export interface ProvidedContext {
    e2e: SupabaseTestEnv & {
      appUrl: string;
      mailpitUrl: string;
      /** The Client Hub behind its TLS ingress. */
      hubUrl: string;
      /** The hub server itself, without the ingress (loopback). */
      hubOriginUrl: string;
      /** What the ingress proves itself with to the hub server. */
      hubProxySecret: string;
    };
  }
}

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function waitFor(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`${url} did not become ready`);
}

let server: ChildProcess | undefined;
let hub: Awaited<ReturnType<typeof startHubServer>> | undefined;

export default async function setup(project: TestProject) {
  const env = resolveEnv();
  assertLocal(env.apiUrl);

  if (!existsSync(`${ROOT}/.next/BUILD_ID`)) {
    throw new Error("No production build found. Run `npm run build` first.");
  }

  const alreadyUp = await fetch(`${APP_URL}/api/health`).then(
    () => true,
    () => false,
  );
  if (alreadyUp) {
    throw new Error(
      `${APP_URL} is already in use; stop the other server first.`,
    );
  }
  for (const port of [HUB_ORIGIN_PORT, INGRESS_PORT]) {
    const taken = await fetch(`http://127.0.0.1:${port}/`).then(
      () => true,
      () => false,
    );
    if (taken) throw new Error(`Port ${port} is already in use.`);
  }

  await waitFor(`${MAILPIT_URL}/api/v1/info`, 10_000).catch(() => {
    throw new Error(
      "Mailpit is not running: start Supabase without excluding it.",
    );
  });

  server = spawn("npx", ["next", "start", "--port", "3000"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NEXT_PUBLIC_APP_URL: APP_URL,
      NEXT_PUBLIC_SUPABASE_URL: env.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.anonKey,
      // The server-side key the production deployment has: without it the
      // routes that need it (Client Hub reads, public booking) fail with 500
      // instead of answering for real. No trusted ingress and no email
      // delivery: those stay at their production defaults (unconfigured).
      SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey,
    },
  });

  hub = await startHubServer({
    root: ROOT,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: env.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: env.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey,
    },
    mailpitUrl: MAILPIT_URL,
  });

  await waitFor(`${APP_URL}/api/health`, 60_000);

  project.provide("e2e", {
    ...env,
    appUrl: APP_URL,
    mailpitUrl: MAILPIT_URL,
    hubUrl: HUB_URL,
    hubOriginUrl: `http://127.0.0.1:${HUB_ORIGIN_PORT}`,
    hubProxySecret: hub.secret,
  });
  // For the shared database fixtures (tests/integration/support).
  project.provide("supabase", env);

  return async () => {
    if (server?.pid) {
      process.kill(-server.pid, "SIGTERM");
    }
    hub?.stop();
  };
}
