"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { formatPrice } from "@/features/agenda/client/money";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { setLoyaltyServiceRuleAction } from "@/features/loyalty/actions/loyalty";
import type { ServiceView } from "@/features/services/client/service-form";

import { spendPoints } from "../client/program-form";
import { points } from "../client/format";
import type { LoyaltyProgramDto } from "../types";
import { Badge, Card, WriteError, smallButton } from "./loyalty-parts";

const RULE_MAX = 10_000;

/** What one completed appointment of this service earns with the saved program. */
export function defaultEarning(
  program: LoyaltyProgramDto,
  service: Pick<ServiceView, "priceCents">,
) {
  if (program.accrualMode === "spend") {
    if (!program.pointsPerEuro) return "Selon le prix";
    const earned = spendPoints(service.priceCents, program.pointsPerEuro);
    return earned.capped
      ? `${points(earned.points)} au prix actuel (plafond par rendez-vous)`
      : `${points(earned.points)} au prix actuel`;
  }
  return points(program.pointsPerCompletedAppointment);
}

/**
 * Per-service rules: a fixed number of points that replaces the program's
 * calculation for one service (0: it earns nothing). Sent by value
 * (setLoyaltyServiceRuleAction has no version); the rules returned replace
 * the shown ones, the rest of the program stays as last confirmed here.
 */
export function ServiceRules({
  program,
  services,
  currency,
  onRules,
}: {
  program: LoyaltyProgramDto;
  services: ServiceView[];
  currency: string;
  onRules: (rules: LoyaltyProgramDto["serviceRules"]) => void;
}) {
  const [editing, setEditing] = useState<ServiceView | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rules = new Map(
    program.serviceRules.map((rule) => [rule.serviceId, rule.points]),
  );

  return (
    <Card
      title="Règles par prestation"
      description="Facultatif. Une règle fixe les points d’une prestation et passe avant le calcul du programme."
    >
      {services.length === 0 ? (
        <p className="text-[14px] text-ink-muted">
          Aucune prestation pour l’instant. Ajoute-les dans Prestations pour
          leur donner une règle.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {services.map((service) => {
            const rule = rules.get(service.id);
            return (
              <li
                key={service.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-[15px] font-medium wrap-anywhere text-ink">
                    {service.name}
                    {service.active ? null : (
                      <Badge tone="muted">Désactivée</Badge>
                    )}
                  </span>
                  <span className="text-[13.5px] text-ink-muted">
                    {formatPrice(service.priceCents, currency)} ·{" "}
                    {rule === undefined ? (
                      <>
                        Calcul du programme : {defaultEarning(program, service)}
                      </>
                    ) : rule === 0 ? (
                      <span className="text-ink">Règle : aucun point</span>
                    ) : (
                      <span className="text-ink">Règle : {points(rule)}</span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className={smallButton}
                  onClick={() => setEditing(service)}
                  aria-label={`${rule === undefined ? "Définir une règle pour" : "Modifier la règle de"} ${service.name}`}
                >
                  {rule === undefined ? "Définir une règle" : "Modifier"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <RuleSheet
        key={editing?.id ?? "none"}
        service={editing}
        current={editing ? (rules.get(editing.id) ?? null) : null}
        onClose={() => setEditing(null)}
        onSaved={(next, message) => {
          onRules(next);
          setAnnouncement(message);
          setEditing(null);
        }}
      />
    </Card>
  );
}

function RuleSheet({
  service,
  current,
  onClose,
  onSaved,
}: {
  service: ServiceView | null;
  current: number | null;
  onClose: () => void;
  onSaved: (rules: LoyaltyProgramDto["serviceRules"], message: string) => void;
}) {
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [error, setError] = useState<string | undefined>();
  const [write, setWrite] = useState<"idle" | "saving" | "removing" | UiError>(
    "idle",
  );
  const sending = useRef(false);
  const busy = write === "saving" || write === "removing";

  async function send(pointsValue: number | null) {
    if (!service || sending.current) return;
    sending.current = true;
    setWrite(pointsValue === null ? "removing" : "saving");
    const result = await callAction(() =>
      setLoyaltyServiceRuleAction({
        serviceId: service.id,
        points: pointsValue,
      }),
    );
    sending.current = false;
    if (!result.ok) {
      setWrite(result.error);
      return;
    }
    setWrite("idle");
    onSaved(
      result.data.serviceRules,
      pointsValue === null
        ? `Règle retirée pour ${service.name}.`
        : `Règle enregistrée pour ${service.name}.`,
    );
  }

  function save() {
    const typed = value.trim();
    const parsed = /^\d{1,5}$/.test(typed) ? Number(typed) : null;
    if (parsed === null || parsed > RULE_MAX) {
      setError("Indique un nombre entier de 0 à 10 000.");
      return;
    }
    void send(parsed);
  }

  return (
    <Sheet
      open={service !== null}
      onClose={() => (busy ? undefined : onClose())}
      title="Règle de points"
      description={service?.name}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {current !== null ? (
            <Button
              variant="ghost"
              size="md"
              state={write === "removing" ? "loading" : "idle"}
              loadingLabel="Retrait…"
              disabled={write === "saving"}
              onClick={() => void send(null)}
            >
              Retirer la règle
            </Button>
          ) : null}
          <Button
            size="md"
            type="submit"
            form="rule-form"
            state={write === "saving" ? "loading" : "idle"}
            loadingLabel="Enregistrement…"
            disabled={write === "removing"}
          >
            Enregistrer
          </Button>
        </div>
      }
    >
      <form
        id="rule-form"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <TextField
          label="Points pour un rendez-vous terminé"
          inputMode="numeric"
          value={value}
          data-autofocus=""
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
            if (typeof write !== "string") setWrite("idle");
          }}
          error={error}
          hint="0 : cette prestation ne rapporte aucun point."
          disabled={busy}
        />
        <p className="text-[13.5px] text-ink-muted">
          S’applique aux prochains rendez-vous terminés. Les points déjà gagnés
          ne changent pas.
          {current !== null
            ? " Retirer la règle revient au calcul du programme."
            : null}
        </p>
        {typeof write !== "string" ? (
          <WriteError error={write}>
            La règle n’a pas été enregistrée.
          </WriteError>
        ) : null}
      </form>
    </Sheet>
  );
}
