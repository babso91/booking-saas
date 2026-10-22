"use client";

import { MotionConfig } from "motion/react";
import type { CSSProperties } from "react";

import { AlmaBrand } from "./alma";
import { MilaBrand } from "./mila";
import { universes, type Universe } from "./universes";

// A professional's public mini-site: her universe from the first frame,
// her work, her services and a direct booking without any account.

export type BrandProps = { universe: Universe };

export function BrandSite({ id }: { id: Universe["id"] }) {
  const universe = universes[id];
  return (
    <MotionConfig reducedMotion="user">
      <div style={universe.palette as CSSProperties}>
        {universe.id === "mila" ? (
          <MilaBrand universe={universe} />
        ) : (
          <AlmaBrand universe={universe} />
        )}
      </div>
    </MotionConfig>
  );
}
