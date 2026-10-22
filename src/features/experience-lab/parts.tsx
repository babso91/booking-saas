"use client";

import { motion, type Transition } from "motion/react";
import type { CSSProperties } from "react";

import { photo, srcSet, type Universe } from "./universes";

/**
 * The brand's cover photo, shared between the hub card and the brand's
 * opening scene (same layoutId): entering a brand is this photo growing.
 */
export function Cover({
  universe,
  className,
  style,
  imageStyle,
  transition,
  priority,
}: {
  universe: Universe;
  className?: string;
  style?: CSSProperties;
  imageStyle?: CSSProperties;
  transition?: Transition;
  priority?: boolean;
}) {
  return (
    <motion.div
      layoutId={`cover-${universe.id}`}
      className={`relative overflow-hidden ${className ?? ""}`}
      style={style}
      transition={
        transition ?? {
          duration: universe.motion.scene,
          ease: universe.motion.ease,
        }
      }
    >
      {/* Prototype: remote CDN photos, plain img with responsive sources. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo(universe.cover, 1200)}
        srcSet={srcSet(universe.cover)}
        sizes="100vw"
        alt=""
        draggable={false}
        fetchPriority={priority ? "high" : "auto"}
        className="absolute inset-0 h-full w-full object-cover"
        style={imageStyle}
      />
    </motion.div>
  );
}

/** A photo of the universe, in its own treatment. */
export function Photo({
  id,
  alt,
  className,
  style,
  sizes = "100vw",
}: {
  id: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  sizes?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={photo(id, 828)}
      srcSet={srcSet(id)}
      sizes={sizes}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={className}
      style={style}
    />
  );
}

export const euros = (cents: number) =>
  `${(cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0 })} €`;

export const minutes = (value: number) => {
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
};

/** The next `count` days, from tomorrow: civil labels only (prototype). */
export function nextDays(count: number) {
  const format = new Intl.DateTimeFormat("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return Array.from({ length: count }, (_, index) => {
    const at = new Date();
    at.setDate(at.getDate() + index + 1);
    const [weekday, day, month] = format
      .format(at)
      .replace(/\./g, "")
      .split(" ");
    return {
      index,
      weekday: weekday!,
      day: day!,
      month: month!,
      label: `${weekday} ${day} ${month}`,
    };
  });
}
