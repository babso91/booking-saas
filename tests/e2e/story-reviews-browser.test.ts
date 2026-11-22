import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";
import {
  dateInDays,
  everyDay,
  setWeeklyHours,
} from "../integration/support/fixtures";
import { call, launchBrowser } from "./support/browser";
import { HUB_URL, startIngress } from "./support/hub-ingress";
import { APP, db, professionalWithVisit } from "./support/studio";

const env = inject("e2e");
let browser: Browser;
let ingress: Awaited<ReturnType<typeof startIngress>>;
beforeAll(async () => {
  ingress = await startIngress(env.hubProxySecret);
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await ingress?.stop();
});

async function saveImage(page: Page, name: string) {
  const link = page.getByRole("link", { name: "Télécharger l’image" });
  const [dl] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const path = "test-results/screens/" + name + ".png";
  mkdirSync("test-results/screens", { recursive: true });
  await dl.saveAs(path);
  const bytes = readFileSync(path);
  expect(await sharp(bytes).metadata()).toMatchObject({
    format: "png",
    width: 1080,
    height: 1920,
  });
  return bytes;
}

it("exports the month, removes a booked start from the PNG, then accepts one verified review after the visit", async () => {
  const pro = await professionalWithVisit("Iris", "Lou");
  const slug = pro.clientEmail.split("@")[0]!;
  await setWeeklyHours(
    pro.businessId,
    everyDay(["10:00", "11:15"], ["18:00", "19:15"]),
  );
  const phone = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    locale: "fr-FR",
  };
  const staff = await browser.newContext(phone),
    guest = await browser.newContext(phone);
  try {
    await staff.addCookies(
      [...pro.browser.cookies].map(([name, value]) => ({
        name,
        value,
        url: APP,
      })),
    );
    const agenda = await staff.newPage(),
      site = await guest.newPage();
    const date = dateInDays(10),
      month = date.slice(0, 7);
    await agenda.goto(APP + "/app?date=" + date);
    await agenda.getByRole("button", { name: "Partager mon planning" }).click();
    const input = agenda.getByLabel("Mois à partager");
    await input.fill(month);
    const before = await saveImage(agenda, "planning-story-avant");
    await site.goto(HUB_URL + "/b/" + slug + "#avis");
    const publicBusiness = await call(
      site,
      "GET",
      "/api/public/businesses/" + slug,
    );
    const id = (publicBusiness.body!.data!.services as { id: string }[])[0]!.id;
    const availability =
      "/api/public/businesses/" +
      slug +
      "/availability?serviceId=" +
      id +
      "&date=" +
      date;
    const slots = (await call(site, "GET", availability)).body!.data!.slots as {
      localStartsAt: string;
      startsAt: string;
    }[];
    expect(slots.map((s) => s.localStartsAt.slice(11, 16))).toEqual([
      "10:00",
      "18:00",
    ]);
    const email = "iris-" + randomUUID().slice(0, 8) + "@client.test";
    const booked = await call(site, "POST", "/api/bookings", {
      slug,
      serviceId: id,
      startsAt: slots[0]!.startsAt,
      email,
      firstName: "Visite",
      requestId: randomUUID(),
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const appt = (booked.body!.data!.booking as { appointmentId: string })
      .appointmentId;
    await agenda
      .getByRole("button", { name: "Actualiser les disponibilités" })
      .click();
    const after = await saveImage(agenda, "planning-story-apres");
    expect(
      (
        (await call(site, "GET", availability)).body!.data!.slots as {
          localStartsAt: string;
        }[]
      ).map((s) => s.localStartsAt.slice(11, 16)),
    ).toEqual(["18:00"]);
    // Compare the actual calendar pixels only, independently of the timestamp.
    const calendar = { left: 50, top: 430, width: 980, height: 1010 };
    const beforePixels = await sharp(before).extract(calendar).raw().toBuffer();
    expect(
      beforePixels.equals(
        await sharp(after).extract(calendar).raw().toBuffer(),
      ),
    ).toBe(false);

    const leave = site.getByRole("button", { name: "Laisser un avis" });
    await leave.click();
    await site
      .getByRole("link", { name: "Vérifier mon adresse e-mail" })
      .click();
    await site.getByLabel("Adresse email").fill(email);
    await site.getByRole("button", { name: "Recevoir mon code" }).click();
    const code = await vi.waitFor(
      async () => {
        const box = await fetch(
          env.mailpitUrl +
            "/api/v1/search?query=" +
            encodeURIComponent('to:"' + email + '"'),
        );
        const list = (await box.json()) as { messages: { Subject: string }[] };
        const subject = list.messages.find((x) =>
          /^\d{8}/.test(x.Subject),
        )?.Subject;
        if (!subject) throw new Error("Code en attente");
        return subject.slice(0, 8);
      },
      { timeout: 15000 },
    );
    await site.getByLabel("Code à 8 chiffres").fill(code);
    await site.waitForURL(HUB_URL + "/b/" + slug + "#avis");
    await leave.click();
    await site.getByText(/Vous pourrez laisser un avis après/).waitFor();
    // Advance only this synthetic visit while retaining its actual sent confirmation.
    await db.query(
      "update public.appointments set starts_at=starts_at-interval '18 days',ends_at=ends_at-interval '18 days' where id=$1",
      [appt],
    );
    await leave.click();
    await site.getByRole("radio", { name: "5 sur 5" }).check();
    await site.getByLabel("Votre commentaire").fill("La pose a bien tenu.");
    await site.getByRole("button", { name: "Publier mon avis" }).click();
    await site.getByText("Merci, votre avis est publié.").waitFor();
    await site.reload();
    await site.getByText("La pose a bien tenu.").waitFor();
    await leave.click();
    await site.getByRole("radio", { name: "4 sur 5" }).check();
    await site.getByRole("button", { name: "Publier mon avis" }).click();
    await site.getByText("★ 4/5").waitFor();
    const summary = await call(
      site,
      "GET",
      "/api/public/businesses/" + slug + "/reviews",
    );
    expect(summary.body!.data).toMatchObject({
      average: 4,
      count: 1,
      reviews: [{ comment: "La pose a bien tenu.", stars: 4 }],
    });
    expect(
      Object.keys((summary.body!.data!.reviews as object[])[0]!).sort(),
    ).toEqual(["comment", "date", "stars"]);
  } finally {
    await staff.close();
    await guest.close();
  }
});
