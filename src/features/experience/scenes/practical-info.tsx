"use client";
import { sectionTitle } from "@/features/sites/presentation";

import { Detail, useEngine, useReveal } from "../engine/engine";
import {
  directionsHref,
  telHref,
  whatsappHref,
  type PracticalItem,
} from "../practical";

// Her "Infos pratiques": set on her day surface like her services, in her
// faces and colours, as a list a client scans before booking or coming.
// Not a scene of her composition: every plan and universe shows it, after
// her scenes, when there is something to say (practical.ts).

export function PracticalInfo({
  items,
  index,
}: {
  items: PracticalItem[];
  index: number;
}) {
  const reveal = useReveal();
  const title = sectionTitle(
    useEngine().config.presentation,
    "practical",
    "Infos pratiques",
  );
  if (!items.length) return null;
  return (
    <section className="bg-[var(--u-paper)] text-[var(--u-ink-on-paper)]">
      <div className="mx-auto max-w-[1100px] px-5 pt-16 pb-24">
        <div className="flex items-baseline justify-between border-t border-current pt-4">
          {title && (
            <h2>
              <Detail>
                ({String(index).padStart(2, "0")}) {title}
              </Detail>
            </h2>
          )}
        </div>
        <dl className="mt-10 grid gap-x-12 gap-y-9 md:grid-cols-2">
          {items.map((item, position) => (
            <div
              key={item.label}
              className="flex min-w-0 flex-col gap-2"
              {...reveal(Math.min(position, 3))}
            >
              <dt className="text-[var(--u-soft-paper)]">
                <Detail>{item.label}</Detail>
              </dt>
              <dd className="text-[17px] leading-relaxed wrap-anywhere">
                <ItemBody item={item} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

const link =
  "inline-flex min-h-11 items-center underline decoration-1 underline-offset-4";

function ItemBody({ item }: { item: PracticalItem }) {
  switch (item.kind) {
    case "text":
      return <p className="whitespace-pre-line">{item.text}</p>;
    case "address":
      return (
        <>
          <p className="whitespace-pre-line">{item.text}</p>
          <a
            href={directionsHref(item.text)}
            target="_blank"
            rel="noopener noreferrer"
            className={link}
          >
            Itinéraire<span className="sr-only"> (nouvel onglet)</span>
            <span aria-hidden="true">&nbsp;↗</span>
          </a>
        </>
      );
    case "hours":
      return (
        <>
          <table className="w-full max-w-[26rem] border-collapse text-left">
            <caption className="sr-only">Horaires habituels</caption>
            <tbody>
              {item.days.map(({ day, ranges }) => (
                <tr
                  key={day}
                  className="border-b border-current/15 last:border-b-0"
                >
                  <th scope="row" className="py-1.5 pr-4 font-normal">
                    {day}
                  </th>
                  <td
                    className={`py-1.5 text-right tabular-nums ${ranges === "Fermé" ? "text-[var(--u-soft-paper)]" : ""}`}
                  >
                    {ranges}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[14px] text-[var(--u-soft-paper)]">
            Les créneaux en ligne tiennent compte des fermetures
            exceptionnelles.
          </p>
        </>
      );
    case "contact":
      return (
        <div className="flex flex-col">
          {item.phone ? (
            <a href={telHref(item.phone)} className={link}>
              {item.phone}
            </a>
          ) : null}
          {item.whatsapp ? (
            <a
              href={whatsappHref(item.whatsapp)!}
              target="_blank"
              rel="noopener noreferrer"
              className={link}
            >
              WhatsApp · {item.whatsapp}
            </a>
          ) : null}
          {item.email ? (
            <a href={`mailto:${item.email}`} className={link}>
              {item.email}
            </a>
          ) : null}
        </div>
      );
  }
}
