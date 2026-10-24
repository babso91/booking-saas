"use client";

import { useMemo, useState } from "react";

import type { SiteConfig } from "../engine/config";
import { contrast, cssVariables } from "../engine/tokens";
import { qrSvg } from "./qr";

// "Partager": her link and her QR code, the two ways customers reach her
// mini-site (a bio, a message, a card on the counter). Everything happens
// in the browser: the code is drawn here (share/qr.ts), nothing is sent.
// The lab keeps everything in this tab's memory, on purpose (the real
// publication comes with the SaaS): so the panel says plainly what the link
// is here, a temporary demo of the universe shown, opening on its starting
// content; her changes in this tab do not travel with it, and no real
// booking or email follows from it. In the product it is her own address.

/**
 * The lab's public address of the universe shown (with the trade, if
 * any): never the lab's access key, nothing else from the address.
 */
export function siteLink(
  location: { origin: string; search: string },
  design: string,
) {
  const pro = new URLSearchParams(location.search).get("pro");
  return `${location.origin}/labo/${encodeURIComponent(design)}${pro ? `?pro=${encodeURIComponent(pro)}` : ""}`;
}

/**
 * Her colours when they scan reliably (dark on light, strong contrast),
 * black on white otherwise: a code must read first.
 */
function codeColours(palette: SiteConfig["tokens"]["palette"]) {
  const ink = palette.inkOnPaper;
  const paper = palette.paper;
  const darkOnLight = contrast(ink, "#000000") < contrast(paper, "#000000");
  return darkOnLight && contrast(ink, paper) >= 7
    ? { dark: ink, light: paper }
    : { dark: "#000000", light: "#FFFFFF" };
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The SVG drawn on a canvas, for a PNG her phone can post or print. */
async function png(svg: string, size: number) {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0, size, size);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("png"))),
      "image/png",
    ),
  );
}

export function SharePanel({
  config,
  design,
}: {
  config: SiteConfig;
  /** The universe shown: the demo the link opens. */
  design: string;
}) {
  const link =
    typeof window === "undefined" ? "" : siteLink(window.location, design);
  const [status, setStatus] = useState<string | null>(null);
  const colours = codeColours(config.tokens.palette);
  const svg = useMemo(
    () => qrSvg(link, { dark: colours.dark, light: colours.light }),
    [link, colours.dark, colours.light],
  );
  const file = config.brand.name
    .normalize("NFD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  const say = (text: string) => {
    setStatus(text);
    window.setTimeout(
      () => setStatus((now) => (now === text ? null : now)),
      3000,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="Démonstration temporaire"
        className="flex flex-col gap-1.5 rounded-2xl bg-[#FFF4D6] p-3 text-[13.5px] leading-snug text-[#5C4300]"
      >
        <p className="font-semibold">Démonstration temporaire du laboratoire</p>
        <p>
          Ce lien ouvre la démo de cet univers, avec son contenu de départ. Tes
          personnalisations de cet onglet ne sont pas transmises à la personne
          qui l’ouvre : elles restent ici, et disparaissent quand tu fermes
          l’onglet.
        </p>
        <p>
          Aucune réservation réelle, aucun email : la réservation y est simulée.
          Dans le produit, ce sera ton adresse, avec ton site publié.
        </p>
      </section>

      <div className="flex flex-col gap-2 rounded-2xl border border-black/10 bg-white p-3">
        <label
          className="text-[13px] font-medium text-black/65"
          htmlFor="lab-share-link"
        >
          Ton lien
        </label>
        <input
          id="lab-share-link"
          readOnly
          value={link}
          onFocus={(event) => event.target.select()}
          className="h-12 w-full rounded-xl border border-black/12 bg-black/[0.03] px-3 text-[15px] outline-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                say("Lien copié");
              } catch {
                say("Copie impossible : sélectionne le lien et copie-le");
              }
            }}
            className="h-11 flex-1 cursor-pointer rounded-full bg-[#141414] text-[14px] font-semibold text-white"
          >
            Copier le lien
          </button>
          {canShare ? (
            <button
              type="button"
              onClick={() =>
                navigator
                  .share({ title: config.brand.name, url: link })
                  .catch(() => undefined)
              }
              className="h-11 flex-1 cursor-pointer rounded-full bg-black/5 text-[14px] font-semibold"
            >
              Partager…
            </button>
          ) : null}
        </div>
        <p role="status" className="min-h-5 text-[13px] text-[#14532D]">
          {status}
        </p>
      </div>

      {svg ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-black/10 bg-white p-3">
          <p className="text-[14px] font-medium">Ton QR code</p>
          {/* Her card, in her universe: what she would put on the counter. */}
          <figure
            className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-3 p-5"
            style={{
              ...cssVariables(config.tokens),
              background: colours.light,
              color: colours.dark,
              borderRadius: "max(var(--s-radius), 16px)",
              boxShadow: "0 12px 30px -18px rgba(0,0,0,.45)",
            }}
          >
            <span
              className="text-center text-[24px] leading-none"
              style={{
                fontFamily: "var(--t-display)",
                fontWeight: "var(--t-display-weight)" as unknown as number,
                textTransform: "var(--t-display-case)" as "none",
                letterSpacing: "var(--t-display-tracking)",
              }}
            >
              {config.brand.name}
            </span>
            <span
              role="img"
              aria-label={`QR code menant à ${link}`}
              className="block aspect-square w-full"
              // Built locally from her link (share/qr.ts): no outside markup.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <figcaption
              className="text-[13px]"
              style={{ fontFamily: "var(--t-body)" }}
            >
              Démo · réservation simulée
            </figcaption>
          </figure>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  download(`qr-${file}.png`, await png(svg, 1200));
                } catch {
                  say("Téléchargement impossible sur ce navigateur");
                }
              }}
              className="h-11 flex-1 cursor-pointer rounded-full bg-black/5 text-[14px] font-medium"
            >
              Image PNG
            </button>
            <button
              type="button"
              onClick={() =>
                download(
                  `qr-${file}.svg`,
                  new Blob([svg], { type: "image/svg+xml" }),
                )
              }
              className="h-11 flex-1 cursor-pointer rounded-full bg-black/5 text-[14px] font-medium"
            >
              Vectoriel SVG
            </button>
          </div>
          <p className="text-[12.5px] leading-snug text-black/60">
            Dessiné ici, sur ton appareil : rien n’est envoyé. Ses couleurs sont
            celles de ton site quand elles se scannent bien, sinon noir sur
            blanc.
          </p>
        </div>
      ) : null}
    </div>
  );
}
