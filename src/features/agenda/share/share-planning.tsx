"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { storyImage, storyPageCount } from "./story-image";
import { readStory } from "./story-planning";

export function SharePlanning({
  slug,
  anchor,
}: {
  slug: string;
  anchor: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="md" onClick={() => setOpen(true)}>
        Partager mon planning
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Partager mon planning"
      >
        {open && (
          <StoryComposer slug={slug} initialMonth={anchor.slice(0, 7)} />
        )}
      </Sheet>
    </>
  );
}

function StoryComposer({
  slug,
  initialMonth,
}: {
  slug: string;
  initialMonth: string;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    images: { file: File; url: string }[];
    days?: string[][];
    error?: string;
  } | null>(null);
  const [shareError, setShareError] = useState("");
  const key = slug + "/" + month + "/" + revision;
  useEffect(() => {
    const controller = new AbortController();
    const urls: string[] = [];
    async function generate() {
      try {
        const story = await readStory(slug, month, controller.signal);
        const images = [];
        for (let i = 0; i < storyPageCount(story); i++) {
          if (controller.signal.aborted) return;
          const blob = await storyImage(story, i);
          if (controller.signal.aborted) return;
          const file = new File(
            [blob],
            "planning-" +
              slug +
              "-" +
              month +
              (i ? "-" + (i + 1) : "") +
              ".png",
            { type: "image/png" },
          );
          const url = URL.createObjectURL(file);
          urls.push(url);
          images.push({ file, url });
        }
        setResult({ key, images, days: story.days });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({
            key,
            images: [],
            error:
              error instanceof Error
                ? error.message
                : "La création de l’image a échoué.",
          });
      }
    }
    if (month) void generate();
    return () => {
      controller.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [slug, month, key]);
  const current = result?.key === key ? result : null;
  const image = current?.images[page];
  const canShare =
    image &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [image.file] });
  return (
    <div className="space-y-4 pb-4">
      <label className="grid gap-1 text-sm font-medium">
        Mois à partager
        <input
          type="month"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setPage(0);
            setShareError("");
          }}
          className="min-h-11 rounded-xl border border-line bg-paper-raised px-3 text-ink"
        />
      </label>
      <p className="text-sm text-ink-soft">
        L’image montre le premier départ de chaque plage disponible. Tu peux la publier en
        story et envoyer ton lien en privé.
      </p>
      {month && !current && (
        <p role="status">Actualisation des disponibilités…</p>
      )}
      {current?.error && <p role="alert">{current.error}</p>}
      {image && (
        <>
          {/* A local PNG can also be saved by a long press on mobile. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            width={1080}
            height={1920}
            alt={"Aperçu du planning de " + month}
            className="mx-auto w-full max-w-[210px] rounded-xl border border-line"
          />
          <details className="text-sm text-ink-soft">
            <summary className="min-h-11 cursor-pointer py-3">
              Lire les horaires de l’image
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              {current?.days?.map((day, i) => (
                <div className="contents" key={i}>
                  <dt>
                    {String(i + 1).padStart(2, "0")}/{month.slice(5)}
                  </dt>
                  <dd>{day.join(" · ") || "Aucun créneau"}</dd>
                </div>
              ))}
            </dl>
          </details>
          {current!.images.length > 1 && (
            <label className="flex items-center gap-2">
              Image à enregistrer
              <select
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
              >
                {current!.images.map((_, i) => (
                  <option key={i} value={i}>
                    {i + 1} sur {current!.images.length}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {canShare && (
              <Button
                size="md"
                onClick={async () => {
                  try {
                    await navigator.share({ files: [image.file] });
                  } catch (error) {
                    if (!(
                      error instanceof DOMException &&
                      error.name === "AbortError"
                    ))
                      setShareError(
                        "Le partage a échoué. Tu peux télécharger l’image.",
                      );
                  }
                }}
              >
                Partager l’image
              </Button>
            )}
            <a
              href={image.url}
              download={image.file.name}
              className="inline-flex min-h-11 items-center rounded-xl bg-ink px-4 text-sm font-semibold text-paper-raised"
            >
              Télécharger l’image
            </a>
          </div>
        </>
      )}
      {shareError && <p role="alert">{shareError}</p>}
      <Button
        variant="ghost"
        size="md"
        disabled={!month || !current}
        onClick={() => {
          setPage(0);
          setShareError("");
          setRevision((v) => v + 1);
        }}
      >
        Actualiser les disponibilités
      </Button>
    </div>
  );
}
