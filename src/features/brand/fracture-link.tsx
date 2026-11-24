"use client";

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

import type { Fracture } from "./fracture";
import styles from "./fracture.module.css";

// A link that breaks the page (brand direction « Fracture écarlate »):
// held (hover or focus), the page freezes and cracks from the link, and
// heals when let go; followed, it bursts into shards flying in depth and
// the next page shows behind them before it is reached. The page is
// captured as it is at that moment. Without WebGL, with reduced motion,
// or if anything fails, it is a plain link.

type Run = {
  engine?: Fracture;
  overlay?: HTMLDivElement;
  frame?: HTMLIFrameElement;
  invert?: HTMLDivElement;
  preparing?: Promise<boolean>;
  holding: boolean;
  bursting: boolean;
};

const capable = () =>
  !matchMedia("(prefers-reduced-motion: reduce)").matches &&
  Boolean(document.createElement("canvas").getContext("webgl2"));

export function FractureLink({
  href,
  className,
  children,
}: {
  href: Route;
  className?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const link = useRef<HTMLAnchorElement>(null);
  const run = useRef<Run>({ holding: false, bursting: false });

  const release = () => {
    const current = run.current;
    current.engine?.dispose();
    current.overlay?.remove();
    const main = link.current?.closest("main");
    if (main) delete main.dataset.fracture;
    run.current = { holding: false, bursting: false };
  };

  useEffect(() => release, []);

  // Once the page rests, the fracture's code is fetched ahead, so that a
  // hover cracks the page without waiting for it.
  useEffect(() => {
    if (!capable()) return;
    const warm = () => {
      void import("modern-screenshot");
      void import("./fracture");
    };
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(warm, { timeout: 4000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 2500);
    return () => clearTimeout(id);
  }, []);

  const prepare = () => {
    const current = run.current;
    if (current.engine) return Promise.resolve(true);
    if (current.preparing) return current.preparing;
    current.preparing = (async () => {
      const anchor = link.current;
      const main = anchor?.closest("main");
      if (!anchor || !main) return false;
      try {
        // Time stops: the page holds still while it is captured.
        main.dataset.fracture = "held";
        const [{ domToCanvas }, { Fracture }] = await Promise.all([
          import("modern-screenshot"),
          import("./fracture"),
        ]);
        const page = await domToCanvas(main, {
          width: innerWidth,
          height: innerHeight,
          scale: Math.min(devicePixelRatio, 2),
        });
        if (run.current !== current) return false;
        const overlay = document.createElement("div");
        overlay.className = styles.overlay ?? "";
        overlay.setAttribute("aria-hidden", "true");
        const frame = document.createElement("iframe");
        frame.className = styles.behind ?? "";
        frame.tabIndex = -1;
        frame.title = "";
        frame.addEventListener("load", () =>
          frame.classList.add(styles.loaded!),
        );
        frame.src = href;
        const canvas = document.createElement("canvas");
        canvas.className = styles.canvas ?? "";
        const invert = document.createElement("div");
        invert.className = styles.invert ?? "";
        overlay.append(frame, canvas, invert);
        document.body.append(overlay);
        const box = anchor.getBoundingClientRect();
        current.engine = new Fracture(canvas, page, {
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        });
        Object.assign(current, { overlay, frame, invert });
        return true;
      } catch {
        release();
        return false;
      }
    })();
    return current.preparing;
  };

  const hold = async () => {
    if (!capable()) return;
    run.current.holding = true;
    if ((await prepare()) && run.current.holding && !run.current.bursting)
      void run.current.engine!.crack(1);
  };

  const letGo = async () => {
    const current = run.current;
    current.holding = false;
    if (!current.engine || current.bursting) {
      if (!current.engine && !current.bursting && current.preparing) {
        await current.preparing;
        if (!run.current.holding && !run.current.bursting) release();
      }
      return;
    }
    await current.engine.crack(0);
    if (run.current === current && !current.holding && !current.bursting)
      release();
  };

  const burst = async () => {
    const current = run.current;
    current.bursting = true;
    const ready = await Promise.race([
      prepare(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500)),
    ]);
    if (!ready || !current.engine) {
      router.push(href);
      return;
    }
    current.engine.explode({
      invert: current.invert!,
      onReveal: () => current.frame!.classList.add(styles.shown!),
      onDone: () => router.push(href),
    });
  };

  return (
    <Link
      ref={link}
      href={href}
      className={className}
      onPointerEnter={() => void hold()}
      onPointerLeave={() => void letGo()}
      onFocus={() => void hold()}
      onBlur={() => void letGo()}
      onClick={(event) => {
        if (
          run.current.bursting ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          !capable()
        )
          return;
        event.preventDefault();
        void burst();
      }}
    >
      {children}
    </Link>
  );
}
