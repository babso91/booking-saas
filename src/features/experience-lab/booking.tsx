"use client";

import {
  AnimatePresence,
  motion,
  type TargetAndTransition,
  type Transition,
} from "motion/react";
import { useEffect, useState, type CSSProperties } from "react";

import { euros, minutes, nextDays } from "./parts";
import { slotsFor, type Service, type Universe } from "./universes";

// One booking engine (service → day and time → confirm), two stagings.
// The steps, rules and data are the same for every universe; only the
// composition, type and motion change. Speed first: no step waits for an
// animation, and every target is a large touch area.

export type Booked = { service: Service; day: string; time: string };

type Look = {
  frame: string;
  enter: {
    initial: TargetAndTransition;
    animate: TargetAndTransition;
    exit: TargetAndTransition;
    transition: Transition;
  };
  title: CSSProperties;
  label: CSSProperties;
  chip: (selected: boolean) => string;
  primary: string;
  backdrop: boolean;
};

const looks: Record<Universe["id"], Look> = {
  mila: {
    frame:
      "fixed inset-0 z-50 flex flex-col bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]",
    enter: {
      initial: { clipPath: "inset(100% 0 0 0)" },
      animate: { clipPath: "inset(0% 0 0 0)" },
      exit: { clipPath: "inset(0 0 100% 0)" },
      transition: { duration: 0.6, ease: [0.76, 0, 0.24, 1] },
    },
    title: { fontFamily: "var(--font-mila-display)", letterSpacing: "-0.03em" },
    label: {
      fontFamily: "var(--font-mila-mono)",
      textTransform: "uppercase",
      letterSpacing: "0.1em",
      fontSize: 11.5,
    },
    chip: (selected) =>
      `border border-black ${selected ? "bg-black text-[var(--u-paper)]" : "bg-transparent"}`,
    primary:
      "h-14 w-full bg-black text-[var(--u-paper)] uppercase tracking-[0.1em] text-[13px] [font-family:var(--font-mila-mono)]",
    backdrop: false,
  },
  alma: {
    frame:
      "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-[34px] bg-[var(--u-paper)] text-[var(--u-ink-on-paper)] shadow-[0_-30px_80px_-20px_rgba(0,0,0,.5)]",
    enter: {
      initial: { y: "100%" },
      animate: { y: 0 },
      exit: { y: "100%" },
      transition: { duration: 0.9, ease: [0.22, 1, 0.36, 1] },
    },
    title: { fontFamily: "var(--font-alma-display)", fontWeight: 300 },
    label: { fontSize: 14, opacity: 0.65 },
    chip: (selected) =>
      `rounded-full ${selected ? "bg-[var(--u-ink-on-paper)] text-[var(--u-paper)]" : "bg-[#F1F3EC]"}`,
    primary:
      "h-14 w-full rounded-full bg-[var(--u-accent)] text-white text-[16px]",
    backdrop: true,
  },
};

export function Booking({
  universe,
  initialService,
  onClose,
  onBooked,
  onOpenSpace,
}: {
  universe: Universe;
  initialService: Service | null;
  onClose: () => void;
  onBooked: (booked: Booked) => void;
  onOpenSpace: () => void;
}) {
  const look = looks[universe.id];
  const [service, setService] = useState<Service | null>(initialService);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState<string | null>(null);
  const [done, setDone] = useState<Booked | null>(null);
  const days = nextDays(12);
  const slots = slotsFor(day);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  function confirm() {
    if (!service || !time) return;
    const booked = { service, day: days[day]!.label, time };
    setDone(booked);
    onBooked(booked);
  }

  const step = done ? 3 : !service ? 1 : 2;

  return (
    <>
      {look.backdrop ? (
        <motion.div
          className="fixed inset-0 z-50 bg-black/45"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        />
      ) : null}
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Réserver"
        className={look.frame}
        {...look.enter}
        style={{ fontFamily: universe.fonts.body }}
      >
        <div className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-2">
          <span style={look.label}>
            {universe.id === "mila" ? `Réservation — ${step}/3` : universe.name}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 cursor-pointer px-2 py-2"
            style={look.label}
          >
            {universe.id === "mila" ? "Fermer ✕" : "Fermer"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6">
          <AnimatePresence mode="wait" initial={false}>
            {done ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex min-h-[60dvh] flex-col justify-center gap-5"
              >
                {universe.id === "alma" ? (
                  <motion.span
                    className="flex size-20 items-center justify-center rounded-full bg-[var(--u-accent)] text-[30px] text-white"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
                    aria-hidden="true"
                  >
                    ✓
                  </motion.span>
                ) : null}
                <h2 className="text-[56px] leading-[0.95]" style={look.title}>
                  {universe.id === "mila" ? "C’est noté." : "À très bientôt."}
                </h2>
                <p className="text-[17px] leading-relaxed">
                  {done.service.name}
                  <br />
                  {done.day} · {done.time} ·{" "}
                  {minutes(done.service.durationMinutes)}
                </p>
                <button
                  type="button"
                  onClick={onOpenSpace}
                  className={`${look.primary} mt-4 cursor-pointer`}
                >
                  Voir mon espace chez {universe.name}
                </button>
              </motion.div>
            ) : !service ? (
              <motion.div
                key="service"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <h2
                  className="mt-4 text-[40px] leading-none"
                  style={look.title}
                >
                  Quel soin ?
                </h2>
                <ul className="mt-8 flex flex-col gap-2">
                  {universe.services.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setService(item)}
                        className={`flex min-h-16 w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left ${look.chip(false)}`}
                      >
                        <span className="text-[17px]">{item.name}</span>
                        <span className="text-[14px] whitespace-nowrap tabular-nums opacity-70">
                          {minutes(item.durationMinutes)} ·{" "}
                          {euros(item.priceCents)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ) : (
              <motion.div
                key="slot"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <button
                  type="button"
                  onClick={() => setService(null)}
                  className="mt-2 cursor-pointer text-left"
                >
                  <span style={look.label}>Soin · changer</span>
                  <h2
                    className="mt-1 text-[36px] leading-none"
                    style={look.title}
                  >
                    {service.name}
                  </h2>
                </button>
                <p className="mt-8" style={look.label}>
                  Jour
                </p>
                <ul className="-mx-5 mt-3 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">
                  {days.map((item) => (
                    <li key={item.index}>
                      <button
                        type="button"
                        onClick={() => {
                          setDay(item.index);
                          setTime(null);
                        }}
                        aria-pressed={day === item.index}
                        className={`flex h-[76px] w-[62px] cursor-pointer flex-col items-center justify-center ${look.chip(day === item.index)}`}
                      >
                        <span className="text-[12px] opacity-70">
                          {item.weekday}
                        </span>
                        <span
                          className="text-[24px] leading-tight"
                          style={look.title}
                        >
                          {item.day}
                        </span>
                        <span className="text-[11.5px] opacity-70">
                          {item.month}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-8" style={look.label}>
                  Heure
                </p>
                <ul className="mt-3 grid grid-cols-3 gap-2">
                  {slots.map((slot) => (
                    <li key={slot}>
                      <button
                        type="button"
                        onClick={() => setTime(slot)}
                        aria-pressed={time === slot}
                        className={`h-12 w-full cursor-pointer text-[16px] tabular-nums ${look.chip(time === slot)}`}
                      >
                        {slot}
                      </button>
                    </li>
                  ))}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {!done && service ? (
          <div className="border-t border-black/10 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]">
            <button
              type="button"
              disabled={!time}
              onClick={confirm}
              className={`${look.primary} cursor-pointer disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {time
                ? `Confirmer · ${days[day]!.label} · ${time}`
                : "Choisissez une heure"}
            </button>
          </div>
        ) : null}
      </motion.div>
    </>
  );
}
