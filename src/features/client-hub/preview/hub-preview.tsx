"use client";

import { useState, useSyncExternalStore } from "react";

import { HubAppointmentDetail } from "../components/appointment-detail";
import { HubRoot } from "../components/hub-shell";
import {
  PREVIEW_APPOINTMENT,
  PREVIEW_BUSINESS,
  installFakeHub,
  type PreviewScenario,
} from "./fake-hub";

const noop = () => () => {};

/**
 * Her appointment's page as it really is, on fictional data: the hub's own
 * components, with the fake routes installed before they read anything
 * (in the browser only: nothing is rendered on the server).
 */
export function HubPreview({ scenario }: { scenario: PreviewScenario }) {
  const inBrowser = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  return inBrowser ? <Installed key={scenario} scenario={scenario} /> : null;
}

function Installed({ scenario }: { scenario: PreviewScenario }) {
  // Installed while rendering, before the hub's first read. It stays for
  // the life of this document (it only answers /api/client-hub/ paths): an
  // effect's cleanup would remove it under React's development double
  // mount, and the hub would then read the real routes.
  useState(() => installFakeHub(scenario));
  return (
    <HubRoot>
      <HubAppointmentDetail
        businessId={PREVIEW_BUSINESS}
        appointmentId={PREVIEW_APPOINTMENT}
      />
    </HubRoot>
  );
}
