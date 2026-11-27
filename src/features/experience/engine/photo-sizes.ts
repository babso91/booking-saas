/**
 * A photo's `sizes`, drawn at most at twice its size: a 3x phone takes the
 * 2x file, the same to the eye and about half the bytes (Higani point 200:
 * a gallery that loads fast on a phone). Each entry gets a twin for dense
 * screens, at two thirds of its length; a browser without `resolution`
 * skips the twins and keeps the entries as they were.
 */
export function atMostTwice(sizes: string) {
  const dense = sizes.split(",").map((entry) => {
    const part = entry.trim();
    const media = /^(\(.*\))\s+(\S.*)$/.exec(part);
    const length = media ? media[2] : part;
    const when = media
      ? `(min-resolution: 2.5dppx) and ${media[1]}`
      : "(min-resolution: 2.5dppx)";
    return `${when} calc(${length} * 2 / 3)`;
  });
  return [...dense, sizes].join(", ");
}
