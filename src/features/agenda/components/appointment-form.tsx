"use client";

import { useRef, useState, type FormEvent } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { SelectField } from "@/components/ui/select-field";
import {
  createAppointmentAction,
  updateAppointmentAction,
} from "@/features/agenda/actions/agenda";
import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";
import type { AgendaServicesDto } from "@/features/agenda/data/lookups";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { cn } from "@/lib/cn";

import { formatDuration, timeOf } from "../client/dates";
import { fieldErrorsCopy } from "../client/errors";
import { formatPrice } from "../client/money";
import {
  occurrenceLabel,
  timeWithOccurrence,
  type Occurrence,
} from "../client/occurrence";
import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "../client/request-id";
import { AgendaError, TextAction } from "./agenda-error";
import { ClientPicker, type PickedClient } from "./client-picker";

export type ServicesState =
  | { status: "loading" }
  | { status: "ready"; data: AgendaServicesDto }
  | { status: "error"; error: UiError };

export type AppointmentFormMode =
  | { kind: "create"; date: string; time: string }
  | { kind: "edit"; appointment: AgendaAppointmentDto };

type NewClient = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

const emptyClient: NewClient = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
};

/**
 * Creation and edition of an appointment. The server computes duration,
 * buffer, price and currency; the form only sends what the professional
 * chose. Every server answer is authoritative: nothing is shown as saved
 * before it confirms.
 */
export function AppointmentForm({
  mode,
  services,
  timezone,
  onSaved,
  onCancel,
  onRefresh,
}: {
  mode: AppointmentFormMode;
  services: ServicesState;
  timezone: string;
  onSaved: (appointment: AgendaAppointmentDto) => void;
  onCancel: () => void;
  /** Reloads the appointment after stale_appointment (edit only). */
  onRefresh?: () => Promise<UiError | null>;
}) {
  const original = mode.kind === "edit" ? mode.appointment : null;
  const originalDate = original
    ? original.localStartsAt.slice(0, 10)
    : mode.kind === "create"
      ? mode.date
      : "";
  const originalTime = original
    ? timeOf(original.localStartsAt)
    : mode.kind === "create"
      ? mode.time
      : "";
  const locked = original !== null && original.status !== "confirmed";

  const [serviceId, setServiceId] = useState(original?.service.id ?? "");
  const [date, setDate] = useState(originalDate);
  const [time, setTime] = useState(originalTime);
  const [askOccurrence, setAskOccurrence] = useState(false);
  const [occurrence, setOccurrence] = useState<Occurrence | null>(null);
  const [clientMode, setClientMode] = useState<"existing" | "new">("existing");
  const [picked, setPicked] = useState<PickedClient | null>(
    original ? original.client : null,
  );
  const [newClient, setNewClient] = useState<NewClient>(emptyClient);
  const [notes, setNotes] = useState(original?.internalNotes ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<UiError | null>(null);
  const [submitState, setSubmitState] = useState<ButtonState>("idle");
  const [refreshing, setRefreshing] = useState(false);
  const requestKey = useRef<RequestKey | null>(null);

  const timeChanged =
    original !== null && (date !== originalDate || time !== originalTime);
  const catalog = services.status === "ready" ? services.data.services : [];
  const selectedService = catalog.find((service) => service.id === serviceId);
  const keepsSnapshot = original !== null && serviceId === original.service.id;

  function changeTime(nextDate: string, nextTime: string) {
    setDate(nextDate);
    setTime(nextTime);
    // A new wall-clock time needs its own answer if it is ambiguous.
    setAskOccurrence(false);
    setOccurrence(null);
    clearError("time");
  }

  function clearError(key: string) {
    setFieldErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function validateLocally() {
    const errors: Record<string, string> = {};
    if (!serviceId) errors.serviceId = "Choisis une prestation.";
    if (!date) errors.date = "Choisis une date.";
    if (!time) errors.time = "Choisis une heure.";
    if (askOccurrence && !occurrence)
      errors.occurrence = "Choisis laquelle des deux heures.";
    if (clientMode === "existing" || original) {
      if (!picked) errors.clientId = "Choisis une cliente.";
    } else if (!newClient.firstName.trim()) {
      errors["client.firstName"] = "Indique au moins le prénom.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitState !== "idle") return;

    const errors = validateLocally();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setFormError(null);
    setSubmitState("loading");

    const result = original ? await submitEdit(original) : await submitCreate();

    if (result.ok) {
      setSubmitState("success");
      onSaved(result.data);
      return;
    }

    setSubmitState("idle");
    handleError(result.error);
  }

  function submitCreate() {
    const command = {
      date,
      time,
      occurrence: askOccurrence ? (occurrence ?? undefined) : undefined,
      serviceId,
      client:
        clientMode === "existing"
          ? { type: "existing" as const, clientId: picked!.id }
          : {
              type: "new" as const,
              firstName: newClient.firstName.normalize("NFC").trim(),
              lastName: newClient.lastName.normalize("NFC").trim() || undefined,
              email: newClient.email.trim().toLowerCase() || undefined,
              phone: newClient.phone.trim() || undefined,
            },
      internalNotes: notes.normalize("NFC").trim() || undefined,
    };
    // Same content → same key (retry, double submit); new content → new key.
    requestKey.current = requestKeyFor(
      requestKey.current,
      fingerprintOf(command),
    );
    const requestId = requestKey.current.id;

    return callAction(async () => {
      const response = await createAppointmentAction({ ...command, requestId });
      return response.ok
        ? { ok: true as const, data: response.data.appointment }
        : response;
    });
  }

  function submitEdit(appointment: AgendaAppointmentDto) {
    return callAction(() =>
      updateAppointmentAction({
        appointmentId: appointment.id,
        expectedVersion: appointment.version,
        serviceId,
        clientId: picked!.id,
        internalNotes: notes.normalize("NFC").trim() || null,
        // Unchanged time: no date/time sent and the loaded occurrence as is,
        // so the stored UTC instant is kept exactly (DST-safe).
        ...(timeChanged
          ? {
              date,
              time,
              occurrence: askOccurrence ? (occurrence ?? undefined) : undefined,
            }
          : { occurrence: appointment.startOccurrence }),
      }),
    );
  }

  function handleError(error: UiError) {
    switch (error.code) {
      case "ambiguous_local_time":
        setAskOccurrence(true);
        setFieldErrors({
          occurrence:
            "Cette heure existe deux fois ce jour-là : choisis laquelle.",
        });
        return;
      case "validation_error":
        setFieldErrors(fieldErrorsCopy(error));
        if (!error.fieldErrors) setFormError(error);
        return;
      case "service_unavailable":
        setFieldErrors({
          serviceId:
            "Cette prestation n’est plus proposée. Choisis-en une autre.",
        });
        return;
      case "client_not_found":
        setPicked(null);
        setFormError(error);
        return;
      case "idempotency_conflict":
        // Never reuse this key: the next attempt is a new command.
        requestKey.current = null;
        setFormError(error);
        return;
      default:
        setFormError(error);
    }
  }

  async function refresh() {
    if (!onRefresh) return;
    setRefreshing(true);
    const error = await onRefresh();
    setRefreshing(false);
    if (error) setFormError(error);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
      {locked ? (
        <p className="rounded-2xl bg-sand/70 px-4 py-3 text-[14px] text-ink-soft">
          Ce rendez-vous n’est plus confirmé : seule la note interne peut être
          modifiée.
        </p>
      ) : null}

      {services.status === "error" ? (
        <AgendaError error={services.error} subject="agenda" />
      ) : null}

      <SelectField
        label="Prestation"
        value={serviceId}
        disabled={locked || services.status !== "ready"}
        error={fieldErrors.serviceId}
        onChange={(event) => {
          setServiceId(event.target.value);
          clearError("serviceId");
        }}
        hint={
          services.status === "loading"
            ? "Chargement des prestations…"
            : keepsSnapshot && original
              ? `${formatDuration(original.durationMinutes)} · ${formatPrice(original.priceCents, original.currency)} (convenu à la réservation)`
              : selectedService && services.status === "ready"
                ? `${formatDuration(selectedService.durationMinutes)} · ${formatPrice(selectedService.priceCents, services.data.currency)} — confirmés par le serveur à l’enregistrement`
                : undefined
        }
      >
        <option value="" disabled>
          Choisir une prestation
        </option>
        {original &&
        !catalog.some((service) => service.id === original.service.id) ? (
          <option value={original.service.id}>
            {original.service.name} (prestation actuelle)
          </option>
        ) : null}
        {catalog.map((service) => (
          <option key={service.id} value={service.id}>
            {service.name}
          </option>
        ))}
      </SelectField>

      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Date"
          type="date"
          value={date}
          disabled={locked}
          error={fieldErrors.date}
          onChange={(event) => changeTime(event.target.value, time)}
        />
        <TextField
          label="Heure"
          type="time"
          step={300}
          value={time}
          disabled={locked}
          error={fieldErrors.time}
          onChange={(event) => changeTime(date, event.target.value)}
        />
      </div>

      {original?.startOccurrence && !timeChanged ? (
        <p className="-mt-3 text-[13.5px] text-ink-muted">
          Horaire actuel :{" "}
          {timeWithOccurrence(
            originalTime,
            original.startOccurrence,
            originalDate,
            timezone,
          )}
        </p>
      ) : null}

      {askOccurrence ? (
        <fieldset className="flex flex-col gap-2.5 rounded-2xl border border-warning/25 bg-warning-soft/60 p-4">
          <legend className="sr-only">Quelle heure ?</legend>
          <p className="text-[14.5px] font-medium text-ink">
            {time} existe deux fois ce jour-là (retour à l’heure d’hiver).
            Laquelle ?
          </p>
          {(["first", "second"] as const).map((value) => (
            <label
              key={value}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border bg-paper-raised px-3.5 text-[15px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                occurrence === value ? "border-ink" : "border-line",
              )}
            >
              <input
                type="radio"
                name="occurrence"
                value={value}
                checked={occurrence === value}
                onChange={() => {
                  setOccurrence(value);
                  clearError("occurrence");
                }}
                className="accent-[var(--ink)]"
              />
              {time} — {occurrenceLabel(value, date, timezone)}
            </label>
          ))}
          {fieldErrors.occurrence ? (
            <p className="text-[13.5px] text-warning">
              {fieldErrors.occurrence}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Cliente">
        {!original ? (
          <div
            role="tablist"
            aria-label="Type de cliente"
            className="grid grid-cols-2 gap-1 rounded-2xl bg-sand/70 p-1"
          >
            {(
              [
                ["existing", "Cliente existante"],
                ["new", "Nouvelle cliente"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={clientMode === value}
                onClick={() => setClientMode(value)}
                className={cn(
                  "h-11 cursor-pointer rounded-xl text-[14.5px] font-medium transition-colors",
                  clientMode === value
                    ? "bg-paper-raised text-ink shadow-sm"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[15px] font-medium text-ink">Cliente</p>
        )}

        {clientMode === "existing" || original ? (
          <ClientPicker
            selected={picked}
            disabled={locked}
            error={fieldErrors.clientId ?? fieldErrors["client.clientId"]}
            onSelect={(client) => {
              setPicked(client);
              clearError("clientId");
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Prénom"
                autoComplete="off"
                autoCapitalize="words"
                value={newClient.firstName}
                error={fieldErrors["client.firstName"]}
                maxLength={120}
                onChange={(event) => {
                  setNewClient({ ...newClient, firstName: event.target.value });
                  clearError("client.firstName");
                }}
              />
              <TextField
                label="Nom"
                optional
                autoComplete="off"
                autoCapitalize="words"
                value={newClient.lastName}
                error={fieldErrors["client.lastName"]}
                maxLength={120}
                onChange={(event) =>
                  setNewClient({ ...newClient, lastName: event.target.value })
                }
              />
            </div>
            <TextField
              label="Email"
              optional
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={newClient.email}
              error={fieldErrors["client.email"]}
              onChange={(event) => {
                setNewClient({ ...newClient, email: event.target.value });
                clearError("client.email");
              }}
            />
            <TextField
              label="Téléphone"
              optional
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={newClient.phone}
              error={fieldErrors["client.phone"]}
              onChange={(event) => {
                setNewClient({ ...newClient, phone: event.target.value });
                clearError("client.phone");
              }}
            />
          </div>
        )}
      </section>

      <TextAreaField
        label="Note interne"
        optional
        rows={3}
        maxLength={2000}
        value={notes}
        error={fieldErrors.internalNotes}
        placeholder="Visible uniquement par toi"
        onChange={(event) => setNotes(event.target.value)}
      />

      {formError ? (
        <AgendaError
          error={formError}
          subject="appointment"
          action={
            formError.code === "stale_appointment" && onRefresh ? (
              <TextAction onClick={refresh} disabled={refreshing}>
                {refreshing ? "Actualisation…" : "Actualiser le rendez-vous"}
              </TextAction>
            ) : formError.code === "idempotency_conflict" ? (
              <TextAction onClick={() => setFormError(null)}>
                Recommencer
              </TextAction>
            ) : formError.code === "network" ? (
              <button
                type="submit"
                className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
              >
                Réessayer
              </button>
            ) : undefined
          }
        />
      ) : null}

      <div className="sticky -bottom-6 -mx-5 -mb-6 flex flex-col gap-2 border-t border-line bg-paper-raised px-5 pt-3 pb-[max(env(safe-area-inset-bottom),1.25rem)] sm:-mx-6 sm:px-6">
        <Button
          type="submit"
          fullWidth
          size="md"
          state={submitState}
          disabled={services.status === "loading"}
          loadingLabel={original ? "Enregistrement…" : "Création…"}
          successLabel={original ? "Enregistré" : "Créé"}
        >
          {original ? "Enregistrer" : "Créer le rendez-vous"}
        </Button>
        <Button
          variant="ghost"
          size="md"
          fullWidth
          onClick={onCancel}
          className="[@media(max-height:520px)]:hidden"
          disabled={submitState !== "idle"}
        >
          Retour
        </Button>
      </div>
    </form>
  );
}
