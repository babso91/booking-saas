"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { CatalogServiceDto } from "@/features/catalog/data/catalog";
import type { ServiceOption } from "@/features/catalog/model";

import type { ServiceView } from "../client/service-form";
import { OptionsSheet, type SaveOptions } from "./options-sheet";

// The options editor on fictional data, saved in this page's memory only:
// to review it without an account or a database. Never part of a real page.

const SERVICE: ServiceView = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "Motif au henné",
  description: null,
  durationMinutes: 45,
  priceCents: 3000,
  active: true,
  displayOrder: 0,
  categoryId: null,
  version: 1,
};

const START: ServiceOption[] = [
  {
    id: "40000000-0000-4000-8000-000000000001",
    question: "Taille du motif",
    required: true,
    choices: [
      {
        id: "40000000-0000-4000-8000-000000000002",
        label: "Fin",
        priceDeltaCents: 0,
        durationDeltaMinutes: 0,
      },
      {
        id: "40000000-0000-4000-8000-000000000003",
        label: "Large",
        priceDeltaCents: 1250,
        durationDeltaMinutes: 20,
      },
    ],
  },
];

export function OptionsPreview({ empty }: { empty: boolean }) {
  const [service, setService] = useState(SERVICE);
  const [options, setOptions] = useState<ServiceOption[]>(empty ? [] : START);
  // Closed first: a sheet only ever opens after a click.
  const [open, setOpen] = useState(false);

  const save: SaveOptions = async (command) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const saved: CatalogServiceDto = {
      ...service,
      version: service.version + 1,
      options: command.options.map((option) => ({
        id: option.id ?? crypto.randomUUID(),
        question: option.question,
        required: option.required,
        choices: option.choices.map((choice) => ({
          id: choice.id ?? crypto.randomUUID(),
          label: choice.label,
          priceDeltaCents: choice.priceDeltaCents,
          durationDeltaMinutes: choice.durationDeltaMinutes,
        })),
      })),
    };
    return { ok: true, data: saved };
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-start gap-4 px-5 py-10">
      <p className="text-[14px] text-ink-soft">
        Aperçu : {service.name}, {options.length} question
        {options.length > 1 ? "s" : ""} enregistrée
        {options.length > 1 ? "s" : ""} (en mémoire).
      </p>
      <Button size="md" onClick={() => setOpen(true)}>
        Ouvrir les options
      </Button>
      <OptionsSheet
        service={open ? service : null}
        saved={options}
        save={save}
        onClose={() => setOpen(false)}
        onSaved={(next) => {
          setService((current) => ({ ...current, version: next.version }));
          setOptions(next.options);
          setOpen(false);
        }}
        onReload={() => undefined}
      />
    </main>
  );
}
