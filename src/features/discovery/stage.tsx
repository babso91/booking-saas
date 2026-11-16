"use client";

import {
  AgendaPulse,
  agendaPulse,
} from "@/features/agenda/components/agenda-pulse";
import { AppShell } from "@/features/agenda/components/app-shell";
import { TimeGrid } from "@/features/agenda/components/time-grid";
import { useDashboardStyle } from "@/features/appearance/components/appearance-provider";
import { CarnetToday } from "@/features/dashboard/carnet/carnet-today";
import { StudioToday } from "@/features/dashboard/components/studio-today";
import { EcrinToday } from "@/features/dashboard/ecrin/ecrin-today";
import { SAMPLE_IDENTITY } from "@/features/dashboard/fixtures/sample-identity";
import {
  SAMPLE_TODAY,
  sampleInstant,
  sampleWeek,
} from "@/features/dashboard/fixtures/sample-week";

/**
 * The real professional software, on a fictional week, under her salon's
 * name: the same shells and screens as her area (AppShell, StudioToday,
 * EcrinToday, CarnetToday, the agenda's TimeGrid), in the style the
 * surrounding AppearanceProvider sets. Nothing is read or written: every
 * link and server action is caught by the discovery around it.
 */

export const DISCOVERY_NOW = Date.parse(sampleInstant(SAMPLE_TODAY, "14:05"));
const WEEK = sampleWeek.workingHours.days.map((day) => day.date);

export function Stage({
  businessName,
  onIntent,
}: {
  businessName: string;
  /** Something that would open her real area (a visit, a page). */
  onIntent: (what: string) => void;
}) {
  const style = useDashboardStyle();
  const business = {
    name: businessName.trim() || "Ton salon",
    slug: "ton-salon",
  };
  return (
    <AppShell
      identity={SAMPLE_IDENTITY}
      business={business}
      current={style === "classique" ? "agenda" : "today"}
    >
      {style === "studio" ? (
        <StudioToday
          agenda={sampleWeek}
          date={SAMPLE_TODAY}
          serverNow={DISCOVERY_NOW}
          frozenNow={DISCOVERY_NOW}
        />
      ) : style === "ecrin" ? (
        <EcrinToday
          agenda={sampleWeek}
          date={SAMPLE_TODAY}
          serverNow={DISCOVERY_NOW}
          frozenNow={DISCOVERY_NOW}
        />
      ) : style === "carnet" ? (
        <CarnetToday
          agenda={sampleWeek}
          date={SAMPLE_TODAY}
          serverNow={DISCOVERY_NOW}
          frozenNow={DISCOVERY_NOW}
        />
      ) : (
        <ClassicWeek onIntent={onIntent} />
      )}
    </AppShell>
  );
}

/** Classique's home is the agenda: its header and its real week grid. */
function ClassicWeek({ onIntent }: { onIntent: (what: string) => void }) {
  const pulse = agendaPulse(sampleWeek, WEEK, SAMPLE_TODAY, DISCOVERY_NOW);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-3 border-b border-line bg-paper px-4 pt-3 pb-3 sm:px-6 lg:px-8 lg:pt-6">
        <h1 className="font-display text-[22px] leading-none text-ink sm:text-[24px]">
          Semaine du 26 octobre
        </h1>
        <AgendaPulse
          pulse={pulse}
          view="week"
          onOpen={() => onIntent("ouvrir ce rendez-vous")}
        />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TimeGrid
          days={WEEK}
          data={sampleWeek}
          today={SAMPLE_TODAY}
          nowMs={DISCOVERY_NOW}
          hourHeight={56}
          onOpenAppointment={() => onIntent("ouvrir ce rendez-vous")}
          onOpenBlock={() => onIntent("ouvrir ce créneau")}
          onCreateAt={() => onIntent("ajouter un rendez-vous")}
        />
      </div>
    </div>
  );
}
