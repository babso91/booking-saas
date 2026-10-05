"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { BrandMark } from "@/components/shared/brand-mark";
import {
  CalendarIcon,
  CalendarSyncIcon,
  ChevronRightIcon,
  ExternalIcon,
  GiftIcon,
  UserIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import { SignOutButton } from "@/features/auth/components/sign-out-button";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";

type Business = { name: string; slug: string };
type Section = "agenda" | "calendar";

const CALENDAR_SETTINGS = "/app/settings/calendar";

// Only destinations that exist are links. Upcoming sections are shown as
// such, without fake pages.
const upcoming = [
  { label: "Clientes", icon: UsersIcon },
  { label: "Fidélité", icon: GiftIcon },
];

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
            href={CALENDAR_SETTINGS}
            aria-current={current === "calendar" ? "page" : undefined}
            className={item("calendar")}
          >
            <CalendarSyncIcon size={18} /> Google Calendar
          </Link>
          {upcoming.map(({ label, icon: Icon }) => (
            <span
              key={label}
              aria-disabled="true"
              className="flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] text-ink-muted"
            >
              <Icon size={18} /> {label}
              <span className="ml-auto rounded-full bg-sand px-2 py-0.5 text-[11px] font-medium text-ink-soft">
                Bientôt
              </span>
            </span>
          ))}
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
        {upcoming.map(({ label, icon: Icon }) => (
          <span
            key={label}
            aria-disabled="true"
            className="flex h-16 cursor-default flex-col items-center justify-center gap-0.5 text-[11.5px] text-ink-muted/70"
          >
            <Icon size={20} className="opacity-70" />
            <span>{label}</span>
            <span className="rounded-full bg-sand px-1.5 text-[9.5px] leading-[1.35] font-medium text-ink-soft">
              Bientôt
            </span>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setAccountOpen(true)}
          className={cn(
            "flex h-16 cursor-pointer flex-col items-center justify-center gap-1 text-[11.5px]",
            current === "calendar" ? "font-semibold text-ink" : "text-ink-soft",
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
            href={CALENDAR_SETTINGS}
            onClick={() => setAccountOpen(false)}
            aria-current={current === "calendar" ? "page" : undefined}
            className="flex min-h-14 items-center gap-3 rounded-2xl border border-line bg-paper px-4 text-[15px] font-medium text-ink transition-colors hover:border-line-strong"
          >
            <CalendarSyncIcon size={20} className="text-ink-soft" />
            <span className="flex-1">Google Calendar</span>
            <ChevronRightIcon size={18} className="text-ink-muted" />
          </Link>
          <PublicLink slug={business.slug} />
          <p className="text-[14px] text-ink-muted">
            Clientes et fidélité arrivent bientôt dans ton espace.
          </p>
          <SignOutButton />
        </div>
      </Sheet>
    </div>
  );
}

function PublicLink({ slug }: { slug: string }) {
  return (
    <a
      href={`/b/${slug}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-[13.5px] break-all text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
    >
      <ExternalIcon size={15} className="shrink-0" />
      {bookingHost()}/b/{slug}
      <span className="sr-only">
        {" "}
        (ouvre ta page publique dans un nouvel onglet)
      </span>
    </a>
  );
}
