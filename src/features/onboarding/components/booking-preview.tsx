import {
  CalendarIcon,
  ClockIcon,
  LockIcon,
  PinIcon,
} from "@/components/ui/icons";
import { bookingHost } from "@/lib/brand";
import { cn } from "@/lib/cn";

import { initials, type OnboardingDraft } from "../draft";
import { formatHorizon, formatNotice } from "../settings";

type Focus = "identity" | "link" | "preferences" | "details" | "done";

/**
 * Live phone preview of the future public booking page. It reacts to every
 * keystroke so the professional sees her space taking shape.
 */
export function BookingPreview({
  draft,
  focus,
}: {
  draft: OnboardingDraft;
  focus: Focus;
}) {
  const name = draft.businessName.trim();
  const owner = [draft.firstName.trim(), draft.lastName.trim()]
    .filter(Boolean)
    .join(" ");
  const highlight = (area: Focus) =>
    focus === area
      ? "ring-2 ring-accent/35 ring-offset-2 ring-offset-paper-raised"
      : "ring-0 ring-transparent";

  return (
    <div className="relative w-[300px] rounded-[46px] bg-ink p-2.5 shadow-[0_50px_90px_-40px_rgba(35,28,24,0.55)] xl:w-[320px]">
      <div className="relative flex h-[600px] flex-col overflow-hidden rounded-[38px] bg-paper-raised xl:h-[640px]">
        <div className="flex justify-center pt-2.5">
          <span className="h-[22px] w-[92px] rounded-full bg-ink" />
        </div>

        <div
          className={cn(
            "mx-4 mt-3 flex items-center gap-1.5 rounded-full bg-sand px-3 py-2 text-[11.5px] text-ink-soft transition-shadow duration-300",
            highlight("link"),
          )}
        >
          <LockIcon size={12} />
          <span className="truncate">
            {bookingHost()}/b/
            <span
              className={cn(
                "font-semibold",
                draft.slug ? "text-ink" : "text-ink-muted",
              )}
            >
              {draft.slug || "ton-lien"}
            </span>
          </span>
        </div>

        <div className="relative mx-4 mt-3 h-24 shrink-0 overflow-hidden rounded-3xl bg-[linear-gradient(135deg,#e9d6c8,#f3e6dc_45%,#dcc5b3)]">
          <div className="absolute -right-6 -bottom-10 size-32 rounded-full bg-white/40" />
          <div className="absolute top-4 left-6 size-12 rounded-full bg-accent/15" />
        </div>

        <div className="relative -mt-9 flex flex-col items-center px-6 text-center">
          <div
            className={cn(
              "flex size-[72px] items-center justify-center rounded-full border-4 border-paper-raised bg-ink font-display text-[28px] text-paper-raised transition-shadow duration-300",
              highlight("identity"),
            )}
          >
            <span key={initials(name)} className="animate-pop">
              {initials(name)}
            </span>
          </div>
          <p
            key={name ? "named" : "empty"}
            className={cn(
              "mt-3 animate-fade font-display text-[26px] leading-tight",
              name ? "text-ink" : "text-ink-muted/60",
            )}
          >
            {name || "Ton activité"}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            {owner ? `par ${owner}` : "par toi"}
            {draft.location.trim() ? (
              <span className="inline-flex items-center gap-0.5">
                {" · "}
                <PinIcon size={11} /> {draft.location.trim()}
              </span>
            ) : null}
          </p>
          <p
            className={cn(
              "mt-3 line-clamp-3 min-h-[3.6em] rounded-lg text-[12.5px] leading-[1.45] transition-shadow duration-300",
              draft.description.trim() ? "text-ink-soft" : "text-ink-muted/50",
              highlight("details"),
            )}
          >
            {draft.description.trim() ||
              "Une courte présentation de ton univers apparaîtra ici."}
          </p>
        </div>

        <div
          className={cn(
            "mx-4 mt-3 flex flex-wrap justify-center gap-1.5 rounded-2xl p-1 transition-shadow duration-300",
            highlight("preferences"),
          )}
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-sand px-2.5 py-1 text-[11px] text-ink-soft">
            <CalendarIcon size={12} />{" "}
            {formatHorizon(draft.maximumBookingAdvanceDays)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-sand px-2.5 py-1 text-[11px] text-ink-soft">
            <ClockIcon size={12} />{" "}
            {formatNotice(draft.minimumBookingNoticeMinutes).replace(
              "jusqu’à ",
              "",
            )}
          </span>
        </div>

        <div className="mx-4 mt-4 flex flex-col gap-2">
          <p className="px-1 text-[11px] font-semibold tracking-[0.14em] text-ink-muted uppercase">
            Prestations
          </p>
          {[68, 52, 60].map((width, index) => (
            <div
              key={index}
              className="flex items-center justify-between rounded-2xl border border-line/80 px-3.5 py-3"
            >
              <span className="flex flex-col gap-1.5">
                <span
                  className="h-2 rounded-full bg-sand-deep"
                  style={{ width }}
                />
                <span className="h-1.5 w-8 rounded-full bg-sand" />
              </span>
              <span className="h-2 w-7 rounded-full bg-sand-deep" />
            </div>
          ))}
        </div>

        <div className="mt-auto p-4">
          <div className="flex h-11 items-center justify-center rounded-full bg-ink text-[13px] font-medium text-paper-raised">
            Prendre rendez-vous
          </div>
        </div>
      </div>
    </div>
  );
}
