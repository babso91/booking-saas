"use client";

import { useRef, useState } from "react";

import type { AppointmentHistory as History } from "@/features/agenda/data/history";
import { callAction, type UiError } from "@/features/auth/client/call-action";

import { getAppointmentHistoryAction } from "../actions/history";
import {
  actorLabel,
  changedAtLabel,
  describeChange,
} from "../client/history-copy";
import { AgendaError, TextAction } from "./agenda-error";

/**
 * Who changed the appointment, and what (point 100), read on demand. The
 * panel gives it a new key on each version, so it reads again after a
 * change.
 */
export function AppointmentHistory({
  appointmentId,
}: {
  appointmentId: string;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  async function load() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    const result = await callAction(() =>
      getAppointmentHistoryAction({ appointmentId }),
    );
    busy.current = false;
    setLoading(false);
    if (result.ok) setHistory(result.data);
    else setError(result.error);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !history) void load();
  }

  return (
    <section className="flex flex-col gap-3" aria-label="Historique">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`history-${appointmentId}`}
        onClick={toggle}
        className="flex min-h-11 items-center justify-between rounded-xl px-1 text-left text-[15px] font-medium text-ink-soft hover:text-ink"
      >
        Historique des modifications
        <span aria-hidden="true" className="text-[13px] text-ink-muted">
          {open ? "Masquer" : "Voir"}
        </span>
      </button>

      {open ? (
        <div id={`history-${appointmentId}`} className="flex flex-col gap-3">
          {loading && !history ? (
            <p className="text-[14px] text-ink-muted" role="status">
              Chargement de l’historique…
            </p>
          ) : null}
          {error ? (
            <AgendaError
              error={error}
              subject="appointment"
              action={
                <TextAction onClick={load} disabled={loading}>
                  Réessayer
                </TextAction>
              }
            />
          ) : null}
          {history ? (
            history.entries.length ? (
              <ol className="flex flex-col gap-3 border-l border-line pl-4">
                {history.entries.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-1">
                    <p className="text-[13px] text-ink-muted">
                      <span className="font-medium text-ink">
                        {actorLabel(entry.actor)}
                      </span>{" "}
                      · {changedAtLabel(entry)}
                    </p>
                    <ul className="flex flex-col gap-0.5 text-[14.5px] text-ink">
                      {entry.changes.map((change, index) => (
                        <li key={index}>
                          {describeChange(change, entry.actor)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[14px] text-ink-muted">
                Aucune modification enregistrée.
              </p>
            )
          ) : null}
          {history?.truncated ? (
            <p className="text-[13px] text-ink-muted">
              Seules les 100 dernières modifications sont affichées.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
