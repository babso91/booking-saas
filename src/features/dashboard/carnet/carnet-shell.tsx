"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { BookingHost } from "@/components/shared/booking-host";
import { Sheet } from "@/components/ui/sheet";
import { SignOutButton } from "@/features/auth/components/sign-out-button";

import type { DashboardSection } from "../sections";
import { sectionHref } from "../sections";
import styles from "./carnet.module.css";

// The Carnet frame: one sheet of her book on the desk, the pages under it, a
// running head, index tabs on its edge; on a phone, a ribbon of words. Words,
// not icons. Same rooms, same words as the other styles.

type Business = { name: string; slug: string };

const tabs: { section: DashboardSection; label: string }[] = [
  { section: "today", label: "Aujourd’hui" },
  { section: "agenda", label: "Agenda" },
  { section: "clients", label: "Clientes" },
  { section: "services", label: "Prestations" },
  { section: "loyalty", label: "Fidélité" },
];

const ribbon = tabs.slice(0, 3);

const settings: { section: DashboardSection; label: string }[] = [
  { section: "hours", label: "Horaires" },
  { section: "calendar", label: "Google Calendar" },
  { section: "site", label: "Mon site" },
  { section: "appearance", label: "Apparence" },
];

/** A new appointment, from anywhere: the agenda's own form opens there. */
const NOTE_HREF = { pathname: "/app", query: { noter: "1" } } as const;

export function CarnetShell({
  business,
  current,
  children,
}: {
  business: Business;
  current: DashboardSection;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const inSettings = settings.some((item) => item.section === current);
  const inMore = inSettings || current === "services" || current === "loyalty";

  return (
    <div data-carnet-frame="" className={styles.desk}>
      <div className={styles.sheet}>
        <header className={styles.head}>
          <Link href={sectionHref.today} className={styles.studio}>
            {business.name}
          </Link>
          {/* The agenda has its own, where the day or week is known. */}
          {current === "agenda" ? null : (
            <Link href={NOTE_HREF} className={styles.new}>
              <span aria-hidden="true">+</span>
              <span className={styles.newLong}>Noter un rendez-vous</span>
              <span className={styles.newShort}>
                Noter<span className="sr-only"> un rendez-vous</span>
              </span>
            </Link>
          )}
        </header>

        <main className={styles.main}>{children}</main>

        <nav aria-label="Navigation principale" className={styles.tabs}>
          {tabs.map((tab) => (
            <Link
              key={tab.section}
              href={sectionHref[tab.section]}
              className={styles.tab}
              aria-current={current === tab.section ? "page" : undefined}
            >
              {tab.label}
            </Link>
          ))}
          <button
            type="button"
            className={styles.tab}
            aria-current={inSettings ? "page" : undefined}
            onClick={() => setOpen(true)}
          >
            Réglages
          </button>
        </nav>
      </div>

      <nav aria-label="Navigation principale" className={styles.ribbon}>
        {ribbon.map((tab) => (
          <Link
            key={tab.section}
            href={sectionHref[tab.section]}
            aria-current={current === tab.section ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
        <button
          type="button"
          aria-current={inMore ? "page" : undefined}
          onClick={() => setOpen(true)}
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
          <ul className={styles.index}>
            {/* In the tabs on a computer; on a phone, here. */}
            {tabs.slice(3).map((tab) => (
              <li key={tab.section} className={styles.phoneOnly}>
                <Link
                  href={sectionHref[tab.section]}
                  onClick={() => setOpen(false)}
                  aria-current={current === tab.section ? "page" : undefined}
                >
                  {tab.label}
                </Link>
              </li>
            ))}
            {settings.map((item) => (
              <li key={item.section}>
                <Link
                  href={sectionHref[item.section]}
                  onClick={() => setOpen(false)}
                  aria-current={current === item.section ? "page" : undefined}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
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
