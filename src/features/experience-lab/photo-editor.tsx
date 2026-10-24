"use client";

import { motion } from "motion/react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { Focal, PhotoSlot } from "./engine/config";
import { photo, photoPool } from "./photos";

// The photo editor of the studio. The whole photo is shown, and she
// drags a target onto what must stay visible (the eye, the nail, the
// gaze). Three live crops show the photo the way her compositions will:
// a portrait, an arch, a band. Arrows move the target from the keyboard.
// "Depuis mon téléphone" uses a photo of her own, kept in this tab only.

const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

export function PhotoEditor({
  slot,
  id,
  focal,
  onFocal,
  onReplace,
  onBack,
}: {
  slot: PhotoSlot;
  id: string;
  focal: Focal;
  onFocal: (focal: Focal) => void;
  onReplace: (id: string) => void;
  onBack: () => void;
}) {
  const pad = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);

  function place(event: PointerEvent<HTMLDivElement>) {
    const box = pad.current?.getBoundingClientRect();
    if (!box) return;
    onFocal({
      x: clamp(((event.clientX - box.left) / box.width) * 100),
      y: clamp(((event.clientY - box.top) / box.height) * 100),
    });
  }

  function nudge(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 10 : 2;
    const moves: Record<string, Focal> = {
      ArrowLeft: { x: focal.x - step, y: focal.y },
      ArrowRight: { x: focal.x + step, y: focal.y },
      ArrowUp: { x: focal.x, y: focal.y - step },
      ArrowDown: { x: focal.x, y: focal.y + step },
    };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    onFocal({ x: clamp(next.x), y: clamp(next.y) });
  }

  const position = `${focal.x}% ${focal.y}%`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 flex h-11 cursor-pointer items-center gap-1 rounded-full px-2 text-[14px] font-medium"
        >
          ← Réglages
        </button>
        <span className="text-[14px] font-semibold">
          {slot === "cover"
            ? "Photo de couverture"
            : slot === "portrait"
              ? "Ton portrait"
              : `Réalisation ${slot + 1}`}
        </span>
      </div>

      <p className="text-[13.5px] leading-snug text-black/60">
        Glisse la cible sur ce qui doit toujours rester visible : l’œil,
        l’ongle, le regard.
      </p>

      <div className="flex justify-center rounded-2xl bg-[#ECECE8] p-2">
        <div
          ref={pad}
          role="slider"
          tabIndex={0}
          aria-label="Point focal de la photo"
          aria-valuetext={`${focal.x} % depuis la gauche, ${focal.y} % depuis le haut`}
          aria-valuenow={focal.x}
          aria-valuemin={0}
          aria-valuemax={100}
          onKeyDown={nudge}
          onPointerDown={(event) => {
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              // An already released pointer: the drag still follows moves.
            }
            setDragging(true);
            place(event);
          }}
          onPointerMove={(event) => {
            if (dragging) place(event);
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          className="relative inline-block cursor-crosshair touch-none overflow-hidden rounded-xl outline-none select-none focus-visible:ring-3 focus-visible:ring-[#2B3BFF]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo(id, 828)}
            alt=""
            draggable={false}
            className="block max-h-[30dvh] w-auto max-w-full"
          />
          {/* Thirds: where the eye naturally lands. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,transparent_33.2%,rgba(255,255,255,.35)_33.3%,transparent_33.5%,transparent_66.5%,rgba(255,255,255,.35)_66.6%,transparent_66.8%),linear-gradient(0deg,transparent_33.2%,rgba(255,255,255,.35)_33.3%,transparent_33.5%,transparent_66.5%,rgba(255,255,255,.35)_66.6%,transparent_66.8%)]"
          />
          <motion.span
            aria-hidden="true"
            className="pointer-events-none absolute flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[3px] border-white shadow-[0_0_0_2px_rgba(0,0,0,.35),0_8px_20px_rgba(0,0,0,.35)]"
            animate={{
              left: `${focal.x}%`,
              top: `${focal.y}%`,
              scale: dragging ? 1.18 : 1,
            }}
            transition={{
              type: "spring",
              stiffness: 600,
              damping: 38,
              mass: 0.6,
            }}
          >
            <span className="size-2.5 rounded-full bg-white shadow-[0_0_0_2px_rgba(0,0,0,.35)]" />
          </motion.span>
        </div>
      </div>

      <div>
        <p className="text-[13px] text-black/55">Dans tes compositions</p>
        <div className="mt-2 grid grid-cols-[1fr_1fr_1.6fr] items-end gap-2">
          {[
            { label: "Portrait", className: "aspect-[4/5] rounded-lg" },
            {
              label: "Arche",
              className: "aspect-[3/4] rounded-t-full rounded-b-lg",
            },
            { label: "Bandeau", className: "aspect-[16/10] rounded-lg" },
          ].map((crop) => (
            <figure key={crop.label} className="flex flex-col gap-1">
              <span
                className={`relative block overflow-hidden bg-black/10 ${crop.className}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo(id, 480)}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover transition-[object-position] duration-150"
                  style={{ objectPosition: position }}
                />
              </span>
              <figcaption className="text-center text-[12px] text-black/55">
                {crop.label}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => file.current?.click()}
          className="h-11 cursor-pointer rounded-full bg-[#141414] px-4 text-[14px] font-semibold text-white"
        >
          Depuis mon téléphone
        </button>
        <button
          type="button"
          onClick={() => setPicking((value) => !value)}
          aria-expanded={picking}
          className="h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[14px] font-medium"
        >
          Photos d’exemple
        </button>
        <button
          type="button"
          onClick={() => onFocal({ x: 50, y: 50 })}
          className="h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[14px] font-medium"
        >
          Recentrer
        </button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) onReplace(URL.createObjectURL(picked));
            event.target.value = "";
          }}
        />
      </div>
      <p className="-mt-2 text-[12px] text-black/60">
        Laboratoire : ta photo reste sur ton téléphone, rien n’est envoyé.
      </p>

      {picking ? (
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {photoPool.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onReplace(item)}
              aria-label="Utiliser cette photo"
              aria-pressed={item === id}
              className={`relative aspect-square cursor-pointer overflow-hidden rounded-lg ${item === id ? "ring-3 ring-[#2B3BFF] ring-offset-2" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo(item, 200)}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
