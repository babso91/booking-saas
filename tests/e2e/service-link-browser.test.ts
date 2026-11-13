import { describe, expect, it } from "vitest";

import { capture } from "./support/capture";
import { signedInPage } from "./support/ecrin";
import { APP, Browser, db, professionalWithVisit } from "./support/studio";

// A link to one service (/b/[slug]?prestation=<id>), on the real page: the
// booking opens on that service; a service no longer bookable online shows
// her current catalogue and says so; another business's service is never
// reached by its id.

describe("a link to one service", () => {
  it("opens the booking on it; a hidden or foreign one shows the catalogue and says so", async () => {
    const pro = await professionalWithVisit("Anaïs", "Lou");
    const other = await professionalWithVisit("Bérénice", "Zoé");
    const read = async (businessId: string) => {
      const { rows } = await db.query<{ slug: string; service: string }>(
        `select b.slug, s.id as service
           from public.businesses b
           join public.services s on s.business_id = b.id
          where b.id = $1`,
        [businessId],
      );
      return rows[0]!;
    };
    const mine = await read(pro.businessId);
    const theirs = await read(other.businessId);
    const { page, errors } = await signedInPage(new Browser(), {
      appearance: null,
      width: 390,
      height: 860,
      phone: true,
    });

    // Her own, bookable: straight to its slots.
    await page.goto(`${APP}/b/${mine.slug}?prestation=${mine.service}`);
    await page
      .getByRole("heading", { name: "Choisissez un créneau" })
      .waitFor();
    await capture(page, "service link opened");

    // Another business's service id: her catalogue, never that service.
    await page.goto(`${APP}/b/${mine.slug}?prestation=${theirs.service}`);
    await page
      .getByRole("heading", { name: "Choisissez une prestation" })
      .waitFor();
    await page.getByText("Cette prestation n’est plus proposée").waitFor();
    await capture(page, "service link gone");

    // Deactivated since the link was shared: the same.
    await db.query("update public.services set active = false where id = $1", [
      mine.service,
    ]);
    await page.goto(`${APP}/b/${mine.slug}?prestation=${mine.service}`);
    await page.getByText("Cette prestation n’est plus proposée").waitFor();

    expect(errors).toEqual([]);
  });
});
