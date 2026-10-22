"use client";

import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
} from "motion/react";
import { useEffect, useState, type CSSProperties } from "react";

import { AlmaBrand } from "./alma";
import { Hub } from "./hub";
import { MilaBrand } from "./mila";
import { universes, type Universe } from "./universes";

// The lab's single client tree: the neutral hub, and a brand universe once
// entered. One tree (not two routes) so the cover photo is the same element
// growing from the hub card into the brand's opening scene.

export type BrandProps = {
  universe: Universe;
  onLeave: () => void;
};

export function ExperienceLab() {
  const [entered, setEntered] = useState<Universe["id"] | null>(null);

  // Each scene starts at its top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [entered]);

  const universe = entered ? universes[entered] : null;

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup>
        <AnimatePresence mode="popLayout" initial={false}>
          {universe ? (
            <motion.div
              key={universe.id}
              style={universe.palette as CSSProperties}
              exit={{ opacity: 0, transition: { duration: 0.35 } }}
            >
              {universe.id === "mila" ? (
                <MilaBrand
                  universe={universe}
                  onLeave={() => setEntered(null)}
                />
              ) : (
                <AlmaBrand
                  universe={universe}
                  onLeave={() => setEntered(null)}
                />
              )}
            </motion.div>
          ) : (
            <motion.div
              key="hub"
              exit={{ opacity: 0, transition: { duration: 0.25 } }}
            >
              <Hub onEnter={setEntered} />
            </motion.div>
          )}
        </AnimatePresence>
      </LayoutGroup>
    </MotionConfig>
  );
}
