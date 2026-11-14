"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/cn";

import {
  importErrors,
  reasonLabels,
  stateLabels,
  type CrmImportActions,
  type ImportMapping,
  type ImportPreviewDto,
  type ImportResultDto,
  type ImportRowDto,
} from "./contract";
import {
  fieldLabels,
  guessMapping,
  parseCsv,
  toCsv,
  type ImportField,
} from "./csv";

// Bringing her client list in, step by step: the file, which column is
// what, a preview that writes nothing, a confirmation, then a result per
// row. A row that cannot be imported is never lost: the report keeps it,
// with its reason, ready to download (cells written as text).

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

const MAX_BYTES = 2_000_000;

type Step =
  | { kind: "file" }
  | {
      kind: "mapping";
      fileName: string;
      content: string;
      header: string[];
      sample: string[][];
    }
  | {
      kind: "preview";
      fileName: string;
      content: string;
      header: string[];
      preview: ImportPreviewDto;
    }
  | {
      kind: "done";
      header: string[];
      content: string;
      result: ImportResultDto;
    };

function counts(rows: ImportRowDto[]) {
  return {
    create: rows.filter((r) => r.state === "create").length,
    unchanged: rows.filter((r) => r.state === "unchanged").length,
    conflict: rows.filter((r) => r.state === "conflict").length,
    invalid: rows.filter((r) => r.state === "invalid").length,
  };
}

export function ImportWizard({ actions }: { actions: CrmImportActions }) {
  const [step, setStep] = useState<Step>({ kind: "file" });
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIds = useRef(new Map<string, string>());

  async function readFile(file: File) {
    setNotice(null);
    if (file.size > MAX_BYTES)
      return setNotice(
        "Ce fichier dépasse 2 Mo. Découpe-le en plusieurs fichiers.",
      );
    const content = await file.text();
    const rows = parseCsv(content);
    if (rows.length < 2)
      return setNotice(
        "Ce fichier ne contient pas de lignes lisibles. Il faut un CSV avec une ligne d’en-tête.",
      );
    const header = rows[0]!;
    setMapping(guessMapping(header));
    setStep({
      kind: "mapping",
      fileName: file.name,
      content,
      header,
      sample: rows.slice(1, 4),
    });
  }

  const mapped = Object.values(mapping);
  const mappingProblem =
    !mapped.includes("email") && !mapped.includes("phone")
      ? "Indique au moins la colonne e-mail ou téléphone."
      : !mapped.includes("firstName") && !mapped.includes("lastName")
        ? "Indique au moins une colonne de nom."
        : null;

  async function preview(current: Extract<Step, { kind: "mapping" }>) {
    if (mappingProblem || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await actions.preview({
      fileName: current.fileName,
      content: current.content,
      mapping,
    });
    setBusy(false);
    if (!result.ok)
      return setNotice(
        result.error.code === importErrors.fileTooLarge
          ? "Ce fichier est trop volumineux."
          : result.error.code === importErrors.unreadable
            ? "Ce fichier n’a pas pu être lu comme un CSV."
            : "L’aperçu n’a pas abouti. Réessaie.",
      );
    setStep({
      kind: "preview",
      fileName: current.fileName,
      content: current.content,
      header: current.header,
      preview: result.data,
    });
  }

  async function commit(current: Extract<Step, { kind: "preview" }>) {
    if (busy) return;
    const key = `${current.preview.jobId}:${current.preview.mappingVersion}`;
    if (!requestIds.current.has(key))
      requestIds.current.set(key, crypto.randomUUID());
    setBusy(true);
    setNotice(null);
    const result = await actions.commit({
      jobId: current.preview.jobId,
      mappingVersion: current.preview.mappingVersion,
      requestId: requestIds.current.get(key)!,
    });
    setBusy(false);
    if (result.ok)
      return setStep({
        kind: "done",
        header: current.header,
        content: current.content,
        result: result.data,
      });
    if (result.error.code === importErrors.versionConflict) {
      setStep({
        kind: "mapping",
        fileName: current.fileName,
        content: current.content,
        header: current.header,
        sample: parseCsv(current.content).slice(1, 4),
      });
      return setNotice(
        "L’aperçu ne correspond plus aux colonnes choisies : rien n’a été importé. Relance l’aperçu.",
      );
    }
    setNotice(
      result.error.code === "network"
        ? "Pas de réponse. Réessaie : une même importation n’est jamais faite deux fois."
        : "L’importation n’a pas abouti. Rien n’a été importé.",
    );
  }

  function downloadReport(current: Extract<Step, { kind: "done" }>) {
    const lines = parseCsv(current.content);
    const kept = current.result.rows.filter(
      (r) => r.state === "conflict" || r.state === "invalid",
    );
    const csv = toCsv([
      ["Ligne", "Motif", ...current.header],
      ...kept.map((row) => [
        String(row.rowNumber),
        row.reason ? reasonLabels[row.reason] : "",
        ...(lines[row.rowNumber - 1] ?? []),
      ]),
    ]);
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lignes-a-examiner.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const header = (
    <header className="flex flex-col gap-1.5">
      <h1 className="font-display text-[32px] leading-tight text-ink">
        Importer mes clientes
      </h1>
      <p className="max-w-prose text-[15px] text-ink-soft">
        Depuis un fichier CSV exporté de ton ancien outil ou d’un tableur. Rien
        n’est enregistré avant ta confirmation ; aucune fiche n’est fusionnée
        sans toi.
      </p>
    </header>
  );
  const banner = notice ? (
    <Notice tone="error" title="À revoir">
      {notice}
    </Notice>
  ) : null;

  if (step.kind === "file")
    return (
      <div className="flex flex-col gap-5">
        {header}
        {banner}
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-3xl border border-dashed border-line-strong bg-paper-raised px-5 py-10 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink">
          <span className="text-[16px] font-semibold text-ink">
            Choisir un fichier CSV
          </span>
          <span className="text-[13.5px] text-ink-muted">
            Colonnes acceptées : nom, prénom, e-mail, téléphone, étiquettes. 2
            Mo au plus.
          </span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
    );

  if (step.kind === "mapping")
    return (
      <div className="flex flex-col gap-5">
        {header}
        {banner}
        <section
          aria-label="Colonnes"
          className="flex flex-col gap-4 rounded-3xl border border-line bg-paper-raised px-5 py-5"
        >
          <p className="text-[14.5px] text-ink-soft">
            {step.fileName} · vérifie à quoi correspond chaque colonne.
          </p>
          {step.header.map((name, index) => (
            <SelectField
              key={index}
              label={name || `Colonne ${index + 1}`}
              hint={
                step.sample
                  .map((row) => row[index] ?? "")
                  .filter(Boolean)
                  .slice(0, 2)
                  .join(" · ") || undefined
              }
              value={mapping[index] ?? ""}
              onChange={(event) => {
                const value = (event.target.value ||
                  null) as ImportField | null;
                setMapping((current) => {
                  const next: ImportMapping = {};
                  for (const [key, field] of Object.entries(current))
                    next[Number(key)] = value && field === value ? null : field;
                  next[index] = value;
                  return next;
                });
              }}
            >
              <option value="">Ne pas importer</option>
              {(Object.keys(fieldLabels) as ImportField[]).map((field) => (
                <option key={field} value={field}>
                  {fieldLabels[field]}
                </option>
              ))}
            </SelectField>
          ))}
          {mappingProblem ? (
            <p className="text-[13.5px] font-medium text-danger">
              {mappingProblem}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="md"
              state={busy ? "loading" : "idle"}
              loadingLabel="Aperçu…"
              disabled={mappingProblem !== null}
              onClick={() => void preview(step)}
            >
              Voir l’aperçu
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={busy}
              onClick={() => setStep({ kind: "file" })}
            >
              Autre fichier
            </Button>
          </div>
        </section>
      </div>
    );

  const rows = step.kind === "preview" ? step.preview.rows : step.result.rows;
  const total = counts(rows);

  return (
    <div className="flex flex-col gap-5">
      {header}
      {banner}
      {step.kind === "done" ? (
        <Notice
          tone={step.result.status === "completed" ? "success" : "warning"}
          title="Importation terminée"
        >
          {total.create} {total.create > 1 ? "fiches créées" : "fiche créée"}
          {total.unchanged ? `, ${total.unchanged} déjà présentes` : ""}.
          {total.conflict + total.invalid
            ? ` ${total.conflict + total.invalid} ${total.conflict + total.invalid > 1 ? "lignes n’ont pas été importées" : "ligne n’a pas été importée"} : elles restent dans le rapport.`
            : ""}
        </Notice>
      ) : (
        <p className="text-[14.5px] text-ink-soft">
          Aperçu : rien n’est encore enregistré. Chaque ligne sera revérifiée au
          moment d’importer.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["create", "unchanged", "conflict", "invalid"] as const).map(
          (state) => (
            <div
              key={state}
              className="rounded-2xl border border-line bg-paper-raised px-4 py-3"
            >
              <dt className="text-[12.5px] text-ink-muted">
                {stateLabels[state]}
              </dt>
              <dd className="font-display text-[26px] leading-none text-ink tabular-nums">
                {total[state]}
              </dd>
            </div>
          ),
        )}
      </dl>

      <ol className="flex flex-col gap-1.5" aria-label="Lignes du fichier">
        {rows.map((row) => (
          <li
            key={row.rowNumber}
            className={cn(
              "flex items-start justify-between gap-3 rounded-2xl px-4 py-2.5 text-[14px]",
              row.state === "conflict" || row.state === "invalid"
                ? "bg-sand/70"
                : "bg-paper-raised",
            )}
          >
            <span className="flex min-w-0 flex-col">
              {/* Shown as text: a name starting with "=" stays a name. */}
              <span className="wrap-anywhere text-ink">{row.displayName}</span>
              <span className="text-[12.5px] text-ink-muted">
                Ligne {row.rowNumber}
                {row.reason ? ` · ${reasonLabels[row.reason]}` : ""}
              </span>
            </span>
            <span className="shrink-0 text-[12.5px] font-medium text-ink-soft">
              {stateLabels[row.state]}
            </span>
          </li>
        ))}
      </ol>

      {step.kind === "preview" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="md"
            state={busy ? "loading" : "idle"}
            loadingLabel="Importation…"
            disabled={total.create === 0}
            onClick={() => void commit(step)}
          >
            {total.create
              ? `Importer ${total.create} ${total.create > 1 ? "nouvelles fiches" : "nouvelle fiche"}`
              : "Rien de nouveau à importer"}
          </Button>
          <Button
            size="md"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              setStep({
                kind: "mapping",
                fileName: step.fileName,
                content: step.content,
                header: step.header,
                sample: parseCsv(step.content).slice(1, 4),
              })
            }
          >
            Modifier les colonnes
          </Button>
        </div>
      ) : total.conflict + total.invalid ? (
        <button
          type="button"
          className={cn(linkAction, "w-fit")}
          onClick={() => downloadReport(step)}
        >
          Télécharger les lignes à examiner
        </button>
      ) : null}
    </div>
  );
}
