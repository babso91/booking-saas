import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { studio } from "../data";
import styles from "./studio.module.css";

const BASE = "/apercu/directions/studio";

type Section = "jour" | "agenda" | "clientes" | "prestations" | "caisse";

const links: { id: Section; label: string; href: Route; more?: boolean }[] = [
  { id: "jour", label: "Aujourd’hui", href: BASE },
  { id: "agenda", label: "Agenda", href: `${BASE}/agenda` },
  { id: "clientes", label: "Clientes", href: BASE },
  { id: "prestations", label: "Prestations", href: BASE, more: true },
  { id: "caisse", label: "Caisse", href: BASE, more: true },
];

/** Wordmark and search on top, a floating dock at the bottom. */
export function StudioFrame({
  current,
  children,
}: {
  current: Section;
  children: ReactNode;
}) {
  return (
    <>
      <header className={styles.bar}>
        <span className={styles.wordmark}>
          {studio.owner}
          <i>.</i>
        </span>
        <span className={styles.search} role="search">
          Chercher une cliente, une date, une prestation
          <kbd>⌘ K</kbd>
        </span>
        <span className={styles.me} aria-label={`Compte de ${studio.owner}`}>
          {studio.monogram}
        </span>
      </header>
      <main>{children}</main>
      <nav className={styles.dock} aria-label="Studio">
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
        <a
          href="#nouveau"
          className={styles.plus}
          aria-label="Nouveau rendez-vous"
        >
          +
        </a>
      </nav>
    </>
  );
}
