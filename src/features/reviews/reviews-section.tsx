"use client";

import { useState } from "react";
import { hubSignInHref } from "@/features/client-hub/links";
import type { OwnReview, ReviewPage } from "./model";

const action =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-current px-5 text-sm font-semibold";
const starsText = (value: number) => "★".repeat(value) + "☆".repeat(5 - value);

export function ReviewsSection({
  slug,
  initial,
}: {
  slug: string;
  initial: ReviewPage | null;
}) {
  const [list, setList] = useState(initial);
  const [offset, setOffset] = useState(0);
  const [stage, setStage] = useState<
    "idle" | "form" | "signin" | "ineligible" | "saved"
  >("idle");
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const url = "/api/client-hub/reviews/" + encodeURIComponent(slug);

  async function loadPage(start: number) {
    const response = await fetch(
      "/api/public/businesses/" +
        encodeURIComponent(slug) +
        "/reviews?offset=" +
        start,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error();
    const { data } = (await response.json()) as { data: ReviewPage };
    setList(data);
    setOffset(start);
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch {
      setMessage("Le chargement a échoué. Vous pouvez réessayer.");
    } finally {
      setBusy(false);
    }
  }

  async function openOrSubmit(submit: boolean) {
    await run(async () => {
      const response = await fetch(
        url,
        submit
          ? {
              method: "POST",
              cache: "no-store",
              headers: {
                "Content-Type": "application/json",
                "X-Client-Hub-Account": account,
              },
              body: JSON.stringify({ stars, comment }),
            }
          : { cache: "no-store" },
      );
      if (response.status === 401) {
        setStage("signin");
        return;
      }
      if (response.status === 409) {
        setStage("idle");
        setMessage(
          "Votre compte a changé. Rouvrez le formulaire pour continuer.",
        );
        return;
      }
      if (!response.ok) throw new Error();
      const { data } = (await response.json()) as { data: OwnReview };
      if (!data.eligible) {
        setStage("ineligible");
        return;
      }
      if (submit) {
        setStage("saved");
        await loadPage(0);
        return;
      }
      setAccount(response.headers.get("X-Client-Hub-Account") ?? "");
      setStars(data.stars ?? 0);
      setComment(data.comment ?? "");
      setStage("form");
    });
  }

  return (
    <section
      id="avis"
      aria-labelledby="avis-titre"
      className="scroll-mt-20 bg-[var(--u-bg,var(--paper))] px-5 pt-16 pb-12 text-[var(--u-ink,var(--ink))]"
    >
      <div className="mx-auto max-w-[1100px] border-t border-current/25 pt-8">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <h2
              id="avis-titre"
              className="text-4xl tracking-tight"
              style={{ fontFamily: "var(--t-display, inherit)" }}
            >
              Avis des clientes
            </h2>
            {list && (
              <p className="mt-3">
                {list.count ? (
                  <>
                    <strong>★ {list.average?.toLocaleString("fr-FR")}/5</strong>{" "}
                    · {list.count} avis
                  </>
                ) : (
                  "Aucun avis pour le moment."
                )}
              </p>
            )}
          </div>
          {stage !== "form" && (
            <button
              type="button"
              disabled={busy}
              className={action}
              onClick={() => void openOrSubmit(false)}
            >
              {stage === "saved" ? "Modifier mon avis" : "Laisser un avis"}
            </button>
          )}
        </div>
        <div aria-live="polite" className="mt-4">
          {stage === "signin" && (
            <p>
              Pour laisser un avis, vérifiez l’adresse e-mail utilisée pour
              votre rendez-vous.{" "}
              <a
                className="font-semibold underline"
                href={hubSignInHref("/b/" + slug + "#avis")}
              >
                Vérifier mon adresse e-mail
              </a>
            </p>
          )}
          {stage === "ineligible" && (
            <p>
              Vous pourrez laisser un avis après un rendez-vous dans cet
              établissement. Utilisez l’adresse e-mail de votre réservation.
            </p>
          )}
          {stage === "saved" && <p>Merci, votre avis est publié.</p>}
          {message && <p role="alert">{message}</p>}
        </div>
        {stage === "form" && (
          <form
            className="mt-6 grid max-w-lg gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (stars) void openOrSubmit(true);
            }}
          >
            <fieldset>
              <legend className="text-sm font-semibold">Votre note</legend>
              <div className="flex">
                {[1, 2, 3, 4, 5].map((n) => (
                  <label
                    key={n}
                    className="relative flex size-11 cursor-pointer items-center justify-center rounded-full text-3xl has-[:focus-visible]:outline-2"
                  >
                    <input
                      type="radio"
                      className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                      required
                      name="avis-note"
                      aria-label={n + " sur 5"}
                      value={n}
                      checked={stars === n}
                      onChange={() => setStars(n)}
                    />
                    <span aria-hidden="true">{n <= stars ? "★" : "☆"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="grid gap-2 text-sm">
              Votre commentaire (facultatif)
              <textarea
                maxLength={500}
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="rounded-xl border border-current/40 bg-transparent p-3 text-base"
              />
            </label>
            <p className="text-sm">
              Votre note et votre commentaire seront publics. Votre nom et votre
              adresse e-mail restent privés.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className={action}
                disabled={busy || !stars}
              >
                Publier mon avis
              </button>
              <button
                type="button"
                className="min-h-11 px-2 text-sm underline"
                disabled={busy}
                onClick={() => setStage("idle")}
              >
                Annuler
              </button>
            </div>
          </form>
        )}
        {list?.reviews.length ? (
          <ul className="mt-8 grid gap-x-10 sm:grid-cols-2">
            {list.reviews.map((review, i) => (
              <li key={offset + i} className="border-t border-current/20 py-5">
                <div className="flex items-center justify-between gap-2">
                  <span aria-label={review.stars + " sur 5"}>
                    {starsText(review.stars)}
                  </span>
                  <time dateTime={review.date} className="text-sm">
                    {new Date(review.date + "T12:00:00Z").toLocaleDateString(
                      "fr-FR",
                      {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                        timeZone: "UTC",
                      },
                    )}
                  </time>
                </div>
                {review.comment && (
                  <p className="mt-3 whitespace-pre-line break-words">
                    {review.comment}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {!list && (
          <button
            type="button"
            className={action}
            disabled={busy}
            onClick={() => void run(() => loadPage(0))}
          >
            Charger les avis
          </button>
        )}
        {list && list.count > 12 && (
          <div className="mt-4 flex gap-3">
            {offset > 0 && (
              <button
                className={action}
                disabled={busy}
                onClick={() => void run(() => loadPage(offset - 12))}
              >
                Avis précédents
              </button>
            )}
            {offset + 12 < list.count && (
              <button
                className={action}
                disabled={busy}
                onClick={() => void run(() => loadPage(offset + 12))}
              >
                Avis suivants
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
