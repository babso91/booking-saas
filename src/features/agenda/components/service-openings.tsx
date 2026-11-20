"use client";

import { useEffect, useState } from "react";
import type { PublicCatalog } from "@/features/catalog/model";
import type { DayFlow } from "@/features/dashboard/agenda/day-flow";
import {
  fetchAvailabilityCalendar,
  fetchPublicBusiness,
  type CalendarAvailabilityDay,
} from "@/features/public-booking/client/api";
import {
  answersFor,
  choiceIdsOf,
  type Answers,
} from "@/features/public-booking/client/use-booking-flow";
import { addDaysToLocalDate } from "@/lib/time/local-date";
import {
  formatDuration,
  formatFullDate,
  timeOf,
  type VisibleRange,
} from "../client/dates";
import type { AgendaDto } from "../data/agenda";

const selectClass =
  "min-h-11 w-full rounded-xl border border-line bg-paper-raised px-3 text-base text-ink";
type PublicSchedule = {
  catalog: PublicCatalog;
  today: string;
  lastDay: string;
};
type PublicSlots = {
  key: string;
  source: AgendaDto;
  days: CalendarAvailabilityDay[] | null;
};

export function ServiceOpenings({
  slug,
  flows,
  range,
  data,
}: {
  slug: string;
  flows: Map<string, DayFlow> | null;
  range: VisibleRange;
  data: AgendaDto | null;
}) {
  const [catalogue, setCatalogue] = useState<{
    slug: string;
    data: PublicSchedule | null;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const [serviceId, setServiceId] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [result, setResult] = useState<PublicSlots | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchPublicBusiness(slug, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      const value = response.ok ? response.data : null;
      setCatalogue({
        slug,
        data: value && {
          catalog: value.catalog,
          today: value.business.today,
          lastDay: addDaysToLocalDate(
            value.business.today,
            value.business.maximumBookingAdvanceDays,
          ),
        },
      });
    });
    return () => controller.abort();
  }, [slug, retry]);

  const schedule = catalogue?.slug === slug ? catalogue.data : undefined;
  const services = schedule?.catalog.groups.flatMap((g) => g.services) ?? [];
  const service = services.find((item) => item.id === serviceId);
  const selected = service ? answersFor(service, answers) : {};
  const choices = service ? choiceIdsOf(service, selected).join(",") : "";
  const from =
    schedule && schedule.today > range.startDate
      ? schedule.today
      : range.startDate;
  const through =
    schedule && schedule.lastDay < range.endDate
      ? schedule.lastDay
      : range.endDate;
  const showSlots = Boolean(service && from <= through);
  const key = [slug, serviceId, choices, from, through, retry].join(":");

  useEffect(() => {
    if (!showSlots || !data) return;
    const controller = new AbortController();
    void fetchAvailabilityCalendar(
      slug,
      serviceId,
      from,
      through,
      choices ? choices.split(",") : [],
      controller.signal,
    ).then((response) => {
      if (!controller.signal.aborted)
        setResult({
          key,
          source: data,
          days: response.ok ? response.data.days : null,
        });
    });
    return () => controller.abort();
  }, [key, data, showSlots, slug, serviceId, choices, from, through]);

  const loaded = result?.key === key && result.source === data ? result : null;
  const byDate = new Map(loaded?.days?.map((day) => [day.date, day.slots]));
  const retryButton = (
    <button
      type="button"
      className="min-h-11 underline underline-offset-4"
      onClick={() => setRetry((value) => value + 1)}
    >
      Réessayer
    </button>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-2xl border border-line bg-paper-raised p-4 glass-surface sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium text-ink">
          Afficher les disponibilités
          <select
            className={selectClass}
            value={serviceId}
            onChange={(event) => {
              setServiceId(event.target.value);
              setAnswers({});
            }}
          >
            <option value="">Toutes les plages libres</option>
            {services.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {service?.options.map((option) => (
          <label
            key={option.id}
            className="grid gap-1 text-sm font-medium text-ink"
          >
            {option.question}
            <select
              className={selectClass}
              value={selected[option.id] ?? ""}
              onChange={(event) =>
                setAnswers({
                  ...selected,
                  [option.id]: event.target.value || null,
                })
              }
            >
              {option.required ? null : (
                <option value="">Sans supplément</option>
              )}
              {option.choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {schedule === null ? (
          <p role="alert" className="text-sm text-ink-soft">
            Le catalogue en ligne est indisponible. {retryButton}
          </p>
        ) : null}
      </div>
      {!data || !flows ? null : showSlots && !loaded ? (
        <p role="status" className="text-sm text-ink-muted">
          Recherche des créneaux réservables…
        </p>
      ) : showSlots && loaded?.days === null ? (
        <p role="alert" className="text-sm text-ink">
          Les créneaux n’ont pas pu être vérifiés. {retryButton}
        </p>
      ) : (
        <div className="divide-y divide-line rounded-2xl border border-line bg-paper-raised px-4 glass-surface">
          {range.days.map((date) => {
            const flow = flows.get(date);
            const labels = service
              ? (byDate.get(date) ?? []).map((slot) =>
                  timeOf(slot.localStartsAt),
                )
              : (flow?.items.flatMap((item) =>
                  item.kind === "free"
                    ? [item.time + " · " + formatDuration(item.minutes)]
                    : [],
                ) ?? []);
            return (
              <section
                key={date}
                className="grid gap-1 py-3 sm:grid-cols-[11rem_1fr] sm:items-baseline"
              >
                <h2 className="text-sm font-semibold capitalize text-ink">
                  {formatFullDate(date)}
                </h2>
                {labels.length ? (
                  <div>
                    <Hours values={labels.slice(0, 6)} />
                    {labels.length > 6 ? (
                      <details>
                        <summary className="min-h-11 cursor-pointer pt-2 text-sm text-ink-soft">
                          Voir les {labels.length - 6} autres horaires
                        </summary>
                        <Hours values={labels.slice(6)} />
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-ink-muted">
                    {flow?.closed
                      ? "Fermé"
                      : service
                        ? "Aucun créneau réservable"
                        : "Aucune plage libre"}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Hours({ values }: { values: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {values.map((value, index) => (
        <li
          key={index}
          className="rounded-md bg-sand px-2 py-1 text-sm text-ink tabular-nums"
        >
          {value}
        </li>
      ))}
    </ul>
  );
}
