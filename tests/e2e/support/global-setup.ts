import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import {
  assertLocal,
  resolveEnv,
  type SupabaseTestEnv,
} from "../../integration/support/global-setup";

// End-to-end tests run against the production build served by `next start`
// on the canonical local origin, http://localhost:3000, and the local
// Supabase stack (with email confirmation and Mailpit).

export const APP_URL = "http://localhost:3000";
const MAILPIT_URL = "http://127.0.0.1:54324";

declare module "vitest" {
  export interface ProvidedContext {
    e2e: SupabaseTestEnv & { appUrl: string; mailpitUrl: string };
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
    },
  });

  await waitFor(`${APP_URL}/api/health`, 60_000);

  project.provide("e2e", { ...env, appUrl: APP_URL, mailpitUrl: MAILPIT_URL });

  return () => {
    if (server?.pid) {
      process.kill(-server.pid, "SIGTERM");
    }
  };
}
