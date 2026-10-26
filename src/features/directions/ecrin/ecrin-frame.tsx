import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { studio, today } from "../data";
import styles from "./ecrin.module.css";

const BASE = "/apercu/directions/ecrin";

type Section = "jour" | "agenda" | "clientes" | "prestations" | "caisse";

const links: { id: Section; label: string; href: Route; more?: boolean }[] = [
  { id: "jour", label: "Jour", href: BASE },
  { id: "agenda", label: "Agenda", href: `${BASE}/agenda` },
  { id: "clientes", label: "Clientes", href: BASE },
  { id: "prestations", label: "Prestations", href: BASE, more: true },
  { id: "caisse", label: "Caisse", href: BASE, more: true },
];

/** Her monogram, the date engraved, and one capsule to move between rooms. */
export function EcrinFrame({
  current,
  children,
}: {
  current: Section;
  children: ReactNode;
}) {
  return (
    <>
      <header className={styles.top}>
        <a
          href="#compte"
          className={`${styles.monogram} ${styles.object}`}
          aria-label={`${studio.name}, ton compte`}
        >
          {studio.monogram}
        </a>
        <p className={styles.date}>
          <b>
            {today.weekday} {today.day}
          </b>
          <span>
            {today.month} {today.year}
          </span>
        </p>
        <a
          href="#nouveau"
          className={`${styles.add} ${styles.object}`}
          aria-label="Nouveau rendez-vous"
        >
          +
        </a>
      </header>
      <main>{children}</main>
      <nav className={`${styles.nav} ${styles.object}`} aria-label="Écrin">
        {links.map((link) => (
          <Link
            key={link.id}
            href={link.href}
            className={link.more ? styles.more : undefined}
            aria-current={link.id === current ? "page" : undefined}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
