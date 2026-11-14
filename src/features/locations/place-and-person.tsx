"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/cn";

import {
  dayName,
  localClock,
  localDay,
  locationsErrors,
  type LocationsBookingActions,
  type PublicLocationDto,
  type PublicStaffDto,
  type SlotDto,
  type StaffPreference,
} from "./contract";

// Where, with whom, when: the place first, then the person, then the day.
// A single place or a single person skips its step (the solo journey stays
// as it is). "First available" is a choice she makes, shown as such; a
// named person is never swapped for another. A slot taken meanwhile gives
// her the hand back with her place and service kept.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const option =
  "flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-3xl border border-line bg-paper-raised px-4 py-4 text-left transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink aria-pressed:border-ink sm:px-5";

type Setup = { locations: PublicLocationDto[]; staff: PublicStaffDto[] };

export function PlaceAndPerson({
  serviceId,
  serviceName,
  actions,
}: {
  serviceId: string;
  serviceName: string;
  actions: LocationsBookingActions;
}) {
  const [setup, setSetup] = useState<Setup | "error" | null>(null);
  const [run, setRun] = useState(0);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [preference, setPreference] = useState<StaffPreference | null>(null);
  const [answer, setAnswer] = useState<{
    key: string;
    value: { slots: SlotDto[]; revision: string } | "error";
  } | null>(null);
  const [slotsRun, setSlotsRun] = useState(0);
  const [picked, setPicked] = useState<SlotDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [held, setHeld] = useState<{
    slot: SlotDto;
    staffName: string | null;
  } | null>(null);
  const requestIds = useRef(new Map<string, string>());

  useEffect(() => {
    let current = true;
    void actions.setup(serviceId).then((result) => {
      if (!current) return;
      if (!result.ok) return setSetup("error");
      setSetup(result.data);
      // One place, or one person there: nothing to choose.
      if (result.data.locations.length === 1)
        setLocationId(result.data.locations[0]!.id);
    });
    return () => {
      current = false;
    };
  }, [actions, serviceId, run]);

  const people =
    setup && setup !== "error" && locationId
      ? setup.staff.filter((person) => person.locationIds.includes(locationId))
      : [];
  const effective: StaffPreference | null =
    preference ??
    (people.length === 1 ? { kind: "staff", staffId: people[0]!.id } : null);

  // One query per place, preference and retry; its answer is kept by key,
  // so an answer for an earlier choice never shows.
  const queryKey =
    locationId && effective
      ? JSON.stringify([locationId, effective, slotsRun])
      : null;
  useEffect(() => {
    if (!queryKey) return;
    const [where, staffPreference] = JSON.parse(queryKey) as [
      string,
      StaffPreference,
    ];
    let current = true;
    void actions
      .availability({ serviceId, locationId: where, staffPreference })
      .then((result) => {
        if (!current) return;
        setAnswer({
          key: queryKey,
          value: result.ok
            ? {
                slots: result.data.slots,
                revision: result.data.scheduleRevision,
              }
            : "error",
        });
      });
    return () => {
      current = false;
    };
  }, [actions, serviceId, queryKey]);
  const slots = queryKey && answer?.key === queryKey ? answer.value : "loading";

  if (setup === null)
    return (
      <div role="status" aria-label="Chargement…">
        <div className="h-48 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (setup === "error")
    return (
      <Notice
        tone="error"
        title="Les disponibilités n’ont pas pu être chargées"
        action={
          <button
            type="button"
            className={linkAction}
            onClick={() => setRun((n) => n + 1)}
          >
            Réessayer
          </button>
        }
      >
        Rien n’a été réservé.
      </Notice>
    );

  const location = setup.locations.find((l) => l.id === locationId) ?? null;
  const personName = (id: string) =>
    setup.staff.find((p) => p.id === id)?.displayName ?? "";

  if (held)
    return (
      <Notice tone="success" title="Créneau retenu">
        {serviceName}, {dayName(localDay(held.slot))} à {localClock(held.slot)},{" "}
        {location?.name}
        {held.staffName
          ? `, avec ${held.staffName}`
          : ", avec la première personne disponible"}
        . Il reste à confirmer vos coordonnées.
      </Notice>
    );

  async function hold() {
    if (
      !picked ||
      !location ||
      !effective ||
      busy ||
      !slots ||
      typeof slots === "string"
    )
      return;
    const key = `${location.id}:${JSON.stringify(effective)}:${picked.startsAt}:${slots.revision}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy(true);
    setNotice(null);
    const result = await actions.hold({
      serviceId,
      locationId: location.id,
      staffPreference: effective,
      startsAt: picked.startsAt,
      scheduleRevision: slots.revision,
      requestId: requestIds.current.get(key)!,
    });
    setBusy(false);
    if (result.ok)
      return setHeld({ slot: picked, staffName: result.data.staffDisplayName });
    setPicked(null);
    const code = result.error.code;
    if (
      code === locationsErrors.slotUnavailable ||
      code === locationsErrors.configurationChanged
    ) {
      setNotice(
        code === locationsErrors.slotUnavailable
          ? "Ce créneau vient d’être pris. Le lieu et la prestation sont conservés : choisissez un autre horaire."
          : "Les horaires viennent de changer. Le lieu et la prestation sont conservés : voici les créneaux à jour.",
      );
      return setSlotsRun((n) => n + 1);
    }
    setNotice(
      code === "network"
        ? "Pas de réponse. Réessayez : un même créneau n’est jamais retenu deux fois."
        : "Le créneau n’a pas pu être retenu. Réessayez dans un instant.",
    );
  }

  const byDay = new Map<string, SlotDto[]>();
  if (slots && typeof slots !== "string")
    for (const item of slots.slots) {
      const day = localDay(item);
      byDay.set(day, [...(byDay.get(day) ?? []), item]);
    }

  return (
    <div className="flex flex-col gap-7">
      <p className="text-[14px] text-ink-soft">{serviceName}</p>

      {setup.locations.length > 1 ? (
        <section aria-labelledby="where" className="flex flex-col gap-3">
          <h2
            id="where"
            className="font-display text-[24px] leading-tight text-ink"
          >
            Où ?
          </h2>
          <ul className="flex flex-col gap-2">
            {setup.locations.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={item.id === locationId}
                  className={option}
                  onClick={() => {
                    if (item.id === locationId) return;
                    setLocationId(item.id);
                    setPreference(null);
                    setPicked(null);
                    setNotice(null);
                  }}
                >
                  <span className="text-[16px] font-semibold text-ink">
                    {item.name}
                  </span>
                  <span className="text-[14px] text-ink-soft">
                    {item.address}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {location && people.length > 1 ? (
        <section aria-labelledby="who" className="flex flex-col gap-3">
          <h2
            id="who"
            className="font-display text-[24px] leading-tight text-ink"
          >
            Avec qui ?
          </h2>
          <ul className="flex flex-col gap-2">
            <li>
              <button
                type="button"
                aria-pressed={preference?.kind === "any"}
                className={option}
                onClick={() => {
                  setPreference({ kind: "any" });
                  setPicked(null);
                  setNotice(null);
                }}
              >
                <span className="text-[16px] font-semibold text-ink">
                  Première disponibilité
                </span>
                <span className="text-[14px] text-ink-soft">
                  La personne disponible au créneau choisi, parmi{" "}
                  {people.map((p) => p.displayName).join(" et ")}.
                </span>
              </button>
            </li>
            {people.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  aria-pressed={
                    preference?.kind === "staff" &&
                    preference.staffId === person.id
                  }
                  className={option}
                  onClick={() => {
                    setPreference({ kind: "staff", staffId: person.id });
                    setPicked(null);
                    setNotice(null);
                  }}
                >
                  <span className="text-[16px] font-semibold text-ink">
                    {person.displayName}
                  </span>
                  <span className="text-[14px] text-ink-soft">
                    Uniquement avec elle
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {notice ? (
        <Notice tone="warning" title="À revoir">
          {notice}
        </Notice>
      ) : null}

      {location && effective ? (
        <section aria-labelledby="when" className="flex flex-col gap-4">
          <h2
            id="when"
            className="font-display text-[24px] leading-tight text-ink"
          >
            Quand ?
          </h2>
          {slots === "loading" ? (
            <div role="status" aria-label="Chargement des créneaux…">
              <div className="h-32 animate-pulse rounded-3xl bg-sand/70" />
            </div>
          ) : slots === "error" ? (
            <Notice
              tone="error"
              title="Les créneaux n’ont pas pu être chargés"
              action={
                <button
                  type="button"
                  className={linkAction}
                  onClick={() => setSlotsRun((n) => n + 1)}
                >
                  Réessayer
                </button>
              }
            >
              Rien n’a été réservé.
            </Notice>
          ) : byDay.size === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-[15px] text-ink-soft">
                {effective.kind === "staff"
                  ? `Aucune disponibilité avec ${personName(effective.staffId)} pour le moment à ${location.name}.`
                  : `Aucune disponibilité pour le moment à ${location.name}.`}
              </p>
              {effective.kind === "staff" && people.length > 1 ? (
                <button
                  type="button"
                  className={cn(linkAction, "w-fit")}
                  onClick={() => setPreference({ kind: "any" })}
                >
                  Voir la première disponibilité
                </button>
              ) : null}
            </div>
          ) : (
            [...byDay.entries()].map(([day, items]) => (
              <fieldset key={day} className="flex flex-col gap-2">
                <legend className="mb-1 text-[15px] font-medium text-ink first-letter:uppercase">
                  {dayName(day)}
                </legend>
                <div className="flex flex-wrap gap-2">
                  {items.map((item) => {
                    const selected = picked?.startsAt === item.startsAt;
                    return (
                      <button
                        key={item.startsAt}
                        type="button"
                        aria-pressed={selected}
                        aria-label={`${dayName(day)} à ${localClock(item)}`}
                        onClick={() => setPicked(item)}
                        className={cn(
                          "h-11 cursor-pointer rounded-full border px-5 text-[15px] tabular-nums transition-colors",
                          selected
                            ? "border-ink bg-ink text-paper-raised"
                            : "border-line bg-paper-raised text-ink hover:border-line-strong",
                        )}
                      >
                        {localClock(item)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))
          )}

          {picked ? (
            <Button
              size="lg"
              state={busy ? "loading" : "idle"}
              loadingLabel="Vérification…"
              onClick={() => void hold()}
            >
              Réserver le {dayName(localDay(picked))} à {localClock(picked)}
            </Button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
