"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import type {
  DuplicateCandidates,
  DuplicateClient,
  DuplicatePair,
} from "@/features/crm/data/duplicates";

import {
  listDuplicateCandidatesAction,
  setDuplicateDismissedAction,
} from "../actions/duplicates";

// Records that look alike (point 147), side by side for her to check.
// Higani never merges them: she says when two are different people.

const reasonLabel = { phone: "Même téléphone", name: "Même nom" } as const;

const nameOf = (client: DuplicateClient) =>
  [client.firstName, client.lastName].filter(Boolean).join(" ");
const pairKey = (pair: DuplicatePair) =>
  pair.clients
    .map((client) => client.id)
    .sort()
    .join(":");

const plural = (count: number, one: string, many: string) =>
  `${count} ${count > 1 ? many : one}`;

type Load =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready"; data: DuplicateCandidates };

type Undo = { pair: DuplicatePair; index: number };

export function DuplicateReview({ timeZone }: { timeZone: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    error: UiError;
  } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const reads = useRef(0);

  const day = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  });

  useEffect(() => {
    const read = (reads.current += 1);
    void callAction(() => listDuplicateCandidatesAction()).then((result) => {
      if (read !== reads.current) return;
      setLoad(
        result.ok
          ? { status: "ready", data: result.data }
          : { status: "error", error: result.error },
      );
    });
    return () => {
      reads.current += 1;
    };
  }, [run]);

  async function setDismissed(pair: DuplicatePair, dismissed: boolean) {
    const key = pairKey(pair);
    if (busy) return;
    setBusy(key);
    setFailure(null);
    const [a, b] = pair.clients;
    const result = await callAction(() =>
      setDuplicateDismissedAction({
        clientId: a.id,
        otherId: b.id,
        dismissed,
      }),
    );
    setBusy(null);
    if (!result.ok) {
      setFailure({ key, error: result.error });
      // A record deleted or erased meanwhile: the list as it is now.
      if (result.error.code === "client_not_found") setRun((n) => n + 1);
      return;
    }
    if (dismissed) {
      setUndo({
        pair,
        index:
          load.status === "ready"
            ? load.data.pairs.findIndex((item) => pairKey(item) === key)
            : 0,
      });
      setLoad((value) =>
        value.status === "ready"
          ? {
              status: "ready",
              data: {
                total: value.data.total - 1,
                pairs: value.data.pairs.filter((item) => pairKey(item) !== key),
              },
            }
          : value,
      );
      return;
    }
    const at = undo?.index ?? 0;
    setUndo(null);
    setLoad((value) => {
      if (value.status !== "ready") return value;
      if (value.data.pairs.some((item) => pairKey(item) === key)) return value;
      const pairs = [...value.data.pairs];
      pairs.splice(Math.min(Math.max(at, 0), pairs.length), 0, pair);
      return {
        status: "ready",
        data: { total: value.data.total + 1, pairs },
      };
    });
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-col gap-2">
          <Link
            href="/app/clients"
            className="w-fit text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
          >
            Retour aux clientes
          </Link>
          <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
            Doublons possibles
          </h1>
          <p className="text-[14.5px] text-ink-muted">
            Ces fiches se ressemblent : même téléphone ou même nom. Higani ne
            les fusionne jamais à ta place. Vérifie-les, et si ce sont deux
            personnes différentes, dis-le pour ne plus les voir ici.
          </p>
        </header>

        {undo ? (
          <Notice
            tone="success"
            action={
              <button
                type="button"
                className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                disabled={busy !== null}
                onClick={() => void setDismissed(undo.pair, false)}
              >
                Annuler
              </button>
            }
          >
            C’est noté : {nameOf(undo.pair.clients[0])} et{" "}
            {nameOf(undo.pair.clients[1])} ne te seront plus proposées.
          </Notice>
        ) : null}

        {load.status === "loading" ? (
          <p className="text-[14.5px] text-ink-muted" role="status">
            Recherche des doublons possibles…
          </p>
        ) : load.status === "error" ? (
          <Notice
            tone="error"
            title="Les doublons possibles n’ont pas pu être lus."
            action={
              <button
                type="button"
                className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
                onClick={() => {
                  setLoad({ status: "loading" });
                  setRun((n) => n + 1);
                }}
              >
                Réessayer
              </button>
            }
          />
        ) : load.data.pairs.length === 0 ? (
          <p className="text-[14.5px] text-ink-muted">
            Aucun doublon possible : chaque fiche semble être une personne
            différente.
          </p>
        ) : (
          <>
            {load.data.total > load.data.pairs.length ? (
              <p className="text-[13.5px] text-ink-muted">
                Les {load.data.pairs.length} plus probables sur{" "}
                {load.data.total}.
              </p>
            ) : null}
            <ul
              aria-label="Fiches qui se ressemblent"
              className="flex flex-col gap-3"
            >
              {load.data.pairs.map((pair) => {
                const key = pairKey(pair);
                return (
                  <li
                    key={key}
                    className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-4 py-4 sm:px-5"
                  >
                    <p className="text-[13px] font-medium text-ink-soft">
                      {pair.reasons
                        .map((reason) => reasonLabel[reason])
                        .join(" · ")}
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {pair.clients.map((client) => (
                        <ClientSide key={client.id} client={client} day={day} />
                      ))}
                    </div>
                    {failure?.key === key ? (
                      <p role="alert" className="text-[13.5px] text-danger">
                        {failure.error.code === "client_not_found"
                          ? "Une de ces fiches n’existe plus : la liste a été relue."
                          : "Ton choix n’a pas pu être enregistré. Réessaie."}
                      </p>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="md"
                      disabled={busy !== null}
                      onClick={() => void setDismissed(pair, true)}
                    >
                      {busy === key
                        ? "Enregistrement…"
                        : "Ce n’est pas la même personne"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function ClientSide({
  client,
  day,
}: {
  client: DuplicateClient;
  day: Intl.DateTimeFormat;
}) {
  const name = nameOf(client);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-paper p-3 text-[14px]">
      <p className="text-[15.5px] font-semibold wrap-anywhere text-ink">
        {name}
      </p>
      <p className="wrap-anywhere text-ink-soft">
        {client.email ?? "Pas d’e-mail"}
      </p>
      <p className="text-ink-soft tabular-nums">
        {client.phone ?? "Pas de téléphone"}
      </p>
      <p className="text-ink-muted">
        Fiche créée le {day.format(new Date(client.createdAt))}
      </p>
      <p className="text-ink-muted">
        {client.pastVisits
          ? `${plural(client.pastVisits, "visite", "visites")}, la dernière le ${day.format(new Date(client.lastVisitAt!))}`
          : "Aucune visite"}
        {client.upcoming
          ? ` · ${plural(client.upcoming, "rendez-vous", "rendez-vous")} à venir`
          : ""}
      </p>
      <Link
        href={`/app/clients/${client.id}`}
        className="mt-1 w-fit text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
      >
        Voir la fiche
        <span className="sr-only"> de {name}</span>
      </Link>
    </div>
  );
}
