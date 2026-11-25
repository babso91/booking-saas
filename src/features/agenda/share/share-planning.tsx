"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { storyImage, storyPageCount } from "./story-image";
import {
  defaultStoryStyle,
  readStoryStyle,
  type StoryStyle,
} from "./story-style";
import { readStory, type Story } from "./story-planning";

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
          <StoryComposer
            key={slug}
            slug={slug}
            initialMonth={anchor.slice(0, 7)}
          />
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
  const storageKey = "higani:story-style:" + slug;
  const [style, setStyle] = useState(() => readStoryStyle(storageKey));
  const [loaded, setLoaded] = useState<{
    key: string;
    story?: Story;
    error?: string;
  } | null>(null);
  const [rendered, setRendered] = useState<{
    key: string;
    image?: { file: File; url: string };
    error?: string;
  } | null>(null);
  const [shareError, setShareError] = useState("");
  const key = slug + "/" + month + "/" + revision;
  useEffect(() => {
    const controller = new AbortController();
    if (month)
      readStory(slug, month, controller.signal).then(
        (story) => {
          if (!controller.signal.aborted) setLoaded({ key, story });
        },
        (error) => {
          if (!controller.signal.aborted)
            setLoaded({
              key,
              error:
                error instanceof Error
                  ? error.message
                  : "Impossible de charger les disponibilités.",
            });
        },
      );
    return () => controller.abort();
  }, [key, slug, month]);
  const current = loaded?.key === key ? loaded : null;
  const story = current?.story;
  const pages = story ? storyPageCount(story) : 0;
  const imageKey = [key, page, style.color, style.gradient].join("/");
  useEffect(() => {
    if (!story) return;
    let active = true;
    let url: string | undefined;
    storyImage(story, page, style)
      .then((blob) => {
        if (!active) return;
        const suffix = page ? "-" + (page + 1) : "";
        const file = new File(
          [blob],
          "planning-" + slug + "-" + month + suffix + ".png",
          { type: "image/png" },
        );
        url = URL.createObjectURL(file);
        setRendered({ key: imageKey, image: { file, url } });
      })
      .catch((error) => {
        if (active)
          setRendered({
            key: imageKey,
            error:
              error instanceof Error
                ? error.message
                : "L’image n’a pas pu être créée.",
          });
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [story, page, style, imageKey, slug, month]);
  const preview = rendered?.key === imageKey ? rendered : null;
  const image = preview?.image;
  function changeStyle(next: StoryStyle) {
    setStyle(next);
    setShareError("");
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Keep the selection for this export. */
    }
  }
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
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Couleur du planning</legend>
        <div className="flex flex-wrap items-center gap-2">
          {[
            { name: "Rose", color: defaultStoryStyle.color },
            { name: "Noir", color: "#000000" },
          ].map(({ name, color }) => (
            <Button
              key={color}
              size="md"
              variant={style.color === color ? "primary" : "secondary"}
              aria-pressed={style.color === color}
              onClick={() => changeStyle({ ...style, color })}
            >
              <span
                aria-hidden="true"
                className="size-4 rounded-full border border-current"
                style={{ backgroundColor: color }}
              />
              {name}
            </Button>
          ))}
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line px-3 text-sm">
            <input
              type="color"
              value={style.color}
              onChange={(e) =>
                changeStyle({ ...style, color: e.target.value.toLowerCase() })
              }
              className="size-7 cursor-pointer"
            />
            Autre couleur
          </label>
        </div>
      </fieldset>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="text-sm font-medium">Fond</legend>
        {["Uni", "Dégradé"].map((label) => (
          <label
            key={label}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm"
          >
            <input
              type="radio"
              name="story-background"
              checked={style.gradient === (label === "Dégradé")}
              onChange={() =>
                changeStyle({ ...style, gradient: label === "Dégradé" })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-ink-soft">
        L’image montre le premier départ de chaque plage disponible. Tu peux la
        publier en story et envoyer ton lien en privé.
      </p>
      {month && !current && (
        <p role="status">Actualisation des disponibilités…</p>
      )}
      {(current?.error || preview?.error) && (
        <p role="alert">{current?.error || preview?.error}</p>
      )}
      {story && !preview && <p role="status">Préparation de l’image…</p>}
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
              {story?.days.map((day, i) => (
                <div className="contents" key={i}>
                  <dt>
                    {String(i + 1).padStart(2, "0")}/{month.slice(5)}
                  </dt>
                  <dd>{day.join(" · ") || "Aucun créneau"}</dd>
                </div>
              ))}
            </dl>
          </details>
          {pages > 1 && (
            <label className="flex items-center gap-2">
              Image à enregistrer
              <select
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
              >
                {Array.from({ length: pages }, (_, i) => (
                  <option key={i} value={i}>
                    {i + 1} sur {pages}
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
