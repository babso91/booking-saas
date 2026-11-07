import { createContext, useContext } from "react";

import type { PhotoSource, PhotoWidth } from "../engine/engine";

// Photos in her studio (docs/SITE_PUBLISHING_CONTRACT.md § 8, § 10).
//
// - Hers: an asset id, served to her by the members' preview route (never
//   a URL in her configuration).
// - Demo photos of the universes: only to show what a universe looks like
//   in her studio's preview. Their ids say so ("demo:"); they are never
//   saved in her draft nor published (savedConfigOf drops them).

const DEMO = "demo:";

export const isDemo = (id: string | null | undefined) =>
  typeof id === "string" && id.startsWith(DEMO);

/** A demo photo's id (an Unsplash photo of the lab's universes). */
export const demo = (unsplashId: string) => `${DEMO}${unsplashId}`;

/** Where a photo of her studio's preview is served. */
export function studioPhoto(id: string, width: PhotoWidth) {
  if (isDemo(id))
    return `https://images.unsplash.com/photo-${id.slice(DEMO.length)}?auto=format&fit=crop&w=${width}&q=72`;
  return `/api/sites/photos/${encodeURIComponent(id)}/${width}`;
}

/**
 * What her file picker accepts. Not HEIC: the server cannot decode it, and
 * iOS converts a HEIC photo to JPEG when the picker does not accept it.
 */
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Why a photo could not be added or removed, in her words. */
export function photoErrorText(code: string): string {
  switch (code) {
    case "site_photo_unsupported":
      return "Ce fichier n’est pas une photo JPEG, PNG ou WebP. Depuis un iPhone, choisis-la dans ta photothèque : elle sera convertie.";
    case "site_photo_too_large":
      return "Cette photo est trop lourde (10 Mo au plus).";
    case "site_photo_invalid":
      return "Cette photo est trop petite (320 px au moins de côté) ou trop allongée.";
    case "site_photo_revoked":
      return "Cette photo a été retirée : elle ne peut plus être utilisée.";
    case "site_photo_not_found":
      return "La photo n’est pas encore arrivée. Réessaie dans un instant.";
    case "site_photo_cleanup_pending":
      return "C’est enregistré, mais des fichiers de la photo n’ont pas encore pu être supprimés. Réessaie : leur suppression reprendra.";
    case "site_asset_in_use":
      return "Cette photo est utilisée par ton brouillon ou par une version publiée : retire-la d’abord, ou retire-la définitivement.";
    case "rate_limited":
      return "Trop de photos envoyées d’un coup. Réessaie un peu plus tard.";
    case "network":
      return "La connexion s’est interrompue. Réessaie.";
    case "validation_error":
      return "Ce fichier ne peut pas être envoyé (JPEG, PNG ou WebP, 10 Mo au plus).";
    default:
      return "La photo n’a pas pu être enregistrée. Réessaie.";
  }
}

/**
 * Where her studio's panel shows her photos: the same place as its preview
 * (a design preview's in-memory server keeps them elsewhere).
 */
export const StudioPhotos = createContext<PhotoSource>(studioPhoto);
export const useStudioPhoto = () => useContext(StudioPhotos);
