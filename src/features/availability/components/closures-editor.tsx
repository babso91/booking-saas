"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { isAllDayBlock } from "@/features/agenda/client/layout";
import type { AgendaBlockDto } from "@/features/agenda/data/agenda";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import { addDaysToLocalDate } from "@/lib/time/local-date";

import {
  createClosureAction,
  listClosuresAction,
  removeClosureAction,
} from "../actions/closures";

const dateLabel = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function labelOf(closure: AgendaBlockDto) {
  const display = (date: string) =>
    dateLabel.format(new Date(`${date}T00:00:00Z`));
  const start = closure.localStartsAt.slice(0, 10);
  const end = closure.localEndsAt.slice(0, 10);
  if (!isAllDayBlock(closure)) {
    return `Du ${display(start)} à ${closure.localStartsAt.slice(11)} au ${display(end)} à ${closure.localEndsAt.slice(11)}`;
  }
  const last = addDaysToLocalDate(end, -1);
  return start === last
    ? display(start)
    : `Du ${display(start)} au ${display(last)} inclus`;
}

export function ClosuresEditor({ businessId }: { businessId: string }) {
  const [closures, setClosures] = useState<AgendaBlockDto[]>([]);
  const [reload, setReload] = useState(0);
  const [listFailed, setListFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<AgendaBlockDto | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);
  const attempt = useRef<{ first: string; last: string; id: string } | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    void callAction(() => listClosuresAction({ businessId })).then((result) => {
      if (!current) return;
      setListFailed(!result.ok);
      if (result.ok) setClosures(result.data);
    });
    return () => {
      current = false;
    };
  }, [businessId, reload]);

  const refresh = () => setReload((value) => value + 1);

  async function save() {
    if (busy.current || !first || !last || last < first) return;
    if (attempt.current?.first !== first || attempt.current.last !== last) {
      attempt.current = { first, last, id: crypto.randomUUID() };
    }
    const { id } = attempt.current;
    busy.current = true;
    setPending(true);
    setNotice("");
    setError(null);
    try {
      const result = await callAction(() =>
        createClosureAction({
          businessId,
          id,
          days: { allDay: true, startDate: first, endDate: last },
        }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      attempt.current = null;
      setFirst("");
      setLast("");
      setEditing(false);
      setNotice("Fermeture enregistrée.");
      refresh();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function remove() {
    if (!removing || busy.current) return;
    busy.current = true;
    setPending(true);
    setNotice("");
    setError(null);
    try {
      const result = await callAction(() =>
        removeClosureAction({
          businessId,
          blockId: removing.id,
          expectedVersion: removing.version,
        }),
      );
      setRemoving(null);
      if (!result.ok) setError(result.error);
      else setNotice("Fermeture retirée.");
      refresh();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const errorMessage =
    error?.code === "schedule_conflict"
      ? "Il y a déjà un rendez-vous sur cette période. Vérifie ton agenda avant de fermer ces dates."
      : error?.code === "validation_error"
        ? "Vérifie les dates de la fermeture."
        : error
          ? describeError(error).message
          : "";
  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised p-4 sm:p-5">
      <h2 className="font-display text-[26px] leading-tight text-ink">
        Fermeture ponctuelle
      </h2>
      <p className="text-sm text-ink-muted">
        Fais une pause dans les réservations pour une journée, une semaine ou
        une période de ton choix.
      </p>
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Premier jour fermé"
              type="date"
              value={first}
              required
              disabled={pending}
              onChange={(event) => {
                const next = event.target.value;
                if (!last || last === first || last < next) setLast(next);
                setFirst(next);
              }}
            />
            <TextField
              label="Dernier jour fermé (inclus)"
              type="date"
              min={first || undefined}
              value={last}
              required
              disabled={pending}
              onChange={(event) => setLast(event.target.value)}
            />
          </div>
          <p className="text-sm text-ink-muted">
            Pour une seule journée, choisis la même date dans les deux champs.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="md"
              state={pending ? "loading" : "idle"}
              disabled={!first || !last || last < first}
            >
              Enregistrer la fermeture
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Retour
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="md"
          variant="secondary"
          className="self-start"
          onClick={() => {
            setEditing(true);
            setNotice("");
            setError(null);
          }}
        >
          Planifier une fermeture
        </Button>
      )}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}
      {closures.length ? (
        <ul
          className="flex flex-col gap-2 border-t border-line pt-3"
          aria-label="Fermetures prévues"
        >
          {closures.map((closure) => (
            <li
              key={closure.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span className="text-sm font-medium text-ink">
                {labelOf(closure)}
              </span>
              <Button
                size="md"
                variant="ghost"
                disabled={pending}
                onClick={() => setRemoving(closure)}
              >
                Retirer la fermeture
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {listFailed ? (
        <button
          type="button"
          className="self-start text-sm font-semibold underline"
          onClick={refresh}
        >
          Recharger les fermetures
        </button>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title="Retirer cette fermeture ?"
        description={removing ? labelOf(removing) : undefined}
        confirmLabel="Retirer la fermeture"
        state={pending && removing ? "loading" : "idle"}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void remove()}
      >
        <p className="text-sm text-ink-muted">
          Les clientes pourront de nouveau réserver selon tes disponibilités sur
          cette période.
        </p>
      </ConfirmDialog>
    </section>
  );
}
