"use client";

import { motion } from "motion/react";
import type { CSSProperties } from "react";

import { photo, srcSet, type Universe } from "./universes";

/**
 * The brand's opening photo, entering in the universe's own way: a sharp
 * wipe ("cut") or a slow settle out of the dark ("bloom").
 */
export function Cover({
  universe,
  className,
  imageStyle,
}: {
  universe: Universe;
  className?: string;
  imageStyle?: CSSProperties;
}) {
  const { ease, entrance } = universe.motion;
  return (
    <motion.div
      className={`relative overflow-hidden ${className ?? ""}`}
      initial={
        entrance === "cut" ? { clipPath: "inset(0 0 100% 0)" } : { opacity: 0 }
      }
      animate={
        entrance === "cut" ? { clipPath: "inset(0 0 0% 0)" } : { opacity: 1 }
      }
      transition={{ duration: entrance === "cut" ? 1 : 2.2, ease }}
    >
      <motion.div
        className="absolute inset-0"
        initial={{ scale: entrance === "cut" ? 1.25 : 1.12 }}
        animate={{ scale: 1 }}
        transition={{ duration: entrance === "cut" ? 1.4 : 6, ease }}
      >
        {/* Prototype: remote CDN photos, plain img with responsive sources. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo(universe.cover, 1200)}
          srcSet={srcSet(universe.cover)}
          sizes="100vw"
          alt=""
          draggable={false}
          fetchPriority="high"
          className="absolute inset-0 h-full w-full object-cover"
          style={imageStyle}
        />
      </motion.div>
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
