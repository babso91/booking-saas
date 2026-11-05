"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { BookingHost } from "@/components/shared/booking-host";
import {
  CalendarIcon,
  CalendarSyncIcon,
  ChevronRightIcon,
  ClockIcon,
  GiftIcon,
  GlobeIcon,
  PaletteIcon,
  SparkIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { cn } from "@/lib/cn";

import type { DashboardSection } from "../sections";
import { initialsOf, sectionHref } from "../sections";

// The Écrin frame: her monogram, engraved, and one capsule to move between
// rooms — at the top on a computer, under the thumb on a phone, with an
// icon above each word. Same rooms, same words as the other styles.

type Business = { name: string; slug: string };

/** A small dial, the icon of "Aujourd’hui". */
function DialIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 18.4a8.5 8.5 0 1 1 12 0" />
      <path d="M12 12.5 15.5 8" />
    </svg>
  );
}

const rooms: {
  section: DashboardSection;
  label: string;
  icon: (props: { size?: number }) => ReactNode;
  wide?: boolean;
}[] = [
  { section: "today", label: "Aujourd’hui", icon: DialIcon },
  { section: "agenda", label: "Agenda", icon: CalendarIcon },
  { section: "clients", label: "Clientes", icon: UsersIcon },
  { section: "services", label: "Prestations", icon: SparkIcon, wide: true },
  { section: "loyalty", label: "Fidélité", icon: GiftIcon, wide: true },
];

const more: {
  section: DashboardSection;
  label: string;
  icon: typeof GiftIcon;
  phoneOnly?: boolean;
}[] = [
  // In the capsule from md; on a phone, here.
  {
    section: "services",
    label: "Prestations",
    icon: SparkIcon,
    phoneOnly: true,
  },
  { section: "loyalty", label: "Fidélité", icon: GiftIcon, phoneOnly: true },
  { section: "hours", label: "Horaires", icon: ClockIcon },
  { section: "calendar", label: "Google Calendar", icon: CalendarSyncIcon },
  { section: "site", label: "Mon site", icon: GlobeIcon },
  { section: "appearance", label: "Apparence", icon: PaletteIcon },
];

export function EcrinShell({
  business,
  current,
  children,
}: {
  business: Business;
  current: DashboardSection;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const inMore = more.some(
    (item) => item.section === current && !item.phoneOnly,
  );

  return (
    <div className="ecrin-ground flex h-dvh flex-col overflow-hidden text-ink">
      <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 pt-[calc(env(safe-area-inset-top)+10px)] pb-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:px-8 md:pt-5 md:pb-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`${initialsOf(business.name)}, ${business.name} : réglages et compte`}
            aria-current={inMore ? "page" : undefined}
            className="ecrin-object ecrin-press font-engraved grid size-11 shrink-0 cursor-pointer place-items-center rounded-full pl-[0.1em] text-[15px] tracking-[0.1em] text-ink focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent"
          >
            {initialsOf(business.name)}
          </button>
          <Link
            href={sectionHref.today}
            className="font-engraved truncate text-[16px] tracking-[0.06em] text-ink"
          >
            {business.name}
          </Link>
        </div>

        <nav
          aria-label="Navigation principale"
          className="ecrin-object fixed bottom-[calc(env(safe-area-inset-bottom)+10px)] left-1/2 z-30 flex w-[calc(100vw-20px)] max-w-[420px] -translate-x-1/2 items-stretch gap-0.5 rounded-[26px] p-1.5 md:static md:w-auto md:max-w-none md:translate-x-0 md:rounded-full"
        >
          {rooms.map((room) => (
            <Link
              key={room.section}
              href={sectionHref[room.section]}
              aria-current={current === room.section ? "page" : undefined}
              className={cn(
                "min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[20px] py-1.5 text-[11.5px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent md:flex-row md:gap-2 md:rounded-full md:px-4 md:py-2 md:text-[14px]",
                room.wide ? "hidden md:flex" : "flex",
                current === room.section &&
                  "bg-accent-soft font-medium text-accent-strong hover:text-accent-strong",
              )}
            >
              <span className="md:hidden">
                <room.icon size={21} />
              </span>
              {room.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-[20px] py-1.5 text-[11.5px] text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent md:hidden"
          >
            <span
              aria-hidden="true"
              className="text-[18px] leading-[21px] font-medium"
            >
              ⋯
            </span>
            Plus
          </button>
        </nav>

        <div className="hidden justify-end md:flex">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="h-11 cursor-pointer rounded-full px-4 text-[14px] text-ink-soft transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Réglages
          </button>
        </div>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+84px)] md:pb-0">
        {children}
      </main>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={business.name}
        description="Ton espace professionnel"
      >
        <div className="flex flex-col gap-3">
          {more.map((item) => (
            <Link
              key={item.section}
              href={sectionHref[item.section]}
              onClick={() => setOpen(false)}
              aria-current={current === item.section ? "page" : undefined}
              className={cn(
                "ecrin-object ecrin-press min-h-14 items-center gap-3 rounded-[20px] px-4 text-[15px] text-ink",
                item.phoneOnly ? "flex md:hidden" : "flex",
              )}
            >
              <item.icon size={20} className="text-ink-soft" />
              <span className="flex-1">{item.label}</span>
              <ChevronRightIcon size={18} className="text-ink-soft" />
            </Link>
          ))}
          <p className="mt-2 flex flex-col gap-1 text-[13px] text-ink-soft">
            <span className="flex items-center gap-2">
              Ta page de réservation
              <span className="rounded-full bg-sand px-2 py-0.5 text-[11px] text-ink-soft">
                Bientôt
              </span>
            </span>
            <span className="break-all">
              <BookingHost />
              /b/{business.slug}
            </span>
          </p>
          <SignOutButton />
        </div>
      </Sheet>
    </div>
  );
}
