import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";
import {
  BanIcon,
  CheckIcon,
  ClockIcon,
  UserOffIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/cn";

type Status = AgendaAppointmentDto["status"];

// Status is always given as text + icon, colour only reinforces it.
export const statusMeta: Record<
  Status,
  {
    label: string;
    badge: string;
    text: string;
    card: string;
    icon: typeof CheckIcon;
  }
> = {
  confirmed: {
    label: "Confirmé",
    badge: "bg-accent-soft text-accent-strong",
    text: "text-accent-strong",
    card: "border-l-accent bg-paper-raised",
    icon: ClockIcon,
  },
  completed: {
    label: "Terminé",
    badge: "bg-success-soft text-success",
    text: "text-success-strong",
    card: "border-l-success bg-success-soft/60",
    icon: CheckIcon,
  },
  cancelled: {
    label: "Annulé",
    badge: "bg-sand text-ink-soft",
    text: "text-ink-soft",
    card: "border-l-line-strong bg-sand/50 opacity-75",
    icon: BanIcon,
  },
  no_show: {
    label: "Absente",
    badge: "bg-warning-soft text-warning",
    text: "text-warning-strong",
    card: "border-l-warning bg-warning-soft/60",
    icon: UserOffIcon,
  },
};

export function StatusBadge({
  status,
  compact = false,
  collapsible = false,
  plain = false,
  className,
}: {
  /** Icon and word in the status colour, without a tinted ground. */
  plain?: boolean;
  status: Status;
  compact?: boolean;
  /** In a card: icon only when the card is narrow (the card label keeps the text). */
  collapsible?: boolean;
  className?: string;
}) {
  const meta = statusMeta[status];
  const Icon = meta.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap",
        plain
          ? cn("text-[13.5px] font-semibold", meta.text)
          : compact
            ? "px-1.5 py-0.5 text-[11px]"
            : "px-2.5 py-1 text-[12.5px]",
        !plain && meta.badge,
        className,
      )}
    >
      <Icon size={compact ? 11 : 13} strokeWidth={2} className="shrink-0" />
      <span className={collapsible ? "hidden @[9rem]:inline" : undefined}>
        {meta.label}
      </span>
      {status === "no_show" && !compact ? (
        <span className="sr-only"> (no-show)</span>
      ) : null}
    </span>
  );
}
