"use client";

import { useId, type ReactNode } from "react";

import type { AgendaAppointmentDto } from "@/features/agenda/data/agenda";
import { cn } from "@/lib/cn";

import type { TodayModel } from "../client/today-model";
import type { VisitLookId } from "../agenda/visit-look";
import {
  dialArcs,
  dialCentre,
  dialTicks,
  handAngle,
  heldArc,
  pointAt,
  SIZE,
} from "./dial";

// Écrin's dial, the object at the heart of the style: engraved hour marks,
// each visit a capsule on the ring, the hand at now. It only draws: the
// accessible way to every visit is the list beside it (the arcs are a
// pointer shortcut, out of the tab order and hidden from assistive tech).

const strokes: Record<VisitLookId, string> = {
  // The accent, not the raw stone: it reads on the face for any colour.
  now: "var(--accent)",
  ahead: "var(--ink)",
  past: "var(--ink-muted)",
  completed: "var(--success)",
  noShow: "var(--warning)",
  cancelled: "var(--line-strong)",
};

export function EcrinDial({
  model,
  now,
  compact,
  onOpen,
  className,
  children,
}: {
  model: TodayModel;
  now: number | null;
  /** A small dial: ring and capsules only. */
  compact?: boolean;
  onOpen?: (appointment: AgendaAppointmentDto) => void;
  className?: string;
  /** What the dial says, in its centre. */
  children?: ReactNode;
}) {
  const faceId = useId();
  const { span } = model;
  const arcs = dialArcs(model.visits, span, now);
  const hand = model.nowTime === null ? null : handAngle(span, now);
  const handFrom = pointAt(0, 176);
  const handTo = pointAt(0, 246);

  return (
    <div className={cn("relative aspect-square", className)}>
      <svg
        viewBox={`${compact ? 0 : -8} ${compact ? 0 : -8} ${compact ? SIZE : SIZE + 16} ${compact ? SIZE : SIZE + 16}`}
        aria-hidden="true"
        className="absolute inset-0 size-full overflow-visible"
      >
        <defs>
          <radialGradient id={faceId} cx="38%" cy="28%" r="85%">
            <stop offset="0%" stopColor="var(--paper-raised)" />
            <stop offset="100%" stopColor="var(--paper)" />
          </radialGradient>
        </defs>
        <circle
          cx={dialCentre}
          cy={dialCentre}
          r={compact ? 262 : 244}
          fill={`url(#${faceId})`}
          stroke="var(--line)"
          style={{
            filter: compact
              ? undefined
              : "drop-shadow(0 22px 30px rgb(var(--shadow-rgb) / 0.2))",
          }}
        />
        {compact ? null : (
          <>
            <circle
              cx={dialCentre}
              cy={dialCentre}
              r={238}
              fill="none"
              stroke="var(--line)"
            />
            <circle
              cx={dialCentre}
              cy={dialCentre}
              r={176}
              fill="none"
              stroke="var(--line)"
            />
            {dialTicks(model.ticks, span).map((tick) => (
              <g key={tick.at}>
                <line
                  x1={tick.from[0]}
                  y1={tick.from[1]}
                  x2={tick.to[0]}
                  y2={tick.to[1]}
                  stroke="var(--line-strong)"
                />
                {tick.label ? (
                  <text
                    x={tick.labelAt[0]}
                    y={tick.labelAt[1]}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="var(--ink-soft)"
                    style={{ fontSize: 14, fontWeight: 400 }}
                  >
                    {tick.label}
                  </text>
                ) : null}
              </g>
            ))}
          </>
        )}

        {model.pauses.map((pause) => (
          <path
            key={pause.id}
            d={heldArc(span, pause.start, pause.end)}
            fill="none"
            stroke="var(--ink-muted)"
            strokeWidth={compact ? 6 : 2.5}
            strokeDasharray="1 7"
            strokeLinecap="round"
          />
        ))}

        {arcs.map((arc, index) => (
          <path
            key={arc.id}
            d={arc.d}
            fill="none"
            stroke={strokes[arc.look]}
            strokeWidth={compact ? arc.stroke * 1.5 : arc.stroke}
            strokeLinecap="round"
            className={cn(
              "ecrin-arc",
              onOpen &&
                "cursor-pointer transition-[stroke-width] hover:brightness-110",
            )}
            style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
            onClick={onOpen ? () => onOpen(arc.visit.appointment) : undefined}
          />
        ))}

        {hand !== null ? (
          <g
            className="ecrin-hand"
            style={{
              transform: `rotate(${hand}deg)`,
              transformOrigin: `${dialCentre}px ${dialCentre}px`,
            }}
          >
            <line
              x1={handFrom[0]}
              y1={handFrom[1]}
              x2={handTo[0]}
              y2={handTo[1]}
              stroke="var(--accent)"
              strokeWidth={compact ? 8 : 2.5}
              strokeLinecap="round"
            />
            <circle
              cx={handTo[0]}
              cy={handTo[1]}
              r={compact ? 16 : 7}
              fill="var(--accent)"
              stroke="var(--paper-raised)"
              strokeWidth={3}
            />
          </g>
        ) : null}
      </svg>
      {children ? (
        <div className="absolute inset-[21%] flex flex-col items-center justify-center gap-1 text-center">
          {children}
        </div>
      ) : null}
    </div>
  );
}
