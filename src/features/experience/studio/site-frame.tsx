"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { sectionTitle } from "@/features/sites/presentation";
import { ReviewsSection } from "@/features/reviews/reviews-section";

import { MiniSite } from "../mini-site";
import {
  FRAME_READY,
  FRAME_SHOW,
  fromOwnWindow,
  type FrameShow,
} from "./client-view-protocol";
import { studioPhoto } from "./photos";

/**
 * The page inside « Comme mes clientes » (Higani points 122, 123): what
 * her studio sends, drawn as her clients see it (no edit marks), its
 * booking a preview that never books. Only her own studio, from this
 * same site, can send it: anything else is ignored.
 */
export function SiteFrame({
  slug,
  fontClasses,
}: {
  slug: string;
  fontClasses: string;
}) {
  const [shown, setShown] = useState<FrameShow | null>(null);
  const [alone, setAlone] = useState(false);

  useEffect(() => {
    if (window.parent === window) {
      // Opened by itself: nothing to show without her studio.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- known only in the browser
      setAlone(true);
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (fromOwnWindow(event, window.parent, FRAME_SHOW))
        setShown(event.data as FrameShow);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: FRAME_READY }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (alone)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[#141414] p-8 text-center text-white">
        <p className="max-w-sm text-[15px] leading-relaxed text-white/80">
          Cet aperçu s’ouvre depuis ton Studio, avec « Voir comme mes clientes
          ».
        </p>
        <Link href="/app/site" className="font-semibold underline">
          Ouvrir mon Studio
        </Link>
      </main>
    );
  if (!shown)
    return (
      <p
        role="status"
        className="flex min-h-dvh items-center justify-center bg-[#141414] text-[14px] text-white/70"
      >
        Chargement de ta page…
      </p>
    );
  return (
    <MiniSite
      config={shown.config}
      catalog={shown.catalog}
      photoBase="/api/sites/photos"
      photoSource={studioPhoto}
      // A preview: her booking is tried, never taken.
      booking={null}
      previewSlug={slug}
      fontClasses={fontClasses}
      hours={shown.hours}
      reviews={
        <ReviewsSection
          slug={slug}
          initial={shown.reviews}
          readOnly
          title={sectionTitle(
            shown.config.presentation,
            "reviews",
            "Avis des clientes",
          )}
        />
      }
    />
  );
}
