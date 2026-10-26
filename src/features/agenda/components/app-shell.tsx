"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { BrandMark } from "@/components/shared/brand-mark";
import {
  CalendarIcon,
  CalendarSyncIcon,
  ChevronRightIcon,
  ClockIcon,
  GiftIcon,
  PaletteIcon,
  SparkIcon,
  UserIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";

type Business = { name: string; slug: string };
type Section =
  | "agenda"
  | "clients"
  | "services"
  | "loyalty"
  | "hours"
  | "calendar"
  | "appearance";

const CALENDAR_SETTINGS = "/app/settings/calendar";
const CLIENTS = "/app/clients";
const SERVICES = "/app/services";
const HOURS = "/app/settings/hours";
const LOYALTY = "/app/loyalty";
const APPEARANCE = "/app/settings/appearance";

/**
 * Professional area frame. Desktop: compact sidebar. Phones and tablets: a
 * top bar and a bottom tab bar within thumb reach (not a squeezed sidebar).
 */
export function AppShell({
  business,
  current = "agenda",
  children,
}: {
  business: Business;
  /** The section on screen (aria-current and highlight). */
  current?: Section;
  children: ReactNode;
}) {
  const item = (section: Section) =>
    cn(
      "flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors",
      current === section
        ? "bg-ink text-paper-raised"
        : "text-ink-soft hover:bg-sand hover:text-ink",
    );

  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-paper lg:flex-row">
      <aside
        className="hidden w-60 shrink-0 flex-col gap-8 border-r border-line bg-paper-raised px-4 py-6 lg:flex"
        aria-label="Navigation principale"
      >
        <BrandMark className="px-2" />
        <nav className="flex flex-col gap-1">
          <Link
            href="/app"
            aria-current={current === "agenda" ? "page" : undefined}
            className={item("agenda")}
          >
            <CalendarIcon size={18} /> Agenda
          </Link>
          <Link
            href={CLIENTS}
            aria-current={current === "clients" ? "page" : undefined}
            className={item("clients")}
          >
            <UsersIcon size={18} /> Clientes
          </Link>
          <Link
            href={SERVICES}
            aria-current={current === "services" ? "page" : undefined}
            className={item("services")}
          >
            <SparkIcon size={18} /> Prestations
          </Link>
          <Link
            href={LOYALTY}
            aria-current={current === "loyalty" ? "page" : undefined}
            className={item("loyalty")}
          >
            <GiftIcon size={18} /> Fidélité
          </Link>
          <Link
            href={HOURS}
            aria-current={current === "hours" ? "page" : undefined}
            className={item("hours")}
          >
            <ClockIcon size={18} /> Horaires
          </Link>
          <Link
            href={CALENDAR_SETTINGS}
            aria-current={current === "calendar" ? "page" : undefined}
            className={item("calendar")}
          >
            <CalendarSyncIcon size={18} /> Google Calendar
          </Link>
          <Link
            href={APPEARANCE}
            aria-current={current === "appearance" ? "page" : undefined}
            className={item("appearance")}
          >
            <PaletteIcon size={18} /> Apparence
          </Link>
        </nav>
        <div className="mt-auto flex flex-col gap-3 rounded-2xl border border-line bg-paper p-4">
          <p className="truncate font-display text-[20px] leading-tight text-ink">
            {business.name}
          </p>
          <PublicLink slug={business.slug} />
          <SignOutButton />
        </div>
      </aside>

      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-paper-raised px-4 pt-[env(safe-area-inset-top)] lg:hidden">
        <BrandMark />
        <span className="max-w-[45%] truncate text-[14px] text-ink-soft">
          {business.name}
        </span>
      </header>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</main>

      <nav
        aria-label="Navigation principale"
        className="grid shrink-0 grid-cols-4 border-t border-line bg-paper-raised pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <Link
          href="/app"
          aria-current={current === "agenda" ? "page" : undefined}
          className={cn(
            "flex h-16 flex-col items-center justify-center gap-1 text-[11.5px]",
            current === "agenda" ? "font-semibold text-ink" : "text-ink-soft",
          )}
        >
          <CalendarIcon size={21} /> Agenda
        </Link>
        <Link
          href={CLIENTS}
          aria-current={current === "clients" ? "page" : undefined}
          className={cn(
            "flex h-16 flex-col items-center justify-center gap-1 text-[11.5px]",
            current === "clients" ? "font-semibold text-ink" : "text-ink-soft",
          )}
        >
          <UsersIcon size={21} /> Clientes
        </Link>
        <Link
          href={SERVICES}
          aria-current={current === "services" ? "page" : undefined}
          className={cn(
            "flex h-16 flex-col items-center justify-center gap-1 text-[11.5px]",
            current === "services" ? "font-semibold text-ink" : "text-ink-soft",
          )}
        >
          <SparkIcon size={21} /> Prestations
        </Link>
        <button
          type="button"
          onClick={() => setAccountOpen(true)}
          className={cn(
            "flex h-16 cursor-pointer flex-col items-center justify-center gap-1 text-[11.5px]",
            current === "calendar" ||
              current === "hours" ||
              current === "loyalty" ||
              current === "appearance"
              ? "font-semibold text-ink"
              : "text-ink-soft",
          )}
        >
          <UserIcon size={21} /> Compte
        </button>
      </nav>

      <Sheet
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        title={business.name}
        description="Ton espace professionnel"
      >
        <div className="flex flex-col gap-4">
          <Link
            href={LOYALTY}
            onClick={() => setAccountOpen(false)}
            aria-current={current === "loyalty" ? "page" : undefined}
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-paper px-4 text-[15px] font-medium text-ink transition-colors hover:border-line-strong"
          >
            <GiftIcon size={20} className="text-ink-soft" />
            <span className="flex-1">Fidélité</span>
            <ChevronRightIcon size={18} className="text-ink-muted" />
          </Link>
          <Link
            href={HOURS}
            onClick={() => setAccountOpen(false)}
            aria-current={current === "hours" ? "page" : undefined}
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-paper px-4 text-[15px] font-medium text-ink transition-colors hover:border-line-strong"
          >
            <ClockIcon size={20} className="text-ink-soft" />
            <span className="flex-1">Horaires</span>
            <ChevronRightIcon size={18} className="text-ink-muted" />
          </Link>
          <Link
            href={CALENDAR_SETTINGS}
            onClick={() => setAccountOpen(false)}
            aria-current={current === "calendar" ? "page" : undefined}
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-paper px-4 text-[15px] font-medium text-ink transition-colors hover:border-line-strong"
          >
            <CalendarSyncIcon size={20} className="text-ink-soft" />
            <span className="flex-1">Google Calendar</span>
            <ChevronRightIcon size={18} className="text-ink-muted" />
          </Link>
          <Link
            href={APPEARANCE}
            onClick={() => setAccountOpen(false)}
            aria-current={current === "appearance" ? "page" : undefined}
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-paper px-4 text-[15px] font-medium text-ink transition-colors hover:border-line-strong"
          >
            <PaletteIcon size={20} className="text-ink-soft" />
            <span className="flex-1">Apparence</span>
            <ChevronRightIcon size={18} className="text-ink-muted" />
          </Link>
          <PublicLink slug={business.slug} />
          <SignOutButton />
        </div>
      </Sheet>
    </div>
  );
}

/**
 * The address of the future booking page. Online booking is not available
 * yet, so it is shown as such, not as a link to a page that cannot book.
 */
function PublicLink({ slug }: { slug: string }) {
  return (
    <p className="flex flex-col gap-1 text-[13px] text-ink-muted">
      <span className="flex items-center gap-2">
        Ta page de réservation
        <span className="rounded-full bg-sand px-2 py-0.5 text-[11px] font-medium text-ink-soft">
          Bientôt
        </span>
      </span>
      <span className="break-all text-ink-soft">
        {bookingHost()}/b/{slug}
      </span>
    </p>
  );
}
