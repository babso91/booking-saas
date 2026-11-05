"use client";

import {
  AnimatePresence,
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import { useRef, useState } from "react";

import type { Work as WorkItem, WorkVariant } from "../engine/config";
import {
  Detail,
  Display,
  EditTarget,
  GradedPhoto,
  useEngine,
  useReveal,
} from "../engine/engine";
import { SitePortal, useModal } from "../engine/modal";

// The professional's work: her photos are the heart of her site. Three
// compositions — a lookbook, arches with depth, a film strip — all
// opening a photo full screen.

export function Work({
  variant,
  index,
}: {
  variant: WorkVariant;
  index: number;
}) {
  const { edit } = useEngine();
  const [open, setOpen] = useState<WorkItem | null>(null);
  // In the studio a photo opens in the photo editor, not full screen.
  const show = (work: WorkItem, position: number) =>
    edit ? edit.photo(position) : setOpen(work);
  const label = `(${String(index).padStart(2, "0")}) Réalisations`;
  return (
    <>
      {variant === "arches" ? (
        <Arches onOpen={show} />
      ) : variant === "filmstrip" ? (
        <Filmstrip onOpen={show} />
      ) : (
        <Lookbook label={label} onOpen={show} />
      )}
      <AnimatePresence>
        {open ? (
          <FullView key={open.id} work={open} onClose={() => setOpen(null)} />
        ) : null}
      </AnimatePresence>
    </>
  );
}

const layouts = [
  "col-span-6",
  "col-span-4 col-start-3",
  "col-span-5",
  "col-span-3 col-start-4",
  "col-span-6 md:col-span-4 md:col-start-2",
];

function Lookbook({
  label,
  onOpen,
}: {
  label: string;
  onOpen: (work: WorkItem, position: number) => void;
}) {
  const { config } = useEngine();
  const reveal = useReveal();
  const works = config.content.works;
  return (
    <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
      <div className="mx-auto max-w-[1100px] px-5 pb-28">
        <div className="flex items-baseline justify-between border-t border-[var(--u-line)] pt-4 text-[var(--u-muted)]">
          <Detail>{label}</Detail>
          <Detail>{String(works.length).padStart(2, "0")}</Detail>
        </div>
        <ul className="mt-10 grid grid-cols-6 gap-x-3 gap-y-14">
          {works.map((work, position) => (
            <motion.li
              key={work.id}
              className={layouts[position % layouts.length]}
              {...reveal()}
            >
              <button
                type="button"
                onClick={() => onOpen(work, position)}
                className="block w-full cursor-zoom-in text-left"
              >
                <motion.div
                  layoutId={`work-${work.id}`}
                  className="relative aspect-[4/5] overflow-hidden"
                  style={{ borderRadius: "var(--s-radius)" }}
                >
                  <GradedPhoto
                    id={work.photo}
                    alt={work.title}
                    sizes="(min-width: 768px) 50vw, 90vw"
                  />
                  <EditTarget slot={position} inButton />
                </motion.div>
                <span className="mt-3 flex items-baseline justify-between gap-3">
                  <Display className="min-w-0 text-[22px] leading-none [overflow-wrap:anywhere]">
                    {work.title}
                  </Display>
                  <Detail className="shrink-0 text-[var(--u-muted)]">
                    {String(position + 1).padStart(2, "0")}
                  </Detail>
                </span>
              </button>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Arches({
  onOpen,
}: {
  onOpen: (work: WorkItem, position: number) => void;
}) {
  const { config } = useEngine();
  return (
    <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
      <div className="mx-auto max-w-[1100px] px-6 pb-32">
        <p className="text-center text-[var(--u-muted)]">
          <Detail>Ce que nous faisons</Detail>
        </p>
        <ul className="mt-12 flex flex-col gap-20 md:grid md:grid-cols-2 md:gap-x-10 md:gap-y-28">
          {config.content.works.map((work, position) => (
            <DriftFrame
              key={work.id}
              work={work}
              arch={position % 2 === 0}
              offset={position % 2 === 1}
              onOpen={onOpen}
              slot={position}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

function DriftFrame({
  work,
  arch,
  offset,
  onOpen,
  slot,
}: {
  work: WorkItem;
  arch: boolean;
  offset: boolean;
  onOpen: (work: WorkItem, position: number) => void;
  slot: number;
}) {
  const reveal = useReveal();
  const frame = useRef<HTMLLIElement>(null);
  const { scrollYProgress } = useScroll({
    target: frame,
    offset: ["start end", "end start"],
  });
  const drift = useTransform(scrollYProgress, [0, 1], ["-9%", "9%"]);
  // No scroll-driven drift when she asked for less motion.
  const y = useReducedMotion() ? "0%" : drift;
  return (
    <motion.li ref={frame} className={offset ? "md:mt-40" : ""} {...reveal()}>
      <button
        type="button"
        onClick={() => onOpen(work, slot)}
        className="block w-full cursor-zoom-in"
      >
        <motion.div
          layoutId={`work-${work.id}`}
          className="relative mx-auto aspect-[3/4] w-[86%] overflow-hidden"
          style={{
            borderRadius: arch
              ? "999px 999px var(--s-radius) var(--s-radius)"
              : "var(--s-radius)",
          }}
        >
          <motion.div className="absolute inset-[-10%]" style={{ y }}>
            <GradedPhoto
              id={work.photo}
              alt={work.title}
              sizes="(min-width: 768px) 45vw, 86vw"
            />
          </motion.div>
          <EditTarget slot={slot} inButton />
        </motion.div>
        <span className="mx-auto mt-5 block w-[86%] text-center">
          <Display className="block text-[24px]">{work.title}</Display>
          <span className="mt-1 block text-[var(--u-muted)]">
            <Detail>{work.note}</Detail>
          </span>
        </span>
      </button>
    </motion.li>
  );
}

function Filmstrip({
  onOpen,
}: {
  onOpen: (work: WorkItem, position: number) => void;
}) {
  const { config } = useEngine();
  const reveal = useReveal();
  const works = config.content.works;
  return (
    <section className="overflow-hidden bg-[var(--u-bg)] py-20 text-[var(--u-ink)]">
      <div className="mx-auto flex max-w-[1100px] items-end justify-between gap-4 px-5">
        <motion.h2
          className="text-[clamp(48px,15vw,140px)] leading-[0.85]"
          {...reveal()}
        >
          <Display>Réalisations</Display>
        </motion.h2>
        <Detail className="pb-2 text-[var(--u-muted)]">
          {String(works.length).padStart(2, "0")} pièces
        </Detail>
      </div>
      <ul className="mt-10 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-6 [scrollbar-width:none]">
        {works.map((work, position) => (
          <motion.li
            key={work.id}
            className="w-[72vw] max-w-[380px] shrink-0 snap-center"
            {...reveal(position)}
          >
            <button
              type="button"
              onClick={() => onOpen(work, position)}
              className="relative block w-full cursor-zoom-in text-left"
            >
              <motion.div
                layoutId={`work-${work.id}`}
                className="relative aspect-[3/4] overflow-hidden"
                style={{ borderRadius: "var(--s-radius)" }}
              >
                <GradedPhoto id={work.photo} alt={work.title} sizes="72vw" />
                <EditTarget slot={position} inButton />
              </motion.div>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -top-2 left-3 text-[96px] leading-none text-transparent [-webkit-text-stroke:1.5px_var(--u-accent)]"
              >
                <Display>{String(position + 1).padStart(2, "0")}</Display>
              </span>
              <span className="mt-3 flex items-baseline justify-between gap-2">
                <Display className="text-[26px] leading-none">
                  {work.title}
                </Display>
                <Detail className="text-[var(--u-muted)]">{work.note}</Detail>
              </span>
            </button>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A work full screen: a real modal (engine/modal.tsx), on <body> above the
 * studio, the page behind inert, Escape or the button closes it and focus
 * goes back to the photo that opened it.
 */
function FullView({ work, onClose }: { work: WorkItem; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  useModal({ root, panel, initial: closer, onClose });
  return (
    <SitePortal rootRef={root}>
      <motion.div
        ref={panel}
        tabIndex={-1}
        className="fixed inset-0 flex flex-col bg-black text-white outline-none"
        initial={{ backgroundColor: "rgba(0,0,0,0)" }}
        animate={{ backgroundColor: "rgba(0,0,0,1)" }}
        exit={{ backgroundColor: "rgba(0,0,0,0)" }}
        role="dialog"
        aria-modal="true"
        aria-label={work.title}
      >
        <motion.div
          layoutId={`work-${work.id}`}
          className="relative flex-1 overflow-hidden"
        >
          <GradedPhoto id={work.photo} alt={work.title} eager />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0, transition: { delay: 0.35 } }}
          exit={{ opacity: 0 }}
          className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 bg-[linear-gradient(0deg,rgba(0,0,0,.7),transparent)] px-5 pt-20 pb-[max(env(safe-area-inset-bottom),22px)]"
        >
          <span>
            <Display className="block text-[44px] leading-none">
              {work.title}
            </Display>
            <span className="mt-2 block">
              <Detail>{work.note}</Detail>
            </span>
          </span>
          <button
            ref={closer}
            type="button"
            onClick={onClose}
            className="cursor-pointer py-2"
          >
            <Detail>Fermer ✕</Detail>
          </button>
        </motion.div>
      </motion.div>
    </SitePortal>
  );
}
