// Prototype photos: Unsplash CDN, cropped and compressed by their service.
// In the product, every photo is the professional's own upload.

// A photo id is either an Unsplash id, or a local object URL ("blob:…")
// for a photo the professional picked from her own phone in the lab: it
// stays in this tab's memory, nothing is uploaded.

export const isLocal = (id: string) => id.startsWith("blob:");

/** Her own photos of this tab, until released. */
const local = new Set<string>();

/** A photo she picked from her phone: kept in this tab's memory only. */
export function localPhoto(file: Blob) {
  const id = URL.createObjectURL(file);
  local.add(id);
  return id;
}

/**
 * Frees her photos that nothing refers to any more (not the draft, not
 * the published version, not a step "Annuler" or "Rétablir" can reach):
 * the browser releases the file. A photo still reachable is kept.
 */
export function releaseLocalPhotos(referenced: Set<string>) {
  for (const id of local) {
    if (referenced.has(id)) continue;
    URL.revokeObjectURL(id);
    local.delete(id);
  }
}

export const photo = (id: string, width: number) =>
  isLocal(id)
    ? id
    : `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}&q=72`;

export const srcSet = (id: string) =>
  isLocal(id)
    ? undefined
    : [480, 828, 1200]
        .map((width) => `${photo(id, width)} ${width}w`)
        .join(", ");

/** What a professional could pick from in the lab (stands in for uploads). */
export const photoPool = [
  "1548902378-2ec44c906391",
  "1639629509821-c54cdd984227",
  "1589710751893-f9a6770ad71b",
  "1567629307995-b9f33097bd30",
  "1674049406467-824ea37c7184",
  "1674049406179-d7bf2c263e71",
  "1777262080995-da4a45f51af8",
  "1772236617396-2f8460293c07",
  "1772235616130-b80e12f0ab7a",
  "1770999086860-143f54adf01b",
  "1604654894610-df63bc536371",
  "1777287216954-2b4b22bb6bf2",
  "1770210257340-dc2b0f44642a",
  "1777288390469-828f8816231c",
  "1754799670312-8e7da8e40ad7",
  "1607779097040-26e80aa78e66",
  "1632345031435-8727f6897d53",
  "1619607146034-5a05296c8f9a",
];
