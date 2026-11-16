"use client";

import Link from "next/link";
import { useMemo } from "react";

import { ChevronRightIcon } from "@/components/ui/icons";
import { ClientForm } from "@/features/forms/client-form";
import type {
  ClientFormActions,
  ClientFormDto,
  FormResult,
} from "@/features/forms/contract";

import {
  fetchForm,
  fetchForms,
  submitForm,
  type HubResult,
} from "../client/api";
import { useClientHub, useHubRead } from "../client/session";
import { HubPage } from "./hub-shell";

/**
 * Her forms in her space (docs/CLIENT_FORMS_CONTRACT.md, Hub routes), under
 * the Hub's own rule: an answer is shown only for the account the page
 * confirmed; one served for someone else (or a 401) is dropped and who is
 * signed in is checked again; a 404 asks it again too (an access may have
 * been revoked).
 */

/** The form screen's actions on the Hub routes, under that rule. */
function useHubFormActions(businessId: string): ClientFormActions {
  const { session, accepts, distrust, recheck } = useClientHub();
  const owner = session.generation;
  return useMemo<ClientFormActions>(() => {
    function checked<T>(result: HubResult<T>): FormResult<T> {
      if (!result.ok && result.error.code === "client_hub_unauthenticated") {
        distrust(owner);
        return { ok: false, error: { code: "network" } };
      }
      if (!result.ok) {
        if (result.error.code === "client_hub_not_found") {
          recheck();
          return { ok: false, error: { code: "not_found" } };
        }
        // field_required names its question in fieldErrors (contract).
        const fieldId = Object.keys(result.error.fieldErrors ?? {})[0];
        return {
          ok: false,
          error: { code: result.error.code, ...(fieldId ? { fieldId } : {}) },
        };
      }
      if (!accepts(owner, result.account)) {
        // Served for someone else, or naming no account: never shown.
        distrust(owner);
        return { ok: false, error: { code: "network" } };
      }
      return { ok: true, data: result.data };
    }
    return {
      read: async (assignmentId) =>
        checked(await fetchForm(businessId, assignmentId)),
      submit: async ({ assignmentId, ...body }) =>
        checked(await submitForm(businessId, assignmentId, body)),
    };
  }, [accepts, businessId, distrust, owner, recheck]);
}

/** `/espace/[businessId]/formulaires/[assignmentId]`. */
export function HubFormPage({
  businessId,
  assignmentId,
}: {
  businessId: string;
  assignmentId: string;
}) {
  const actions = useHubFormActions(businessId);
  // The Hub's frame: signed-out visitors go to sign-in, as on every page.
  return (
    <HubPage section="appointments" businessId={businessId}>
      {() => (
        <div className="flex w-full max-w-xl flex-col gap-6">
          <Link
            href="/espace"
            className="w-fit text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            ← Mon espace
          </Link>
          <ClientForm assignmentId={assignmentId} actions={actions} />
        </div>
      )}
    </HubPage>
  );
}

const statusText: Partial<Record<ClientFormDto["status"], string>> = {
  assigned: "À remplir",
  submitted: "Envoyé",
  under_review: "Envoyé",
  completed: "Envoyé",
};

/**
 * The forms asked for one visit, on its page. A form's deadline is the
 * start of its visit (contract, « Échéance »): that is how a form is tied
 * to this appointment until the list names the appointment itself.
 */
export function VisitFormsLinks({
  businessId,
  startsAt,
}: {
  businessId: string;
  startsAt: string;
}) {
  const read = useHubRead(`forms:${businessId}`, (signal) =>
    fetchForms(businessId, signal),
  );
  if (read.status !== "ready") return null;
  const start = Date.parse(startsAt);
  const forms = read.data.filter(
    (form) =>
      form.expiresAt !== null &&
      Date.parse(form.expiresAt) === start &&
      statusText[form.status],
  );
  if (forms.length === 0) return null;
  return (
    <section
      aria-labelledby="visit-forms"
      className="flex flex-col gap-2 border-t border-line pt-5"
    >
      <h2 id="visit-forms" className="text-[17px] font-semibold text-ink">
        Avant votre visite
      </h2>
      <ul className="flex flex-col divide-y divide-line">
        {forms.map((form) => (
          <li key={form.assignmentId}>
            <Link
              href={`/espace/${businessId}/formulaires/${form.assignmentId}`}
              className="group -mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-sand/50"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[15.5px] font-semibold wrap-anywhere text-ink">
                  {form.title}
                </span>
                <span
                  className={
                    form.status === "assigned"
                      ? "text-[13.5px] font-medium text-ink"
                      : "text-[13.5px] text-ink-muted"
                  }
                >
                  {statusText[form.status]}
                </span>
              </span>
              <ChevronRightIcon
                size={18}
                className="shrink-0 text-ink-muted transition-transform duration-150 group-hover:translate-x-0.5"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
