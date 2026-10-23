"use client";

import { AnimatePresence, motion, type MotionProps } from "motion/react";
import { useEffect, useId, useState, type ReactNode } from "react";

import type { Service } from "./engine/config";
import { Detail, Display, euros, minutes, useEngine } from "./engine/engine";
import { nextDays, slotsFor } from "./slots";

// The shared booking engine, staged by the site's tokens. Same steps as
// the real public booking (docs/PUBLIC_BOOKING_CONTRACT.md): service → day
// and time → contact → confirmed, with NO account. In the product the
// confirm step is POST /api/bookings (idempotent requestId); simulated
// here. Speed first: no step waits for an animation; large touch targets.

const control = { borderRadius: "min(var(--s-control), 22px)" };

export function Booking({
  initialService,
  onClose,
}: {
  initialService: Service | null;
  onClose: () => void;
}) {
  const { config, motion: language } = useEngine();
  const sheet = config.booking === "sheet";
  const [service, setService] = useState<Service | null>(initialService);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState<string | null>(null);
  const [contactStep, setContactStep] = useState(false);
  const [contact, setContact] = useState({
    firstName: "",
    email: "",
    phone: "",
  });
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  const days = nextDays(12);
  const slots = slotsFor(day);
  const firstId = useId();
  const emailId = useId();
  const phoneId = useId();

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

  const errors = {
    firstName: contact.firstName.trim() ? null : "Indiquez votre prénom.",
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email.trim())
      ? null
      : "Une adresse email valide, pour la confirmation.",
  };

  function confirm() {
    setTried(true);
    if (!errors.firstName && !errors.email) setDone(true);
  }

  const step = !service ? 1 : contactStep ? 3 : 2;
  const when = `${days[day]!.label} · ${time ?? ""}`;
  const chip = (selected: boolean) =>
    selected
      ? "border border-[var(--u-ink-on-paper)] bg-[var(--u-ink-on-paper)] text-[var(--u-paper)]"
      : "border border-current/25";
  const primary =
    "h-14 w-full cursor-pointer bg-[var(--u-accent)] text-[var(--u-on-accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const field =
    "h-14 w-full border border-current/25 bg-transparent px-4 text-[17px] outline-none focus:border-[var(--u-accent)] focus:ring-2 focus:ring-[var(--u-accent)]/40";

  const enter: MotionProps = sheet
    ? {
        initial: { y: "100%" },
        animate: { y: 0 },
        exit: { y: "100%" },
        transition: {
          duration: Math.min(language.duration, 0.9),
          ease: language.ease,
        },
      }
    : language.entrance === "cut"
      ? {
          initial: { clipPath: "inset(100% 0 0 0)" },
          animate: { clipPath: "inset(0% 0 0 0)" },
          exit: { clipPath: "inset(0 0 100% 0)" },
          transition: { duration: 0.6, ease: language.ease },
        }
      : {
          initial: { opacity: 0, scale: 0.96 },
          animate: { opacity: 1, scale: 1 },
          exit: { opacity: 0, scale: 0.98 },
          transition: { duration: 0.45, ease: language.ease },
        };

  return (
    <>
      {sheet ? (
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
        aria-label={`Réserver chez ${config.brand.name}`}
        className={
          sheet
            ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col bg-[var(--u-paper)] text-[var(--u-ink-on-paper)] shadow-[0_-30px_80px_-20px_rgba(0,0,0,.5)]"
            : "fixed inset-0 z-50 flex flex-col bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]"
        }
        style={{
          fontFamily: "var(--t-body)",
          ...(sheet
            ? {
                borderTopLeftRadius: "max(var(--s-radius), 20px)",
                borderTopRightRadius: "max(var(--s-radius), 20px)",
              }
            : {}),
        }}
        {...enter}
      >
        <div className="flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),16px)] pb-2">
          <Detail>
            {done ? config.brand.name : `Réservation — ${step}/3`}
          </Detail>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 cursor-pointer px-2 py-2"
          >
            <Detail>Fermer ✕</Detail>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6">
          <AnimatePresence mode="wait" initial={false}>
            {done && service ? (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex min-h-[60dvh] flex-col justify-center gap-5"
              >
                <motion.span
                  className="flex size-16 items-center justify-center rounded-full bg-[var(--u-accent)] text-[26px] text-[var(--u-on-accent)]"
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{
                    duration: language.duration,
                    ease: language.ease,
                  }}
                  aria-hidden="true"
                >
                  ✓
                </motion.span>
                <Display as="h2" className="block text-[52px] leading-[0.95]">
                  {`À bientôt, ${contact.firstName.trim()}.`}
                </Display>
                <p className="text-[17px] leading-relaxed">
                  {service.name}
                  <br />
                  {when} · {minutes(service.durationMinutes)}
                </p>
                <p className="text-[15px] leading-relaxed opacity-75">
                  Un email de confirmation part vers {contact.email.trim()},
                  avec le lien pour gérer votre rendez-vous. Aucun compte à
                  créer.
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  className={`${primary} mt-2`}
                  style={control}
                >
                  Revenir chez {config.brand.name}
                </button>
              </motion.div>
            ) : !service ? (
              <motion.div
                key="service"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Display
                  as="h2"
                  className="mt-4 block text-[40px] leading-none"
                >
                  Quel soin ?
                </Display>
                <ul className="mt-8 flex flex-col gap-2">
                  {config.content.services.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setService(item)}
                        className={`flex min-h-16 w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left ${chip(false)}`}
                        style={control}
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
            ) : contactStep ? (
              <motion.form
                key="contact"
                id="lab-contact"
                noValidate
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onSubmit={(event) => {
                  event.preventDefault();
                  confirm();
                }}
              >
                <button
                  type="button"
                  onClick={() => setContactStep(false)}
                  className="mt-2 cursor-pointer text-left"
                >
                  <Detail>{service.name} · changer</Detail>
                  <Display className="mt-1 block text-[34px] leading-none">
                    {when}
                  </Display>
                </button>
                <p className="mt-6 text-[15px] leading-relaxed opacity-75">
                  Pas de compte, pas de mot de passe : juste de quoi vous
                  confirmer le rendez-vous.
                </p>
                <div className="mt-6 flex flex-col gap-5">
                  <Field
                    id={firstId}
                    label="Prénom"
                    error={tried ? errors.firstName : null}
                  >
                    <input
                      id={firstId}
                      autoComplete="given-name"
                      value={contact.firstName}
                      onChange={(event) =>
                        setContact({
                          ...contact,
                          firstName: event.target.value,
                        })
                      }
                      className={field}
                      style={control}
                      aria-invalid={
                        Boolean(tried && errors.firstName) || undefined
                      }
                    />
                  </Field>
                  <Field
                    id={emailId}
                    label="Email"
                    error={tried ? errors.email : null}
                  >
                    <input
                      id={emailId}
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      value={contact.email}
                      onChange={(event) =>
                        setContact({ ...contact, email: event.target.value })
                      }
                      className={field}
                      style={control}
                      aria-invalid={Boolean(tried && errors.email) || undefined}
                    />
                  </Field>
                  <Field
                    id={phoneId}
                    label="Téléphone (facultatif)"
                    error={null}
                  >
                    <input
                      id={phoneId}
                      type="tel"
                      inputMode="tel"
                      autoComplete="tel"
                      value={contact.phone}
                      onChange={(event) =>
                        setContact({ ...contact, phone: event.target.value })
                      }
                      className={field}
                      style={control}
                    />
                  </Field>
                </div>
              </motion.form>
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
                  <Detail>Soin · changer</Detail>
                  <Display className="mt-1 block text-[36px] leading-none">
                    {service.name}
                  </Display>
                </button>
                <p className="mt-8">
                  <Detail>Jour</Detail>
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
                        className={`flex h-[76px] w-[62px] cursor-pointer flex-col items-center justify-center ${chip(day === item.index)}`}
                        style={control}
                      >
                        <span className="text-[12px] opacity-70">
                          {item.weekday}
                        </span>
                        <Display className="text-[24px] leading-tight">
                          {item.day}
                        </Display>
                        <span className="text-[11.5px] opacity-70">
                          {item.month}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mt-8">
                  <Detail>Heure</Detail>
                </p>
                <ul className="mt-3 grid grid-cols-3 gap-2">
                  {slots.map((slot) => (
                    <li key={slot}>
                      <button
                        type="button"
                        onClick={() => setTime(slot)}
                        aria-pressed={time === slot}
                        className={`h-12 w-full cursor-pointer text-[16px] tabular-nums ${chip(time === slot)}`}
                        style={control}
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
          <div className="border-t border-current/10 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]">
            {contactStep ? (
              <button
                type="submit"
                form="lab-contact"
                className={primary}
                style={control}
              >
                Confirmer le rendez-vous
              </button>
            ) : (
              <button
                type="button"
                disabled={!time}
                onClick={() => setContactStep(true)}
                className={primary}
                style={control}
              >
                {time ? `Continuer · ${when}` : "Choisissez une heure"}
              </button>
            )}
          </div>
        ) : null}
      </motion.div>
    </>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id}>
        <Detail>{label}</Detail>
      </label>
      {children}
      {error ? <p className="text-[14px] text-[#B3261E]">{error}</p> : null}
    </div>
  );
}
