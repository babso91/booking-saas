"use client";

import { AnimatePresence, motion, type MotionProps } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import {
  choiceOf,
  quote,
  type CatalogService,
  type Picks,
} from "./catalog/model";
import {
  Detail,
  Display,
  Note,
  euros,
  minutes,
  price,
  useEngine,
} from "./engine/engine";
import { contrast, ctaColors } from "./engine/tokens";
import { nextDays, slotsFor } from "./slots";

// The shared booking engine, staged by the site's tokens. Same steps as
// the real public booking (docs/PUBLIC_BOOKING_CONTRACT.md): service →
// day and time → contact → confirmed, with NO account; plus, when her
// service has some, its options (a question, one answer, a supplement and
// possibly more time, as SHE set them). In the product the confirm step is
// POST /api/bookings (idempotent requestId) and the price comes from the
// backend; here everything is simulated. Speed first: no step waits for an
// animation; large touch targets.

const control = { borderRadius: "min(var(--s-control), 22px)" };

type Stage = "service" | "options" | "slot" | "contact";
const after = (service: CatalogService): Stage =>
  service.options.length ? "options" : "slot";

export function Booking({
  initialService,
  onClose,
}: {
  initialService: CatalogService | null;
  onClose: () => void;
}) {
  const { config, catalog, motion: language } = useEngine();
  const sheet = config.booking === "sheet";
  const [service, setService] = useState<CatalogService | null>(initialService);
  const [stage, setStage] = useState<Stage>(
    initialService ? after(initialService) : "service",
  );
  const [picks, setPicks] = useState<Picks>({});
  const [day, setDay] = useState(0);
  const [time, setTime] = useState<string | null>(null);
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

  const dialog = useRef<HTMLDivElement>(null);

  // Focus moves into the booking, and back to what opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => opener?.focus?.();
  }, []);

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

  const stages: Stage[] = [
    "service",
    ...(service?.options.length ? (["options"] as const) : []),
    "slot",
    "contact",
  ];
  const step = stages.indexOf(stage) + 1;
  const total = service ? quote(service, picks) : null;
  const when = `${days[day]!.label} · ${time ?? ""}`;
  const choose = (item: CatalogService) => {
    setService(item);
    setPicks({});
    setStage(after(item));
  };
  const chip = (selected: boolean) =>
    selected
      ? "border border-[var(--u-ink-on-paper)] bg-[var(--u-ink-on-paper)] text-[var(--u-paper)]"
      : "border border-current/25";
  // Her button colour (the accent by default); its text is computed. A
  // colour close to the page gets an outline so the button stays visible.
  const cta = ctaColors(config.tokens, config.tokens.palette.accent);
  const primary =
    "h-14 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40";
  const primaryStyle = {
    ...control,
    background: cta.fill,
    color: cta.text,
    boxShadow:
      contrast(cta.fill, config.tokens.palette.paper) < 1.6
        ? "inset 0 0 0 1.5px currentColor"
        : undefined,
  };
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
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Réserver chez ${config.brand.name}`}
        className={
          sheet
            ? "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col outline-none bg-[var(--u-paper)] text-[var(--u-ink-on-paper)] shadow-[0_-30px_80px_-20px_rgba(0,0,0,.5)]"
            : "fixed inset-0 z-50 flex flex-col bg-[var(--u-paper)] outline-none text-[var(--u-ink-on-paper)]"
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
            {done
              ? config.brand.name
              : `Réservation — ${step}/${stages.length}`}
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
                  {service.options.map((option) => (
                    <span
                      key={option.id}
                      className="block text-[15px] opacity-75"
                    >
                      {option.question} {choiceOf(option, picks)?.label}
                    </span>
                  ))}
                  <span className="block">
                    {when} · {minutes(total!.durationMinutes)} ·{" "}
                    {euros(total!.priceCents)}
                  </span>
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
                  style={primaryStyle}
                >
                  Revenir chez {config.brand.name}
                </button>
              </motion.div>
            ) : stage === "service" || !service ? (
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
                {catalog.map((group) => (
                  <div
                    key={group.category?.id ?? "sans-categorie"}
                    className="mt-8"
                  >
                    {group.category ? (
                      <h3 className="mb-3 text-[15px] font-semibold [overflow-wrap:anywhere]">
                        {group.category.name}
                      </h3>
                    ) : null}
                    <ul className="flex flex-col gap-2">
                      {group.services.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => choose(item)}
                            className={`flex min-h-16 w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left ${chip(false)}`}
                            style={control}
                          >
                            <span className="min-w-0 text-[17px] [overflow-wrap:anywhere]">
                              {item.name}
                            </span>
                            <span className="shrink-0 text-right text-[14px] whitespace-nowrap tabular-nums opacity-70">
                              {minutes(item.durationMinutes)}
                              <br />
                              {price(item.priceCents)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </motion.div>
            ) : stage === "options" ? (
              <motion.div
                key="options"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <button
                  type="button"
                  onClick={() => setStage("service")}
                  className="mt-2 cursor-pointer text-left"
                >
                  <Note className="opacity-70">Soin · changer</Note>
                  <Display className="mt-1 block text-[34px] leading-none [overflow-wrap:anywhere]">
                    {service.name}
                  </Display>
                </button>
                {service.options.map((option) => (
                  <fieldset key={option.id} className="mt-8">
                    <legend className="text-[17px] font-medium">
                      {option.question}
                    </legend>
                    <div className="mt-3 flex flex-col gap-2">
                      {option.choices.map((choice) => {
                        const selected =
                          choiceOf(option, picks)?.id === choice.id;
                        const extra = [
                          choice.priceDeltaCents
                            ? `+${euros(choice.priceDeltaCents)}`
                            : null,
                          choice.durationDeltaMinutes
                            ? `+${minutes(choice.durationDeltaMinutes)}`
                            : null,
                        ].filter(Boolean);
                        return (
                          <button
                            key={choice.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() =>
                              setPicks({ ...picks, [option.id]: choice.id })
                            }
                            className={`flex min-h-14 w-full cursor-pointer items-center justify-between gap-3 px-4 text-left ${chip(selected)}`}
                            style={control}
                          >
                            <span className="text-[17px]">{choice.label}</span>
                            <span className="text-[14px] tabular-nums opacity-80">
                              {extra.length
                                ? extra.join(" · ")
                                : "sans supplément"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
                <p className="mt-8 text-[15px]" aria-live="polite">
                  Total :{" "}
                  <strong className="tabular-nums">
                    {euros(total!.priceCents)}
                  </strong>{" "}
                  · {minutes(total!.durationMinutes)}
                </p>
              </motion.div>
            ) : stage === "contact" ? (
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
                  onClick={() => setStage("slot")}
                  className="mt-2 cursor-pointer text-left"
                >
                  <Note className="opacity-70">{service.name} · changer</Note>
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
                  onClick={() =>
                    setStage(service.options.length ? "options" : "service")
                  }
                  className="mt-2 cursor-pointer text-left"
                >
                  <Note className="opacity-70">
                    {service.options.length
                      ? "Options · changer"
                      : "Soin · changer"}
                  </Note>
                  <Display className="mt-1 block text-[36px] leading-none [overflow-wrap:anywhere]">
                    {service.name}
                  </Display>
                  <Note className="mt-2 block opacity-80">
                    {minutes(total!.durationMinutes)} ·{" "}
                    {euros(total!.priceCents)}
                  </Note>
                </button>
                <p className="mt-8 text-[15px] font-medium">Jour</p>
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
                <p className="mt-8 text-[15px] font-medium">Heure</p>
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

        {!done && service && stage !== "service" ? (
          <div className="border-t border-current/10 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]">
            {stage === "contact" ? (
              <button
                type="submit"
                form="lab-contact"
                className={primary}
                style={primaryStyle}
              >
                Confirmer · {euros(total!.priceCents)}
              </button>
            ) : stage === "options" ? (
              <button
                type="button"
                onClick={() => setStage("slot")}
                className={primary}
                style={primaryStyle}
              >
                Continuer · {euros(total!.priceCents)}
              </button>
            ) : (
              <button
                type="button"
                disabled={!time}
                onClick={() => setStage("contact")}
                className={primary}
                style={primaryStyle}
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
      <label htmlFor={id} className="text-[15px] font-medium">
        {label}
      </label>
      {children}
      {error ? <p className="text-[14px] text-[#B3261E]">{error}</p> : null}
    </div>
  );
}
