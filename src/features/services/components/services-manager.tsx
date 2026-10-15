"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Switch } from "@/components/ui/switch";
import { formatPrice } from "@/features/agenda/client/money";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import { describeError } from "@/features/auth/client/error-copy";
import {
  scopeId,
  type DraftScope,
} from "@/features/businesses/client/draft-scope";
import { getBookingSettingsAction } from "@/features/availability/actions/schedule";
import {
  deleteServiceAction,
  listServicesAction,
  reorderServicesAction,
  setServiceActiveAction,
} from "@/features/services/actions/services";
import { cn } from "@/lib/cn";

import { creationKey, pendingCreationSnapshot } from "../client/service-drafts";
import { durationLabel, type ServiceView } from "../client/service-form";
import {
  ServiceSheet,
  type CurrentService,
  type ServiceSheetTarget,
} from "./service-sheet";

type Load =
  | { status: "loading" }
  | { status: "error"; error: UiError }
  | { status: "ready"; services: ServiceView[]; currency: string };

/** A row action in progress or refused. */
type RowState = { id: string; kind: "active" | "delete"; error?: UiError };

const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/**
 * The business's services (prestations), from the existing Server Actions:
 * list, create, edit, activate or deactivate, reorder, delete when never
 * booked. Every change is shown once the backend confirmed it; reads apply
 * only when they are the latest.
 *
 * Activating or deactivating is sent by value, without version: it sets the
 * one state the professional sees the opposite of, so a stale list can only
 * make it a no-op (the state is already the requested one), never undo a
 * change made elsewhere; the returned service replaces the row.
 */
export function ServicesManager({ scope }: { scope: DraftScope }) {
  // One screen per identity (signed-in user and business). The page can be
  // rendered again for another identity without being unmounted (sign-in
  // as someone else, another business): the key replaces the whole screen
  // during that same render, so no state, draft or pending answer of the
  // previous identity is ever shown, kept or sent under the new one. Late
  // answers of the previous screen land on an unmounted tree and are
  // dropped.
  return <ServicesScreen key={scopeId(scope)} scope={scope} />;
}

function ServicesScreen({ scope }: { scope: DraftScope }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [sheet, setSheet] = useState<ServiceSheetTarget | null>(null);
  const [row, setRow] = useState<RowState | null>(null);
  const [ordering, setOrdering] = useState<"idle" | "saving" | UiError>("idle");
  const [deleting, setDeleting] = useState<ServiceView | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const reads = useRef(0);
  // An unconfirmed creation kept from earlier (closed form, other page).
  const pendingRaw = useSyncExternalStore(
    noSubscription,
    () => pendingCreationSnapshot(creationKey(scope)),
    () => null,
  );
  const unconfirmedCreation = isUnconfirmed(pendingRaw) && sheet === null;

  useEffect(() => {
    const read = (reads.current += 1);
    void Promise.all([
      callAction(() => listServicesAction()),
      callAction(() => getBookingSettingsAction()),
    ]).then(([services, settings]) => {
      if (read !== reads.current) return;
      if (!services.ok)
        return setLoad({ status: "error", error: services.error });
      if (!settings.ok)
        return setLoad({ status: "error", error: settings.error });
      setLoad({
        status: "ready",
        services: services.data,
        currency: settings.data.currency,
      });
    });
    return () => {
      reads.current += 1;
    };
  }, [run]);

  const reload = () => setRun((value) => value + 1);

  function replace(service: ServiceView) {
    setLoad((value) =>
      value.status === "ready"
        ? {
            ...value,
            services: value.services.map((item) =>
              item.id === service.id ? service : item,
            ),
          }
        : value,
    );
  }

  /** The service as it is now (after a refused edit). */
  async function readCurrent(serviceId: string): Promise<CurrentService> {
    const result = await callAction(() => listServicesAction());
    if (!result.ok) return { status: "error", error: result.error };
    // The list is read again anyway: keep it in step.
    setLoad((value) =>
      value.status === "ready" ? { ...value, services: result.data } : value,
    );
    const service = result.data.find((item) => item.id === serviceId);
    return service ? { status: "found", service } : { status: "gone" };
  }

  /** `afterDelete`: offered by a refused deletion, whose row state it replaces. */
  async function toggleActive(service: ServiceView, afterDelete = false) {
    if ((row && !row.error && !afterDelete) || ordering === "saving") return;
    setRow({ id: service.id, kind: "active" });
    const result = await callAction(() =>
      setServiceActiveAction({
        serviceId: service.id,
        active: !service.active,
      }),
    );
    if (result.ok) {
      replace(result.data);
      setRow(null);
      setAnnouncement(
        result.data.active
          ? `${result.data.name} est de nouveau proposée.`
          : `${result.data.name} n’est plus proposée.`,
      );
      return;
    }
    setRow({ id: service.id, kind: "active", error: result.error });
    if (result.error.code === "not_found") reload();
  }

  async function move(index: number, delta: -1 | 1) {
    if (load.status !== "ready" || (row && !row.error) || ordering === "saving")
      return;
    const ids = load.services.map((service) => service.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setOrdering("saving");
    const result = await callAction(() =>
      reorderServicesAction({ serviceIds: ids }),
    );
    if (result.ok) {
      setLoad((value) =>
        value.status === "ready" ? { ...value, services: result.data } : value,
      );
      setOrdering("idle");
      const moved = result.data.find((service) => service.id === ids[target]);
      setAnnouncement(
        moved
          ? `${moved.name} : position ${target + 1} sur ${ids.length}.`
          : "",
      );
      return;
    }
    setOrdering(result.error);
    // The list changed elsewhere (added or deleted): read it again.
    if (result.error.code === "validation_error") reload();
  }

  async function confirmDelete() {
    if (!deleting) return;
    const service = deleting;
    setRow({ id: service.id, kind: "delete" });
    const result = await callAction(() =>
      deleteServiceAction({ serviceId: service.id }),
    );
    if (result.ok || result.error.code === "not_found") {
      setLoad((value) =>
        value.status === "ready"
          ? {
              ...value,
              services: value.services.filter((item) => item.id !== service.id),
            }
          : value,
      );
      setRow(null);
      setDeleting(null);
      setAnnouncement(`${service.name} a été supprimée.`);
      return;
    }
    setRow({ id: service.id, kind: "delete", error: result.error });
  }

  function openCreate() {
    setSheet({ mode: "create" });
  }

  /** A row operation is in flight (an error shown on a row locks nothing). */
  const pending = row !== null && row.error === undefined;

  /** Closes the deletion dialog, whatever its state: nothing stays locked. */
  function closeDelete() {
    setDeleting(null);
    setRow(null);
  }

  const deleteError =
    row?.kind === "delete" && row.id === deleting?.id ? row.error : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[34px] leading-none text-ink sm:text-[40px]">
              Prestations
            </h1>
            <p className="text-[14.5px] text-ink-muted">
              Ce que tu proposes, avec sa durée et son prix.
            </p>
          </div>
          <Button
            size="md"
            onClick={openCreate}
            disabled={load.status !== "ready"}
            icon={<PlusIcon size={17} />}
          >
            Ajouter une prestation
          </Button>
        </header>

        {unconfirmedCreation && load.status === "ready" ? (
          <Notice
            tone="warning"
            title="Une création n’a pas été confirmée"
            action={
              <button type="button" onClick={openCreate} className={linkAction}>
                Reprendre la création
              </button>
            }
          >
            La connexion s’était interrompue pendant l’ajout d’une prestation.
            Reprends-la pour la renvoyer : si elle avait déjà été créée, elle ne
            le sera pas une seconde fois.
          </Notice>
        ) : null}

        {load.status === "loading" ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <span className="sr-only" role="status">
              Chargement des prestations…
            </span>
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-20 animate-pulse rounded-3xl bg-sand/60"
              />
            ))}
          </div>
        ) : load.status === "error" ? (
          <Notice
            tone={load.error.code === "network" ? "offline" : "error"}
            title={describeError(load.error).title}
            action={
              load.error.code === "unauthenticated" ? (
                <Link href="/login" className={linkAction}>
                  Me reconnecter
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setLoad({ status: "loading" });
                    reload();
                  }}
                  className={linkAction}
                >
                  Réessayer
                </button>
              )
            }
          >
            Tes prestations n’ont pas pu être chargées.
          </Notice>
        ) : load.services.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-7">
            <p className="font-display text-[26px] leading-tight text-ink">
              Ajoute ta première prestation
            </p>
            <p className="max-w-prose text-[14.5px] text-ink-soft">
              Une prestation a un nom, une durée et un prix. Elle est ensuite
              proposée quand tu ajoutes un rendez-vous dans l’agenda.
            </p>
            <Button
              size="md"
              onClick={openCreate}
              icon={<PlusIcon size={17} />}
            >
              Ajouter une prestation
            </Button>
          </div>
        ) : (
          <>
            <p className="text-[13.5px] text-ink-muted">
              Une prestation désactivée n’est plus proposée pour un nouveau
              rendez-vous. Les rendez-vous déjà pris la gardent.
            </p>
            {typeof ordering === "object" ? (
              <Notice tone="error" title="Ordre non enregistré">
                {ordering.code === "validation_error"
                  ? "Ta liste a changé entre-temps : elle a été rechargée. Recommence le déplacement."
                  : "Le nouvel ordre n’a pas pu être enregistré. L’ordre affiché est celui enregistré."}
              </Notice>
            ) : null}
            <ol
              aria-label="Tes prestations, dans l’ordre"
              aria-busy={ordering === "saving"}
              className="flex flex-col gap-3"
            >
              {load.services.map((service, index) => (
                <ServiceRow
                  key={service.id}
                  service={service}
                  currency={load.currency}
                  index={index}
                  count={load.services.length}
                  row={row?.id === service.id ? row : null}
                  locked={pending || ordering === "saving"}
                  onEdit={() => setSheet({ mode: "edit", service })}
                  onToggle={() => void toggleActive(service)}
                  onMove={(delta) => void move(index, delta)}
                  onDelete={() => {
                    setRow(null);
                    setDeleting(service);
                  }}
                />
              ))}
            </ol>
          </>
        )}

        <p className="sr-only" role="status">
          {announcement}
        </p>
      </div>

      {load.status === "ready" ? (
        <ServiceSheet
          target={sheet}
          currency={load.currency}
          scope={scope}
          onClose={() => setSheet(null)}
          onSaved={(service, created) => {
            if (created) {
              // A resend may answer a service already listed: once only.
              setLoad((value) =>
                value.status === "ready"
                  ? {
                      ...value,
                      services: value.services.some(
                        (item) => item.id === service.id,
                      )
                        ? value.services.map((item) =>
                            item.id === service.id ? service : item,
                          )
                        : [...value.services, service],
                    }
                  : value,
              );
              setAnnouncement(`${service.name} a été ajoutée.`);
            } else {
              replace(service);
              setAnnouncement(`${service.name} a été enregistrée.`);
            }
            // The server's order and values decide.
            reload();
          }}
          onGone={reload}
          onReload={reload}
          readCurrent={readCurrent}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title="Supprimer cette prestation ?"
        description={
          deleting ? `${deleting.name} disparaîtra de ta liste.` : undefined
        }
        confirmLabel={deleteError?.code === "in_use" ? "Compris" : "Supprimer"}
        tone={deleteError?.code === "in_use" ? "default" : "danger"}
        state={row?.kind === "delete" && !row.error ? "loading" : "idle"}
        onConfirm={() =>
          deleteError?.code === "in_use" ? closeDelete() : void confirmDelete()
        }
        onCancel={closeDelete}
      >
        {deleteError ? (
          deleteError.code === "in_use" ? (
            <Notice
              tone="warning"
              title="Elle a déjà des rendez-vous"
              action={
                deleting?.active ? (
                  <button
                    type="button"
                    className={linkAction}
                    onClick={() => {
                      const service = deleting;
                      closeDelete();
                      if (service) void toggleActive(service, true);
                    }}
                  >
                    La désactiver plutôt
                  </button>
                ) : undefined
              }
            >
              Elle ne peut pas être supprimée : son historique est conservé.
              {deleting?.active
                ? " Désactive-la pour ne plus la proposer."
                : " Elle est déjà désactivée."}
            </Notice>
          ) : (
            <Notice tone="error" title="Suppression impossible">
              La prestation n’a pas pu être supprimée. Réessaie.
            </Notice>
          )
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function ServiceRow({
  service,
  currency,
  index,
  count,
  row,
  locked,
  onEdit,
  onToggle,
  onMove,
  onDelete,
}: {
  service: ServiceView;
  currency: string;
  index: number;
  count: number;
  row: RowState | null;
  locked: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const switchId = `active-${service.id}`;
  const base =
    "flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-xl px-2.5 text-[13.5px] font-medium disabled:cursor-not-allowed disabled:opacity-40";
  const small = cn(base, "text-ink-soft hover:bg-sand hover:text-ink");
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-4 py-4 sm:px-5",
        !service.active && "bg-paper",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[16px] font-semibold wrap-anywhere text-ink">
            {service.name}
            {!service.active ? (
              <span className="ml-2 rounded-full bg-sand px-2 py-0.5 align-middle text-[11.5px] font-medium text-ink-soft">
                Désactivée
              </span>
            ) : null}
          </h2>
          <p className="text-[14px] text-ink-soft tabular-nums">
            {durationLabel(service.durationMinutes)} ·{" "}
            {formatPrice(service.priceCents, currency)}
          </p>
          {service.description ? (
            <p className="line-clamp-2 text-[13.5px] wrap-anywhere text-ink-muted">
              {service.description}
            </p>
          ) : null}
        </div>
        <label
          htmlFor={switchId}
          className="flex shrink-0 items-center gap-2 text-[13px] text-ink-soft"
        >
          <span className="hidden sm:inline">
            {service.active ? "Proposée" : "Désactivée"}
          </span>
          <Switch
            id={switchId}
            checked={service.active}
            onChange={onToggle}
            disabled={locked}
            aria-label={`Proposer ${service.name}`}
          />
        </label>
      </div>

      {row?.kind === "active" && row.error ? (
        <p role="alert" className="text-[13.5px] text-danger">
          {row.error.code === "not_found"
            ? "Cette prestation n’existe plus : la liste a été rechargée."
            : "Le changement n’a pas pu être enregistré. Réessaie."}
        </p>
      ) : null}

      <div className="-mx-1 flex flex-wrap items-center gap-1 border-t border-line pt-2">
        <button
          type="button"
          onClick={onEdit}
          disabled={locked}
          aria-label={`Modifier ${service.name}`}
          className={small}
        >
          Modifier
        </button>
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={locked || index === 0}
          aria-label={`Monter ${service.name}`}
          className={small}
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={locked || index === count - 1}
          aria-label={`Descendre ${service.name}`}
          className={small}
        >
          ↓
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={locked}
          aria-label={`Supprimer ${service.name}`}
          className={cn(base, "ml-auto text-danger hover:bg-danger-soft/60")}
        >
          Supprimer
        </button>
      </div>
    </li>
  );
}

const noSubscription = () => () => {};

function isUnconfirmed(raw: string | null) {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { unconfirmed?: boolean }).unconfirmed === true;
  } catch {
    return false;
  }
}
