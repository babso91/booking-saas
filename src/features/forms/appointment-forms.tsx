"use client";

import { useMemo } from "react";

import { realVisitFormsActions } from "./real-pro-actions";
import { VisitForms } from "./review/visit-forms";

/** A visit's forms in the agenda's panel, on the real actions. */
export function AppointmentForms({ appointmentId }: { appointmentId: string }) {
  // Stable for this visit: the screen reads again when its actions change.
  const actions = useMemo(
    () => realVisitFormsActions(appointmentId),
    [appointmentId],
  );
  return (
    <section className="border-t border-line pt-6">
      <VisitForms appointmentId={appointmentId} actions={actions} />
    </section>
  );
}
