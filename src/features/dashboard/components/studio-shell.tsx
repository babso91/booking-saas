"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import {
  CalendarSyncIcon,
  ChevronRightIcon,
  ClockIcon,
  GiftIcon,
  PaletteIcon,
  SparkIcon,
} from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";

import type { DashboardSection } from "../sections";
import { initialsOf, sectionHref } from "../sections";

// The Studio frame of the professional area: her name as a wordmark on top,
// a dock floating at the bottom within thumb reach, the rest of her area in
// one sheet. Same rooms and same words as the Classique frame, only set
// differently: switching style never loses her.

type Business = { name: string; slug: string };

const dock: { section: DashboardSection; label: string; wide?: boolean }[] = [
  { section: "today", label: "Aujourd’hui" },
  { section: "agenda", label: "Agenda" },
  { section: "clients", label: "Clientes" },
  { section: "services", label: "Prestations", wide: true },
  { section: "loyalty", label: "Fidélité", wide: true },
];

const more: {
  section: DashboardSection;
  label: string;
  icon: typeof GiftIcon;
  phoneOnly?: boolean;
}[] = [
  // In the dock from md; on a phone, here.
  {
    section: "services",
    label: "Prestations",
    icon: SparkIcon,
    phoneOnly: true,
  },
  { section: "loyalty", label: "Fidélité", icon: GiftIcon, phoneOnly: true },
  { section: "hours", label: "Horaires", icon: ClockIcon },
  { section: "calendar", label: "Google Calendar", icon: CalendarSyncIcon },
  { section: "appearance", label: "Apparence", icon: PaletteIcon },
];

export function StudioShell({
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
    <div className="flex h-dvh flex-col overflow-hidden bg-paper">
      <header className="flex shrink-0 items-center justify-between gap-4 px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-3 lg:px-10 lg:pt-5">
        <Link
          href={sectionHref.today}
          className="font-expanded min-w-0 truncate text-[17px] font-black tracking-tight text-ink uppercase lg:text-[19px]"
        >
          {business.name}
          <span className="text-accent">.</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${business.name} : réglages et compte`}
          aria-current={inMore ? "page" : undefined}
          className="font-expanded grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-ink text-[13px] font-extrabold text-paper focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-accent"
        >
          {initialsOf(business.name)}
        </button>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+84px)]">
        {children}
      </main>

      <nav
        aria-label="Navigation principale"
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+12px)] left-1/2 z-30 flex max-w-[calc(100vw-20px)] -translate-x-1/2 items-center gap-0.5 rounded-full bg-ink p-1.5 shadow-[0_18px_40px_-12px_rgb(var(--shadow-rgb)/0.55)]"
      >
        {dock.map((item) => (
          <Link
            key={item.section}
            href={sectionHref[item.section]}
            aria-current={current === item.section ? "page" : undefined}
            className={cn(
              "h-11 items-center rounded-full px-2.5 text-[14px] font-bold whitespace-nowrap transition-colors min-[360px]:px-3.5 min-[360px]:text-[14.5px] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-paper sm:px-4",
              item.wide ? "hidden md:flex" : "flex",
              current === item.section
                ? "bg-paper text-ink"
                : "text-paper/75 hover:text-paper",
            )}
          >
            {item.label}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-11 cursor-pointer items-center rounded-full px-2.5 text-[14px] font-bold min-[360px]:px-3.5 min-[360px]:text-[14.5px] whitespace-nowrap text-paper/75 hover:text-paper focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-paper md:hidden"
        >
          Plus
        </button>
      </nav>

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
                "min-h-14 items-center gap-3 rounded-2xl border border-line bg-paper px-4 text-[15px] font-semibold text-ink transition-colors hover:border-line-strong",
                item.phoneOnly ? "flex md:hidden" : "flex",
              )}
            >
              <item.icon size={20} className="text-ink-soft" />
              <span className="flex-1">{item.label}</span>
              <ChevronRightIcon size={18} className="text-ink-muted" />
            </Link>
          ))}
          <p className="mt-2 flex flex-col gap-1 text-[13px] text-ink-muted">
            <span className="flex items-center gap-2">
              Ta page de réservation
              <span className="rounded-full bg-sand px-2 py-0.5 text-[11px] font-medium text-ink-soft">
                Bientôt
              </span>
            </span>
            <span className="break-all text-ink-soft">
              {bookingHost()}/b/{business.slug}
            </span>
          </p>
          <SignOutButton />
        </div>
      </Sheet>
    </div>
  );
}
