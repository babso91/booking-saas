"use client";

import type { MotionProps } from "motion/react";
import {
  createContext,
  useContext,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";

import { photo, srcSet } from "../photos";
import type { PhotoSlot, Service, SiteConfig } from "./config";
import { grades, motions, typePairs } from "./tokens";

// What every scene variant receives: the site's config, its resolved
// tokens, and the actions of the shared functional engine (booking). In
// the studio, `edit` makes the preview itself the editor: touching a
// photo opens it instead of its public behaviour.

type Engine = {
  config: SiteConfig;
  book: (service: Service | null) => void;
  edit?: { photo: (slot: PhotoSlot) => void; selected: PhotoSlot | null };
};

const Context = createContext<Engine | null>(null);

export function EngineProvider({
  value,
  children,
}: {
  value: Engine;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useEngine() {
  const engine = useContext(Context);
  if (!engine) throw new Error("useEngine outside EngineProvider");
  const { tokens } = engine.config;
  return {
    ...engine,
    motion: motions[tokens.motion],
    type: typePairs[tokens.type],
    grade: grades[tokens.grade],
  };
}

/** Display type of the site (family, weight, case, tracking). */
export function Display({
  as: Tag = "span",
  className,
  style,
  children,
}: {
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <Tag
      className={className}
      style={{
        fontFamily: "var(--t-display)",
        fontWeight: "var(--t-display-weight)" as unknown as number,
        textTransform:
          "var(--t-display-case)" as CSSProperties["textTransform"],
        letterSpacing: "var(--t-display-tracking)",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/** Small labels: monospace capitals or quiet sentence case, per type pair. */
export function Detail({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { type } = useEngine();
  return (
    <span
      className={`${type.detailCaps ? "text-[11.5px] tracking-[0.1em] uppercase" : "text-[14px]"} ${className ?? ""}`}
      style={{ fontFamily: "var(--t-detail)" }}
    >
      {children}
    </span>
  );
}

/** A photo in the site's grade (filter, and an accent wash if any). */
export function GradedPhoto({
  id,
  alt,
  sizes = "100vw",
  className,
  eager,
}: {
  id: string;
  alt: string;
  sizes?: string;
  className?: string;
  eager?: boolean;
}) {
  const { grade, config } = useEngine();
  const focal = config.content.focals[id] ?? { x: 50, y: 50 };
  return (
    <span className={`absolute inset-0 block ${className ?? ""}`}>
      {/* Prototype: CDN photos, plain img with responsive sources. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo(id, 828)}
        srcSet={srcSet(id)}
        sizes={sizes}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        draggable={false}
        className="h-full w-full object-cover"
        style={{
          filter: grade.filter,
          objectPosition: `${focal.x}% ${focal.y}%`,
        }}
      />
      {grade.wash ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-[var(--u-accent)]"
          style={{
            mixBlendMode: grade.wash.blend,
            opacity: grade.wash.opacity,
          }}
        />
      ) : null}
    </span>
  );
}

/**
 * In the studio: a photo of the preview becomes a touch target that opens
 * it in the photo editor (outlined when it is the one being edited).
 */
export function EditTarget({
  slot,
  inButton,
}: {
  slot: PhotoSlot;
  /** Inside a button already wired to edit: a visual mark only. */
  inButton?: boolean;
}) {
  const { edit } = useEngine();
  if (!edit) return null;
  const selected = edit.selected === slot;
  const className = `absolute inset-0 z-10 -outline-offset-4 ${selected ? "outline-4 outline-white" : "outline-2 outline-white/70 outline-dashed"}`;
  const badge = (
    <span
      className="absolute top-3 left-3 rounded-full bg-black/70 px-3 py-1.5 text-[12.5px] font-medium text-white backdrop-blur"
      style={{ fontFamily: "var(--font-lab-sans)" }}
    >
      ✎ Photo
    </span>
  );
  if (inButton) {
    return (
      <span aria-hidden="true" className={className}>
        {badge}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => edit.photo(slot)}
      aria-label={
        slot === "cover"
          ? "Modifier la photo de couverture"
          : `Modifier la réalisation ${slot + 1}`
      }
      className={`${className} cursor-pointer`}
    >
      {badge}
    </button>
  );
}

/**
 * How an element appears when it scrolls into view, in the site's motion
 * language: a clean wipe, a slow rise out of blur, or a springy pop.
 */
export function useReveal() {
  const { motion } = useEngine();
  return (index = 0): MotionProps => {
    const delay = index * (motion.entrance === "bloom" ? 0.2 : 0.08);
    const transition = { duration: motion.duration, ease: motion.ease, delay };
    const viewport = { once: true, margin: "-12%" };
    if (motion.entrance === "cut") {
      return {
        initial: { clipPath: "inset(0 0 100% 0)" },
        whileInView: { clipPath: "inset(0 0 0% 0)" },
        viewport,
        transition,
      };
    }
    if (motion.entrance === "snap") {
      return {
        initial: { opacity: 0, scale: 0.86, y: 30 },
        whileInView: { opacity: 1, scale: 1, y: 0 },
        viewport,
        transition,
      };
    }
    return {
      initial: { opacity: 0, y: 26, filter: "blur(6px)" },
      whileInView: { opacity: 1, y: 0, filter: "blur(0px)" },
      viewport,
      transition,
    };
  };
}

export const euros = (cents: number) =>
  `${(cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0 })} €`;

export const minutes = (value: number) => {
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
};
