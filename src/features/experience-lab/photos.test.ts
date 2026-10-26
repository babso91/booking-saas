import { afterEach, describe, expect, it, vi } from "vitest";

import { localPhoto, releaseLocalPhotos } from "./photos";

describe("her own photos (blob: URLs)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are released once nothing refers to them, and never while something still can", () => {
    let next = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:lab/${(next += 1)}`,
    );
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const first = localPhoto(new Blob(["a"]));
    const second = localPhoto(new Blob(["b"]));

    // Both still reachable (one in the draft, one an undo away).
    releaseLocalPhotos(new Set([first, second]));
    expect(revoke).not.toHaveBeenCalled();

    // The first is no longer anywhere: released, once.
    releaseLocalPhotos(new Set([second]));
    expect(revoke).toHaveBeenCalledWith(first);
    releaseLocalPhotos(new Set([second]));
    expect(revoke).toHaveBeenCalledTimes(1);

    // The examples (CDN ids) are never touched.
    releaseLocalPhotos(new Set(["1548902378-2ec44c906391"]));
    expect(revoke).toHaveBeenLastCalledWith(second);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("a site releases only its own photos, never another site's", () => {
    let next = 100;
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:lab/${(next += 1)}`,
    );
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const mine = localPhoto(new Blob(["a"]));
    const theirs = localPhoto(new Blob(["b"]));
    // This site goes away: nothing of it is referenced any more.
    releaseLocalPhotos(new Set(), new Set([mine]));
    expect(revoke).toHaveBeenCalledWith(mine);
    expect(revoke).not.toHaveBeenCalledWith(theirs);
    releaseLocalPhotos(new Set(), new Set([theirs]));
  });
});
