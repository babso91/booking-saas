import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { studio, today } from "../data";
import styles from "./carnet.module.css";

const BASE = "/apercu/directions/carnet";

type Section = "jour" | "semaine" | "clientes" | "prestations" | "caisse";

const tabs: { id: Section; label: string; href: Route }[] = [
  { id: "jour", label: "Jour", href: BASE },
  { id: "semaine", label: "Semaine", href: `${BASE}/agenda` },
  { id: "clientes", label: "Clientes", href: BASE },
  { id: "prestations", label: "Prestations", href: BASE },
  { id: "caisse", label: "Caisse", href: BASE },
];

/** The page itself: running head, index tabs on its edge, ribbon on phones. */
export function CarnetSheet({
  current,
  children,
}: {
  current: Section;
  children: ReactNode;
}) {
  return (
    <div className={styles.desk}>
      <main className={styles.sheet}>
        <header className={styles.head}>
          <span className={styles.studio}>{studio.name}</span>
          <span className={styles.headRight}>
            <span className={`${styles.label} ${styles.folio}`}>
              Sem. 44 · p. {dayOfYear()}
            </span>
            <a href="#nouveau" className={styles.new}>
              <span aria-hidden="true">+</span>
              <span className={styles.newLong}>Noter un rendez-vous</span>
              <span className={styles.newShort}>Noter</span>
            </a>
          </span>
        </header>
        {children}
        <nav aria-label="Carnet" className={styles.tabs}>
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={tab.href}
              className={styles.tab}
              aria-current={tab.id === current ? "page" : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </main>
      <nav aria-label="Carnet" className={styles.ribbon}>
        {tabs.slice(0, 4).map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={tab.id === current ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function dayOfYear() {
  const date = new Date(`${today.iso}T12:00:00Z`);
  const start = new Date(`${today.year}-01-01T12:00:00Z`);
  return Math.round((date.getTime() - start.getTime()) / 86_400_000) + 1;
}
