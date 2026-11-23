"use client";

import type { InfoSection as Info } from "../engine/config";
import { Detail, Display, useEngine, useReveal } from "../engine/engine";
import { FoldedText } from "../engine/folded-text";

// One of her informative sections (Higani point 16): « Avant votre
// rendez-vous », « Déroulé d'une séance »… added to her scenes, in her
// faces and colours, numbered like them. Her text keeps her line breaks;
// a long one shows its first lines, the rest at hand (point 18). Only one
// with a title and a text reaches her clients (sections.ts); in her studio
// an unfinished one says what it lacks.

export function InfoSection({ info, index }: { info: Info; index: number }) {
  const { edit } = useEngine();
  const reveal = useReveal();
  const title = info.title.trim();
  const text = info.text.trim();
  return (
    <section className="bg-[var(--u-bg)] text-[var(--u-ink)]">
      <div className="mx-auto max-w-[1100px] px-5 pt-6 pb-24 md:pb-32">
        <p className="border-t border-[var(--u-line)] pt-4 text-[var(--u-muted)]">
          <Detail>({String(index).padStart(2, "0")})</Detail>
        </p>
        <div className="mt-8 md:grid md:grid-cols-12 md:gap-10">
          <h2
            className="text-[clamp(34px,9vw,64px)] leading-[0.95] [overflow-wrap:break-word] md:col-span-5"
            {...reveal()}
          >
            <Display>
              {title ? whole(title) : edit ? "Section sans titre" : ""}
            </Display>
          </h2>
          <div
            className="mt-6 flex max-w-[60ch] flex-col md:col-span-7 md:mt-2"
            {...reveal(1)}
          >
            {text ? (
              <FoldedText
                text={text}
                lines={6}
                perLine={40}
                className="text-[17px] leading-relaxed wrap-anywhere"
              />
            ) : edit ? (
              <p className="text-[17px] leading-relaxed text-[var(--u-muted)]">
                Écris son texte dans Sections : elle sera publiée avec un titre
                et un texte.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Her title, its short hyphenated words kept whole: « rendez-vous » is
 * never split at its hyphen in her display size (« rendez- / vous »). A
 * long one may still break, rather than run off a phone.
 */
function whole(title: string) {
  return title.split(/(\s+)/).map((word, index) =>
    /\S-\S/.test(word) && word.length <= 14 ? (
      <span key={index} className="whitespace-nowrap">
        {word}
      </span>
    ) : (
      word
    ),
  );
}
