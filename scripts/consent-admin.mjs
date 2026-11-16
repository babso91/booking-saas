#!/usr/bin/env node
// The platform administrator's consent texts and collection switch
// (docs/MARKETING_CONSENT_OPERATIONS.md). Run on a trusted machine with the
// service key in the environment; it is never printed.
//
//   node scripts/consent-admin.mjs list
//   node scripts/consent-admin.mjs show <version>      (the full text and its hash: read it here)
//   node scripts/consent-admin.mjs register <version> <email|sms|information|notice> <file>
//   node scripts/consent-admin.mjs activate <version> --sha256 <hash> [--note "…"] --confirm
//   node scripts/consent-admin.mjs collection <on|off> [--note "…"] --confirm
//
// `activate` and `collection` change nothing without --confirm (they print
// what they would do). Activating checks that the text's SHA-256 is the
// one you read: what you checked is what becomes active. Activation is not
// a legal certification.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";

function client() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function rpc(fn, args = {}) {
  const { data, error } = await client().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

function printText(text) {
  console.log(`version : ${text.version}`);
  console.log(`kind    : ${text.kind}`);
  console.log(`state   : ${text.state}`);
  console.log(`sha256  : ${text.sha256}`);
  if (text.body !== undefined) {
    console.log("---- full text ----");
    console.log(text.body);
    console.log("-------------------");
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sha256: { type: "string" },
      note: { type: "string" },
      confirm: { type: "boolean", default: false },
    },
  });
  const [command, ...rest] = positionals;

  if (command === "list") {
    for (const text of await rpc("consent_texts_list")) {
      console.log(
        `${text.kind.padEnd(11)} ${text.version.padEnd(20)} ${text.state.padEnd(8)} ${text.sha256}`,
      );
    }
    return;
  }
  if (command === "show" && rest[0]) {
    const text = await rpc("consent_text_show", { p_version: rest[0] });
    if (!text) throw new Error("unknown version");
    printText(text);
    console.log(
      "Activate with exactly this sha256, after reading the text above.",
    );
    return;
  }
  if (command === "register" && rest.length === 3) {
    const [version, kind, file] = rest;
    const body = readFileSync(file, "utf8").trim();
    printText(
      await rpc("consent_text_register", {
        p_version: version,
        p_kind: kind,
        p_body: body,
      }),
    );
    return;
  }
  if (command === "activate" && rest[0]) {
    if (!values.sha256)
      throw new Error("--sha256 <the hash you read> is required");
    if (!values.confirm) {
      console.log(
        `Would activate ${rest[0]} (sha256 ${values.sha256}). Add --confirm to do it.`,
      );
      return;
    }
    console.log(
      await rpc("consent_text_activate", {
        p_version: rest[0],
        p_expected_sha256: values.sha256,
        p_note: values.note ?? null,
      }),
    );
    console.log("Active. Reminder: activation is not a legal certification.");
    return;
  }
  if (command === "collection" && (rest[0] === "on" || rest[0] === "off")) {
    if (!values.confirm) {
      console.log(
        `Would turn marketing consent collection ${rest[0]}. Add --confirm to do it.`,
      );
      return;
    }
    console.log(
      await rpc("platform_set_flag", {
        p_key: "marketing_consent_collection",
        p_enabled: rest[0] === "on",
        p_note: values.note ?? null,
      }),
    );
    return;
  }
  console.error("Usage: see the header of scripts/consent-admin.mjs");
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
