"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useEngine } from "./engine";
import { cssVariables } from "./tokens";

// The site's modal surfaces (booking, full-screen photo) share one
// behaviour: rendered on <body>, above every layer of the page and of the
// studio, with the site's tokens AND the font faces its tokens point to
// (they live on the lab's root, which a portal leaves); the rest of the
// page inert, its scroll locked; focus moved in, kept in, given back.

/** The faces declared on the lab's root (app/(labo)/labo/layout.tsx). */
const FACES = [
  "--font-mila-display",
  "--font-mila-body",
  "--font-mila-mono",
  "--font-alma-display",
  "--font-alma-body",
  "--font-nail-display",
  "--font-nail-body",
  "--font-nail-mono",
  "--font-lab-sans",
];

function faces(): Record<string, string> {
  const root = document.querySelector("[data-lab-fonts]");
  if (!root) return {};
  const style = getComputedStyle(root);
  return Object.fromEntries(
    FACES.map((name) => [name, style.getPropertyValue(name)]).filter(
      ([, value]) => value,
    ),
  );
}

/** Above the studio (z 70) and its launcher: a modal is always on top. */
export const MODAL_LAYER = "z-[90]";

export function SitePortal({
  children,
  rootRef,
}: {
  children: ReactNode;
  rootRef?: RefObject<HTMLDivElement | null>;
}) {
  const { config } = useEngine();
  // Read once, when it opens (client only: a modal opens on a gesture).
  const [fonts] = useState(faces);
  return createPortal(
    <div
      ref={rootRef}
      lang="fr"
      className={`relative ${MODAL_LAYER}`}
      style={{
        ...fonts,
        ...cssVariables(config.tokens),
        fontFamily: "var(--t-body)",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal's behaviour, from mount to unmount. `root` is the portal's
 * element (everything else on <body> becomes inert), `panel` the dialog
 * (focus starts there, or on `initial`, and Tab stays inside).
 */
export function useModal({
  root,
  panel,
  initial,
  onClose,
}: {
  root: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLElement | null>;
  initial?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (initial?.current ?? panel.current)?.focus({ preventScroll: true });

    const madeInert = [...document.body.children].filter(
      (element) => element !== root.current && !element.hasAttribute("inert"),
    );
    madeInert.forEach((element) => element.setAttribute("inert", ""));
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
        return;
      }
      const box = panel.current;
      if (event.key !== "Tab" || !box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => item.offsetParent !== null || item === document.activeElement,
      );
      if (!items.length) {
        event.preventDefault();
        box.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const outside = !box.contains(active) || active === box;
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      madeInert.forEach((element) => element.removeAttribute("inert"));
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initial, panel, root]);
}
