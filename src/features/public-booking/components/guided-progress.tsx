import type { BookingFlow } from "../client/use-booking-flow";
import { dayLabel, wallTime } from "../client/business-time";

const labels = {
  service: "Prestation",
  options: "Options",
  slot: "Horaire",
  contact: "Coordonnées",
  review: "Vérification",
} as const;

export function GuidedProgress({ flow }: { flow: BookingFlow }) {
  const steps = (Object.keys(labels) as (keyof typeof labels)[]).filter(
    (step) => flow.stepNumber(step) > 0,
  );
  const position = steps.findIndex((step) => step === flow.step);
  return (
    <nav
      aria-label="Étapes de la réservation"
      className="border-b border-line pb-4"
    >
      <ol className="flex gap-1">
        {steps.map((step, index) => (
          <li
            key={step}
            aria-current={step === flow.step ? "step" : undefined}
            className="min-w-0 flex-1"
          >
            {/* Each step's bar fills from its start as she reaches it, and
                empties back when she returns: where she is, seen moving. */}
            <span
              aria-hidden="true"
              className="block h-1 overflow-hidden rounded bg-sand"
            >
              <span
                className={`block h-full origin-left rounded bg-ink motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-[var(--ease-out-soft)] ${
                  index <= position ? "scale-x-100" : "scale-x-0"
                }`}
              />
            </span>
            {index < position ? (
              <button
                type="button"
                disabled={flow.isSending}
                onClick={() => flow.actions.goTo(step)}
                className="min-h-11 w-full text-left text-xs font-medium underline underline-offset-4"
              >
                {labels[step]}
              </button>
            ) : (
              <span className="flex min-h-11 items-center text-xs text-ink-soft">
                {labels[step]}
              </span>
            )}
          </li>
        ))}
      </ol>
      {flow.service && position > 0 ? (
        <p
          key={`${flow.service.id}:${position > steps.indexOf("slot") ? flow.slot?.startsAt : ""}`}
          className="text-sm text-ink-soft motion-safe:animate-message"
        >
          {flow.service.name}
          {flow.slot && position > steps.indexOf("slot")
            ? ` · ${dayLabel(flow.slot.localStartsAt.slice(0, 10))} à ${wallTime(flow.slot.localStartsAt)}`
            : ""}
        </p>
      ) : null}
    </nav>
  );
}
