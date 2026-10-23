// Prototype photos: Unsplash CDN, cropped and compressed by their service.
// In the product, every photo is the professional's own upload.

export const photo = (id: string, width: number) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${width}&q=72`;

export const srcSet = (id: string) =>
  [480, 828, 1200].map((width) => `${photo(id, width)} ${width}w`).join(", ");

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
