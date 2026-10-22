import Link from "next/link";

import { universes } from "@/features/experience-lab/universes";

// Internal index of the lab (for us, not part of any product path): in
// real life a customer arrives directly on one professional's link.
export default function LabIndex() {
  return (
    <main
      className="mx-auto max-w-xl px-6 py-16"
      style={{ fontFamily: "var(--font-lab-sans)" }}
    >
      <p className="text-[13px] text-neutral-500">
        Laboratoire interne · données fictives
      </p>
      <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.03em]">
        Liens de professionnelles
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-neutral-600">
        Chaque lien est ce qu’une cliente ouvre depuis Instagram ou un SMS : le
        mini-site de la professionnelle, puis la réservation sans compte.
      </p>
      <ul className="mt-8 flex flex-col gap-3">
        {Object.values(universes).map((universe) => (
          <li key={universe.id}>
            <Link
              href={`/labo/${universe.id}`}
              className="flex items-center justify-between rounded-2xl border border-neutral-200 px-5 py-4 hover:border-neutral-400"
            >
              <span>
                <span className="block text-[17px] font-medium">
                  {universe.name}
                </span>
                <span className="text-[14px] text-neutral-500">
                  {universe.kind} · {universe.location}
                </span>
              </span>
              <span className="text-[13px] text-neutral-500">
                /labo/{universe.id} →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
