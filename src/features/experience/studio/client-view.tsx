"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ShowcaseGroup } from "../catalog/model";
import type { SiteConfig } from "../engine/config";
import type { UsualHours } from "../practical";
import type { ReviewPage } from "@/features/reviews/model";

import {
  CLIENT_VIEW_PATH,
  FRAME_READY,
  FRAME_SHOW,
  fromOwnWindow,
  type FrameShow,
} from "./client-view-protocol";

const DEVICES = {
  phone: { label: "Téléphone", width: 390, height: 844 },
  desktop: { label: "Ordinateur", width: 1280, height: 800 },
} as const;
type Device = keyof typeof DEVICES;

/**
 * « Comme mes clientes » (Higani points 122, 123): her page as her
 * clients will see it, on a phone or a computer, with her real services,
 * hours and photos, in a frame of the real width (its own layout, not a
 * narrowed one). She can walk her whole page and booking: the booking
 * stops before anything is booked. It follows her edits as she makes them.
 */
export function ClientView({
  config,
  catalog,
  hours,
  reviews,
  what,
  onClose,
}: {
  config: SiteConfig;
  catalog: ShowcaseGroup[];
  hours: UsualHours[] | null;
  reviews: ReviewPage | null;
  /** What is shown: her draft or her page online. */
  what: string;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [device, setDevice] = useState<Device>("phone");
  const [space, setSpace] = useState({ width: 0, height: 0 });

  const send = useCallback(() => {
    const message: FrameShow = {
      type: FRAME_SHOW,
      config,
      catalog,
      hours,
      reviews,
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [config, catalog, hours, reviews]);

  // Ready, the frame asks; then each edit is sent as she makes it.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (fromOwnWindow(event, frame.current?.contentWindow, FRAME_READY))
        send();
    };
    window.addEventListener("message", onMessage);
    send();
    return () => window.removeEventListener("message", onMessage);
  }, [send]);

  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () =>
      setSpace({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const size = DEVICES[device];
  const scale =
    space.width && space.height
      ? Math.min(
          1,
          (space.width - 24) / size.width,
          (space.height - 24) / size.height,
        )
      : 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Comme mes clientes"
      className="fixed inset-0 z-[80] flex flex-col bg-[#1B1B1A] text-white"
      style={{ fontFamily: "var(--font-lab-sans)" }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">Comme mes clientes</p>
          <p className="text-[12.5px] leading-snug text-white/65">
            {what}, avec tes vraies prestations. Tu peux tout essayer : rien
            n’est réservé.
          </p>
        </div>
        <div
          role="group"
          aria-label="Appareil"
          className="flex rounded-full bg-white/10 p-1"
        >
          {(Object.keys(DEVICES) as Device[]).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={device === id}
              onClick={() => setDevice(id)}
              className={`h-9 cursor-pointer rounded-full px-3 text-[13px] font-semibold ${device === id ? "bg-white text-[#141414]" : "text-white/75"}`}
            >
              {DEVICES[id].label}
            </button>
          ))}
        </div>
        <button
          ref={close}
          type="button"
          onClick={onClose}
          className="h-11 cursor-pointer rounded-full px-4 text-[14px] font-semibold ring-1 ring-white/30 hover:bg-white/10"
        >
          Fermer
        </button>
      </div>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[18px] bg-white shadow-[0_30px_80px_-30px_rgba(0,0,0,.8)]"
          style={{ width: size.width * scale, height: size.height * scale }}
        >
          <iframe
            ref={frame}
            src={CLIENT_VIEW_PATH}
            title={`Ta page, sur ${device === "phone" ? "un téléphone" : "un ordinateur"}`}
            onLoad={send}
            className="origin-top-left border-0"
            style={{
              width: size.width,
              height: size.height,
              transform: `scale(${scale})`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
