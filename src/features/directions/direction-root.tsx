"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";

import styles from "./direction-root.module.css";

// The root of an art-direction prototype: carries the palette and the mode
// the reviewer picked (data-palette, data-mode), and a small control panel
// that is visibly not part of the design. Kept per direction on this device.

const EVENT = "apercu-change";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): { palette?: string; mode?: string } {
  try {
    return JSON.parse(raw ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export type PaletteChoice = { id: string; name: string; swatch: string };

export function DirectionRoot({
  direction,
  palettes,
  className,
  children,
}: {
  direction: string;
  palettes: PaletteChoice[];
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const key = `apercu:${direction}`;
  const raw = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
  const saved = parse(raw);
  const palette = palettes.some((p) => p.id === saved.palette)
    ? saved.palette!
    : palettes[0]!.id;
  const mode = saved.mode === "dark" ? "dark" : "light";
  const save = (next: { palette: string; mode: "light" | "dark" }) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
    window.dispatchEvent(new Event(EVENT));
  };
  const setPalette = (id: string) => save({ palette: id, mode });
  const setMode = (m: "light" | "dark") => save({ palette, mode: m });

  return (
    <div
      data-palette={palette}
      data-mode={mode}
      className={className}
      style={{ colorScheme: mode }}
    >
      {children}
      <aside className={styles.controls} aria-label="Commandes de l’aperçu">
        {open ? (
          <div className={styles.panel}>
            <p className={styles.title}>Aperçu · personnalisation</p>
            <div className={styles.row}>
              {palettes.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={palette === p.id}
                  className={styles.swatch}
                  onClick={() => setPalette(p.id)}
                >
                  <span style={{ background: p.swatch }} aria-hidden="true" />
                  {p.name}
                </button>
              ))}
            </div>
            <div className={styles.row}>
              {(["light", "dark"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  className={styles.swatch}
                  onClick={() => setMode(m)}
                >
                  {m === "light" ? "Clair" : "Sombre"}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Fermer" : "Aperçu"}
        </button>
      </aside>
    </div>
  );
}
