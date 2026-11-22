"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import type {
  ClosureAppointment,
  ClosureDone,
  ClosurePreview,
} from "@/features/availability/data/closure";
import { MESSAGE_LINK } from "@/features/availability/schemas/closure";

import { commitClosureAction, previewClosureAction } from "../actions/closures";

// An unexpected closure over booked dates (point 101): each appointment is
// cancelled or moved, then everything is done at once on her confirmation.

const dayLabel = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** "samedi 6 décembre à 10:00", from a business wall clock. */
export function wallClockLabel(wallClock: string) {
  const day = dayLabel.format(new Date(`${wallClock.slice(0, 10)}T00:00:00Z`));
  return `${day} à ${wallClock.slice(11, 16)}`;
}

const nameOf = (client: ClosureAppointment["client"]) =>
  [client.firstName, client.lastName].filter(Boolean).join(" ") || "Cliente";

type Choice = { action: "cancel" | "move"; date: string; time: string };

const plural = (count: number, one: string, many: string) =>
  `${count} ${count > 1 ? many : one}`;

export function ClosurePlanner({
  businessId,
  startDate,
  endDate,
  preview: initial,
  periodLabel,
  onDone,
  onBack,
}: {
  businessId: string;
  startDate: string;
  endDate: string;
  preview: ClosurePreview;
  /** "le 6 décembre", "du 6 au 8 décembre inclus". */
  periodLabel: string;
  onDone: (done: ClosureDone) => void;
  onBack: () => void;
}) {
  const [preview, setPreview] = useState(initial);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const busy = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);

  const choiceOf = (appointment: ClosureAppointment): Choice =>
    choices[appointment.id] ?? {
      action: "cancel",
      date: "",
      time: appointment.localStartsAt.slice(11, 16),
    };
  const setChoice = (id: string, choice: Choice) => {
    setChoices((current) => ({ ...current, [id]: choice }));
    setError(null);
  };

  const appointments = preview.appointments;
  const moves = appointments.filter((a) => choiceOf(a).action === "move");
  const incomplete = moves.some((a) => !choiceOf(a).date || !choiceOf(a).time);
  const told = appointments.filter(
    (a) => a.client.email && !(choiceOf(a).action === "cancel" && a.begun),
  ).length;
  const untold = appointments.filter((a) => !a.client.email);
  const cancelCount = appointments.length - moves.length;
  const rowError = error?.fieldErrors?.appointmentId?.[0];
  const linked = MESSAGE_LINK.test(message);

  const summary = appointments.length
    ? [
        cancelCount
          ? plural(cancelCount, "rendez-vous annulé", "rendez-vous annulés")
          : null,
        moves.length
          ? plural(moves.length, "rendez-vous reporté", "rendez-vous reportés")
          : null,
      ]
        .filter(Boolean)
        .join(", ") +
      (told
        ? `. ${plural(told, "cliente sera prévenue", "clientes seront prévenues")} par e-mail.`
        : ".")
    : "Aucun rendez-vous à venir sur ces dates.";

  async function reload() {
    const result = await callAction(() =>
      previewClosureAction({ businessId, startDate, endDate }),
    );
    if (result.ok) setPreview(result.data);
  }

  async function commit() {
    if (busy.current) return;
    const decisions = appointments.map((appointment) => {
      const choice = choiceOf(appointment);
      return {
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        moveTo:
          choice.action === "move" ? `${choice.date}T${choice.time}` : null,
      };
    });
    const payload = { decisions, message: message.trim() };
    const key = JSON.stringify(payload);
    // The same request again after a lost answer, a new one otherwise.
    if (attempt.current?.key !== key) {
      attempt.current = { key, id: crypto.randomUUID() };
    }
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await callAction(() =>
        commitClosureAction({
          businessId,
          requestId: attempt.current!.id,
          startDate,
          endDate,
          ...(payload.message ? { message: payload.message } : {}),
          decisions,
        }),
      );
      setConfirming(false);
      if (result.ok) {
        onDone(result.data);
        return;
      }
      setError(result.error);
      // Someone booked or changed an appointment meanwhile: the list again.
      if (result.error.code === "closure_stale") await reload();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const errorMessage = error?.fieldErrors?.message
    ? ""
    : error?.code === "validation_error" && rowError
      ? "Choisis un nouvel horaire à venir, en dehors des dates fermées."
      : error?.code === "ambiguous_local_time"
        ? "Cette heure existe deux fois ce jour-là (changement d’heure) : choisis-en une autre."
        : error
          ? describeError(error).message
          : "";

  return (
    <section
      className="flex flex-col gap-4 border-t border-line pt-4"
      aria-label="Rendez-vous sur ces dates"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-[17px] font-semibold text-ink">
          {appointments.length
            ? `${plural(appointments.length, "rendez-vous", "rendez-vous")} ${periodLabel}`
            : `Fermer ${periodLabel}`}
        </h3>
        <p className="text-sm text-ink-muted">
          {appointments.length
            ? "Choisis pour chacun : l’annuler ou le reporter. Rien n’est fait avant ta confirmation."
            : "Plus aucun rendez-vous à venir sur ces dates : la fermeture commence maintenant."}
        </p>
      </div>

      {appointments.length ? (
        <ul className="flex flex-col gap-3">
          {appointments.map((appointment) => {
            const choice = choiceOf(appointment);
            const name = nameOf(appointment.client);
            return (
              <li
                key={appointment.id}
                className="flex flex-col gap-3 rounded-2xl border border-line p-3"
              >
                <ChoiceChips
                  name={`closure-${appointment.id}`}
                  legend={`${name} · ${wallClockLabel(appointment.localStartsAt)}`}
                  description={appointment.serviceName}
                  value={choice.action}
                  options={[
                    { value: "cancel", label: "Annuler" },
                    { value: "move", label: "Reporter" },
                  ]}
                  onChange={(action) =>
                    setChoice(appointment.id, { ...choice, action })
                  }
                />
                {choice.action === "move" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <TextField
                      label={`Nouvelle date pour ${name}`}
                      type="date"
                      value={choice.date}
                      required
                      disabled={pending}
                      onChange={(event) =>
                        setChoice(appointment.id, {
                          ...choice,
                          date: event.target.value,
                        })
                      }
                    />
                    <TextField
                      label={`Nouvelle heure pour ${name}`}
                      type="time"
                      step={300}
                      value={choice.time}
                      required
                      disabled={pending}
                      onChange={(event) =>
                        setChoice(appointment.id, {
                          ...choice,
                          time: event.target.value,
                        })
                      }
                    />
                  </div>
                ) : null}
                <p className="text-[13.5px] text-ink-muted">
                  {!appointment.client.email
                    ? `Pas d’e-mail : préviens-la toi-même${appointment.client.phone ? ` au ${appointment.client.phone}` : ""}.`
                    : appointment.begun && choice.action === "cancel"
                      ? "Déjà commencé : elle ne sera pas prévenue par e-mail."
                      : "Elle sera prévenue par e-mail."}
                </p>
                {rowError === appointment.id && errorMessage ? (
                  <p className="text-[13.5px] font-medium text-danger">
                    {errorMessage}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {told ? (
        <TextAreaField
          label="Un mot pour tes clientes"
          optional
          hint="Il apparaît dans l’e-mail, après l’annonce de la fermeture. Sans lien : celui pour reprendre rendez-vous est ajouté."
          error={
            linked || error?.fieldErrors?.message
              ? "Retire le lien : celui pour reprendre rendez-vous est déjà dans l’e-mail."
              : undefined
          }
          value={message}
          maxLength={500}
          counterMax={500}
          rows={3}
          disabled={pending}
          onChange={(event) => setMessage(event.target.value)}
        />
      ) : null}

      {untold.length ? (
        <Notice tone="info">
          {untold.length === 1
            ? `${nameOf(untold[0]!.client)} n’a pas d’e-mail : pense à la prévenir.`
            : `${untold.map((a) => nameOf(a.client)).join(", ")} n’ont pas d’e-mail : pense à les prévenir.`}
        </Notice>
      ) : null}

      {errorMessage &&
      !(rowError && appointments.some((a) => a.id === rowError)) ? (
        <Notice tone="error">{errorMessage}</Notice>
      ) : null}

      <p className="text-sm font-medium text-ink">{summary}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="md"
          variant="danger"
          disabled={pending || incomplete || linked}
          onClick={() => setConfirming(true)}
        >
          {told ? "Fermer et prévenir mes clientes" : "Fermer ces dates"}
        </Button>
        <Button size="md" variant="ghost" disabled={pending} onClick={onBack}>
          Retour
        </Button>
      </div>

      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={`Fermer ${periodLabel} ?`}
        description={summary}
        confirmLabel="Confirmer la fermeture"
        state={pending ? "loading" : "idle"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void commit()}
      >
        <p className="text-sm text-ink-muted">
          C’est fait d’un coup : les annulations et les reports, la fermeture et
          les e-mails. Les clientes ne pourront plus réserver sur ces dates.
        </p>
      </ConfirmDialog>
    </section>
  );
}
