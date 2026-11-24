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
// the next page shows behind them: it is reached at once, rendered under
// the shards. The page is captured as it is at that moment, by a capture
// prepared while the page rests (fonts and images already gathered), so
// a hover answers without a lag. Without WebGL, with reduced motion, or
// if anything fails, it is a plain link.

type Run = {
  engine?: Fracture;
  overlay?: HTMLDivElement;
  invert?: HTMLDivElement;
  base?: Still;
  preparing?: Promise<boolean>;
  holding: boolean;
  bursting: boolean;
  showing: boolean;
};

type Still = {
  main: HTMLElement;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  scale: number;
};
let still: Promise<Still> | null = null;

/** The page without what falls, captured once (again if it resized). */
async function stillOf(main: HTMLElement): Promise<Still> {
  const current = still && (await still.catch(() => null));
  if (
    current &&
    current.main === main &&
    current.width === innerWidth &&
    current.height === innerHeight
  )
    return current;
  still = (async () => {
    const { domToCanvas } = await import("modern-screenshot");
    const scale = Math.min(devicePixelRatio, 1.25);
    const canvas = await domToCanvas(main, {
      width: innerWidth,
      height: innerHeight,
      scale,
      filter: (node) =>
        !(node instanceof Element && node.hasAttribute("data-fracture-skip")),
    });
    return { main, canvas, width: innerWidth, height: innerHeight, scale };
  })();
  return still;
}

/** The page now: its still, with every falling petal where it is. */
function pageNow(base: Still) {
  const canvas = document.createElement("canvas");
  canvas.width = base.canvas.width;
  canvas.height = base.canvas.height;
  const g = canvas.getContext("2d")!;
  g.drawImage(base.canvas, 0, 0);
  const rain = base.main.querySelector("[data-fracture-skip]");
  for (const img of rain?.querySelectorAll("img") ?? []) {
    const box = img.getBoundingClientRect();
    if (!box.width || !img.complete) continue;
    // Its turn, its sway and its fall, as one linear transform.
    let m = new DOMMatrix();
    for (
      let el: Element | null = img;
      el && el !== rain;
      el = el.parentElement
    ) {
      const t = getComputedStyle(el).transform;
      if (t && t !== "none") m = new DOMMatrix(t).multiply(m);
    }
    const drop = img.closest<HTMLElement>("[style]");
    g.save();
    g.globalAlpha = Number(drop ? getComputedStyle(drop).opacity : 1);
    const blur = getComputedStyle(img).filter;
    if (blur && blur !== "none") g.filter = blur;
    g.setTransform(
      m.a * base.scale,
      m.b * base.scale,
      m.c * base.scale,
      m.d * base.scale,
      (box.left + box.width / 2) * base.scale,
      (box.top + box.height / 2) * base.scale,
    );
    const w = img.offsetWidth;
    const h = img.offsetHeight;
    g.drawImage(img, -w / 2, -h / 2, w, h);
    g.restore();
  }
  return canvas;
}

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
  const run = useRef<Run>({ holding: false, bursting: false, showing: false });

  const main = () => link.current?.closest("main") ?? null;
  const freeze = () => {
    const page = main();
    if (page) page.dataset.fracture = "held";
  };
  const unfreeze = () => {
    const page = main();
    if (page) delete page.dataset.fracture;
  };
  const teardown = () => {
    const current = run.current;
    current.engine?.dispose();
    current.overlay?.remove();
    run.current = { holding: false, bursting: false, showing: false };
  };

  /** The stage, ready ahead (still page captured, shards on the GPU). */
  const stage = () => {
    const current = run.current;
    const fresh =
      current.base?.width === innerWidth &&
      current.base?.height === innerHeight;
    if (current.engine && fresh) return Promise.resolve(true);
    if (current.preparing) return current.preparing;
    current.preparing = (async () => {
      const anchor = link.current;
      const page = main();
      if (!anchor || !page) return false;
      try {
        const [base, { Fracture }] = await Promise.all([
          stillOf(page),
          import("./fracture"),
        ]);
        if (run.current !== current) return false;
        current.engine?.dispose();
        current.overlay?.remove();
        const overlay = document.createElement("div");
        overlay.className = styles.overlay ?? "";
        overlay.setAttribute("aria-hidden", "true");
        overlay.style.visibility = "hidden";
        const canvas = document.createElement("canvas");
        canvas.className = styles.canvas ?? "";
        const invert = document.createElement("div");
        invert.className = styles.invert ?? "";
        overlay.append(canvas, invert);
        document.body.append(overlay);
        const box = anchor.getBoundingClientRect();
        current.engine = new Fracture(canvas, base.canvas, {
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        });
        Object.assign(current, { overlay, invert, base });
        return true;
      } catch {
        teardown();
        return false;
      } finally {
        current.preparing = undefined;
      }
    })();
    return current.preparing;
  };

  /** The page as it is this instant, on the shards, shown. */
  const show = () => {
    const current = run.current;
    current.engine!.setPage(pageNow(current.base!));
    current.overlay!.style.visibility = "visible";
    current.showing = true;
  };
  const hide = () => {
    const current = run.current;
    if (current.overlay) current.overlay.style.visibility = "hidden";
    current.engine?.stop();
    current.showing = false;
  };

  useEffect(
    () => () => {
      // A burst outlives the page it broke: it ends by itself.
      if (run.current.bursting) return;
      unfreeze();
      teardown();
    },
    [],
  );

  // Once the page rests, everything is made ready, so that a hover
  // cracks the page at once; again after a resize.
  useEffect(() => {
    if (!capable()) return;
    let timer = 0;
    const warm = () => void stage();
    // After the scene has lit up (its entry lasts about 3 s), when the
    // page rests: the still must hold the ring at full light.
    const idle = typeof requestIdleCallback === "function";
    let id = 0;
    const settle = window.setTimeout(() => {
      id = idle
        ? requestIdleCallback(warm, { timeout: 2000 })
        : window.setTimeout(warm, 0);
    }, 3600);
    const resized = () => {
      clearTimeout(timer);
      timer = window.setTimeout(warm, 700);
    };
    addEventListener("resize", resized);
    return () => {
      clearTimeout(settle);
      if (idle) cancelIdleCallback(id);
      else clearTimeout(id);
      clearTimeout(timer);
      removeEventListener("resize", resized);
    };
  }, []);

  const hold = async () => {
    if (!capable()) return;
    const current = run.current;
    current.holding = true;
    router.prefetch(href);
    // Time stops: the page holds still while it cracks.
    freeze();
    const ready = await stage();
    if (!ready || !run.current.holding || run.current.bursting) {
      if (!run.current.holding && !run.current.bursting) unfreeze();
      return;
    }
    if (!run.current.showing) show();
    void run.current.engine!.crack(1);
  };

  const letGo = async () => {
    const current = run.current;
    current.holding = false;
    if (current.bursting) return;
    if (current.showing && current.engine) {
      await current.engine.crack(0);
      if (run.current.holding || run.current.bursting) return;
      hide();
    }
    unfreeze();
  };

  const burst = async () => {
    const current = run.current;
    current.bursting = true;
    freeze();
    const ready = await Promise.race([
      stage(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2500)),
    ]);
    const { engine, overlay } = run.current;
    if (!ready || !engine) {
      router.push(href);
      return;
    }
    if (!run.current.showing) show();
    engine.explode({
      invert: run.current.invert!,
      // The next page renders at once, under the shards, as they fly.
      onReveal: () => router.push(href),
      onDone: () => {
        engine.dispose();
        overlay?.remove();
      },
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
