import { z } from "zod";

import { CLIENT_FILTERS, CLIENT_SORTS } from "@/features/crm/types";

// Inputs of the CRM read model. No business identifier is accepted: the
// tenant comes from the session (runBusinessAction). Cursors are opaque and
// only position a read; they never authorize one.

export const MAX_DIRECTORY_PAGE = 100;
export const MAX_TIMELINE_PAGE = 100;

const cursorSchema = z.string().min(1).max(1024).nullish();

export const listClientsSchema = z
  .object({
    /** Name, email or phone fragment; empty = every customer. */
    query: z
      .string()
      .transform((value) => value.normalize("NFC").trim())
      .pipe(z.string().max(100))
      .nullish()
      .transform((value) => value ?? ""),
    filter: z.enum(CLIENT_FILTERS).default("all"),
    sort: z.enum(CLIENT_SORTS).default("name"),
    limit: z.number().int().min(1).max(MAX_DIRECTORY_PAGE).default(25),
    cursor: cursorSchema,
  })
  .default({ query: "", filter: "all", sort: "name", limit: 25 });

export type ListClientsInput = z.output<typeof listClientsSchema>;

export const clientIdSchema = z.object({ clientId: z.uuid() });

export const clientTimelineSchema = z.object({
  clientId: z.uuid(),
  limit: z.number().int().min(1).max(MAX_TIMELINE_PAGE).default(20),
  cursor: cursorSchema,
});

export type ClientTimelineInput = z.output<typeof clientTimelineSchema>;
