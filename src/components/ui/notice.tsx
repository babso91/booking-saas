import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { AlertIcon, CheckIcon, InfoIcon, WifiOffIcon } from "./icons";

type NoticeTone = "info" | "error" | "success" | "warning" | "offline";

const tones: Record<NoticeTone, { box: string; icon: ReactNode }> = {
  info: {
    box: "bg-sand/70 text-ink-soft border-line",
    icon: <InfoIcon size={18} />,
  },
  error: {
    box: "bg-danger-soft/70 text-[#7a2f23] border-danger/15",
    icon: <AlertIcon size={18} />,
  },
  warning: {
    box: "bg-warning-soft text-[#6b4613] border-warning/15",
    icon: <AlertIcon size={18} />,
  },
  offline: {
    box: "bg-sand/80 text-ink-soft border-line",
    icon: <WifiOffIcon size={18} />,
  },
  success: {
    box: "bg-success-soft text-[#2c4f38] border-success/15",
    icon: <CheckIcon size={18} />,
  },
};

/**
 * Compact inline message. Errors use role="alert" so they are announced once
 * when they appear; everything else is a polite status.
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const config = tones[tone];

  return (
    <div
      role={tone === "error" || tone === "offline" ? "alert" : "status"}
      className={cn(
        "flex animate-message items-start gap-3 rounded-2xl border px-4 py-3.5 text-[14px] leading-snug",
        config.box,
        className,
      )}
    >
      <span className="mt-px shrink-0">{config.icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="opacity-90">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
