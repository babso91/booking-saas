"use client";

import { useMemo, useState } from "react";

import { Sheet } from "@/components/ui/sheet";
import { shiftAnchor, visibleRange } from "@/features/agenda/client/dates";
import { restrictToDays } from "@/features/agenda/client/layout";
import { zoneOf } from "@/features/agenda/client/zone";
import { AppointmentDetails } from "@/features/agenda/components/appointment-details";
import type {
  AgendaAppointmentDto,
  AgendaDto,
} from "@/features/agenda/data/agenda";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { addDaysToLocalDate } from "@/lib/time/local-date";

import { StudioAgenda, type StudioView } from "./studio-agenda";

// Preview only (/apercu): the real Studio agenda components and the real
// appointment card, on a fictional week, without a database. Navigation and
// views work; reading and writing are the agenda's (AgendaView), not here:
// creating, blocking and the card's actions only say what they would open.

export function StudioAgendaPreview({
  week,
  date,
  now,
  initialView,
}: {
  week: AgendaDto;
  date: string;
  now: number;
  initialView: StudioView;
}) {
  const wide = useMediaQuery("(min-width: 768px)") ?? true;
  const [view, setView] = useState<StudioView>(initialView);
  const [anchor, setAnchor] = useState(date);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [open, setOpen] = useState<AgendaAppointmentDto | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const shown: StudioView = wide ? view : "day";
  const { days } = visibleRange(shown, anchor);
  const data = useMemo(() => {
    const restricted = restrictToDays(week, days);
    return includeCancelled
      ? restricted
      : {
          ...restricted,
          appointments: restricted.appointments.filter(
            (appointment) => appointment.status !== "cancelled",
          ),
        };
  }, [week, days, includeCancelled]);
  const zone = useMemo(() => zoneOf(week), [week]);

  return (
    <StudioAgenda
      view={shown}
      wide={wide}
      onView={setView}
      days={days}
      anchor={anchor}
      today={week.today}
      data={
        days.some((day) => week.workingHours.days.some((d) => d.date === day))
          ? data
          : null
      }
      nowMs={now}
      loading={false}
      includeCancelled={includeCancelled}
      onIncludeCancelled={setIncludeCancelled}
      onShift={(direction) =>
        setAnchor(
          direction === 7 || direction === -7
            ? addDaysToLocalDate(anchor, direction)
            : shiftAnchor(shown, anchor, direction),
        )
      }
      onToday={() => setAnchor(week.today)}
      onSelectDay={setAnchor}
      onNewAppointment={() => setSaid("Nouveau rendez-vous")}
      onNewBlock={() => setSaid("Bloquer un créneau")}
      onOpenAppointment={setOpen}
      onOpenBlock={(block) => setSaid(`Créneau bloqué : ${block.reason ?? ""}`)}
      onCreateAt={(day, time) =>
        setSaid(`Nouveau rendez-vous le ${day} à ${time}`)
      }
      banners={
        said ? (
          <p
            role="status"
            className="mx-4 mb-2 rounded-2xl bg-sand px-4 py-2.5 text-[14px] text-ink lg:mx-10"
          >
            Aperçu : ouvrirait « {said} » (le formulaire réel de l’agenda).{" "}
            <button
              type="button"
              className="font-bold underline"
              onClick={() => setSaid(null)}
            >
              OK
            </button>
          </p>
        ) : null
      }
      panels={
        <Sheet
          open={open !== null}
          onClose={() => setOpen(null)}
          title="Rendez-vous"
        >
          {open ? (
            <AppointmentDetails
              appointment={open}
              zone={zone}
              onEdit={() => setSaid("Modifier le rendez-vous")}
              onUpdated={() => setOpen(null)}
              onRefresh={async () => null}
            />
          ) : null}
        </Sheet>
      }
    />
  );
}
