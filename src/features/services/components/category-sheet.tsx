"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "@/features/agenda/client/request-id";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
} from "@/features/catalog/actions/catalog";
import type { CatalogCategory } from "@/features/catalog/client/catalog-view";
import { catalogLimits } from "@/features/catalog/model";

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/** Which form is open: a new category, or one of hers. */
export type CategorySheetTarget =
  | { mode: "create" }
  | { mode: "edit"; category: CatalogCategory; serviceCount: number };

/** The category as it is now, read after a refused edit. */
export type CurrentCategory =
  | { status: "found"; category: CatalogCategory }
  | { status: "gone" }
  | { status: "error"; error: UiError };

type Draft = { name: string; visible: boolean };

/**
 * Creates, edits or deletes one of her categories (docs/CATALOG_CONTRACT.md).
 * Every write is applied at once, as soon as the server accepts it: there is
 * no draft of the catalogue, only of the mini-site's design.
 *
 * - Creation: one request id per command, kept for the same values. A
 *   resend after a lost answer never creates a second category.
 * - Edit: sent with the version it was read at. Changed elsewhere
 *   (stale_category): the current version is read and shown; nothing is
 *   sent until she chooses.
 * - Deletion: said before, never by omission. Her services stay, without a
 *   category: nothing she booked or priced is lost.
 */
export function CategorySheet({
  target,
  onClose,
  onSaved,
  onDeleted,
  onReload,
  readCurrent,
}: {
  target: CategorySheetTarget | null;
  onClose: () => void;
  onSaved: (category: CatalogCategory, created: boolean) => void;
  onDeleted: (category: CatalogCategory) => void;
  /** Her catalogue should be read again. */
  onReload: () => void;
  readCurrent: (categoryId: string) => Promise<CurrentCategory>;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Sheet
      open={target !== null}
      onClose={() => (saving ? undefined : onClose())}
      title={
        target?.mode === "edit" ? "Modifier la catégorie" : "Nouvelle catégorie"
      }
      description="Les catégories rangent tes prestations, ici et sur ta page de réservation. Elles sont à toi : aucune n’est imposée."
    >
      {target?.mode === "create" ? (
        <CreateForm
          key="new"
          onSavingChange={setSaving}
          onClose={onClose}
          onSaved={(category) => onSaved(category, true)}
          onReload={onReload}
        />
      ) : target?.mode === "edit" ? (
        <EditForm
          key={target.category.id}
          category={target.category}
          serviceCount={target.serviceCount}
          onSavingChange={setSaving}
          onClose={onClose}
          onSaved={(category) => onSaved(category, false)}
          onDeleted={onDeleted}
          onReload={onReload}
          readCurrent={readCurrent}
        />
      ) : null}
    </Sheet>
  );
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

function checkName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "Donne un nom à la catégorie.";
  if (trimmed.length > catalogLimits.categoryName)
    return `Nom limité à ${catalogLimits.categoryName} caractères.`;
  return null;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function CreateForm({
  onSavingChange,
  onClose,
  onSaved,
  onReload,
}: {
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (category: CatalogCategory) => void;
  onReload: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({ name: "", visible: true });
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<UiError | null>(null);
  const [state, setState] = useState<ButtonState>("idle");
  /** The request id of the last command sent, for its values. */
  const key = useRef<RequestKey | null>(null);
  const alive = useAlive();
  useEffect(() => () => onSavingChange(false), [onSavingChange]);
  const busy = state !== "idle";

  async function save(fresh = false) {
    if (busy) return;
    const refused = checkName(draft.name);
    if (refused) return setError(refused);
    const command = { name: draft.name.trim(), visible: draft.visible };
    const fingerprint = fingerprintOf(command);
    // Same values: same request id (never a second category).
    key.current = fresh
      ? { fingerprint, id: crypto.randomUUID() }
      : requestKeyFor(key.current, fingerprint);
    const requestId = key.current.id;
    setFailure(null);
    setState("loading");
    onSavingChange(true);
    const result = await callAction(() =>
      createCategoryAction({ ...command, requestId }),
    );
    if (!alive.current) return;
    setState("idle");
    onSavingChange(false);
    if (result.ok) {
      onSaved(result.data);
      onClose();
      return;
    }
    if (result.error.code === "category_deleted") onReload();
    if (result.error.fieldErrors?.name)
      setError("Vérifie le nom (1 à 60 caractères).");
    else setFailure(result.error);
  }

  const choices = (
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      <button
        type="button"
        onClick={() => void save(true)}
        className={linkAction}
      >
        La créer comme nouvelle catégorie
      </button>
      <button type="button" onClick={onClose} className={linkAction}>
        Abandonner
      </button>
    </div>
  );

  return (
    <form
      noValidate
      aria-busy={state === "loading"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-5 pt-1"
    >
      <Fields
        draft={draft}
        error={error}
        busy={busy}
        onChange={(next) => {
          if (busy) return;
          setDraft(next);
          setError(null);
        }}
      />
      {failure?.code === "network" || failure?.code === "internal" ? (
        <Notice
          tone={failure.code === "network" ? "offline" : "error"}
          title="Création non confirmée"
          action={
            <button
              type="button"
              onClick={() => void save()}
              className={linkAction}
            >
              Réessayer
            </button>
          }
        >
          La catégorie a peut-être été créée. Réessaie sans rien changer : le
          même envoi ne crée jamais deux catégories.
        </Notice>
      ) : failure?.code === "idempotency_conflict" ? (
        <Notice tone="warning" title="Rien n’a été créé" action={choices}>
          Cet envoi avait déjà servi à créer une autre catégorie. Vérifie ta
          liste avant d’en créer une nouvelle.
        </Notice>
      ) : failure?.code === "category_deleted" ? (
        <Notice
          tone="warning"
          title="Catégorie supprimée depuis"
          action={choices}
        >
          Cette catégorie avait été créée, puis supprimée : elle n’a pas été
          recréée. Ta liste a été actualisée.
        </Notice>
      ) : failure ? (
        <CommonFailure error={failure} onRetry={() => void save()} />
      ) : null}
      <Footer state={state} onClose={onClose} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Edit and deletion
// ---------------------------------------------------------------------------

const draftOf = (category: CatalogCategory): Draft => ({
  name: category.name,
  visible: category.visible,
});

function EditForm({
  category,
  serviceCount,
  onSavingChange,
  onClose,
  onSaved,
  onDeleted,
  onReload,
  readCurrent,
}: {
  category: CatalogCategory;
  serviceCount: number;
  onSavingChange: (saving: boolean) => void;
  onClose: () => void;
  onSaved: (category: CatalogCategory) => void;
  onDeleted: (category: CatalogCategory) => void;
  onReload: () => void;
  readCurrent: (categoryId: string) => Promise<CurrentCategory>;
}) {
  /** The version her draft is based on. */
  const [base, setBase] = useState(category);
  const [draft, setDraft] = useState<Draft>(() => draftOf(category));
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<UiError | null>(null);
  const [current, setCurrent] = useState<
    CurrentCategory | { status: "loading" } | null
  >(null);
  const [state, setState] = useState<ButtonState>("idle");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<ButtonState>("idle");
  const reads = useRef(0);
  const alive = useAlive();
  useEffect(() => () => onSavingChange(false), [onSavingChange]);
  const busy = state !== "idle" || deleting !== "idle";
  const stale = failure?.code === "stale_category";
  const gone =
    failure?.code === "category_not_found" || current?.status === "gone";

  function compare() {
    setCurrent({ status: "loading" });
    const read = (reads.current += 1);
    void readCurrent(category.id).then((found) => {
      if (!alive.current || read !== reads.current) return;
      setCurrent(found);
      if (found.status === "gone") onReload();
    });
  }

  async function save() {
    if (busy || stale || gone) return;
    const refused = checkName(draft.name);
    if (refused) return setError(refused);
    const name = draft.name.trim();
    // Only what she changed, on the version it was read at.
    const changes = {
      ...(name !== base.name ? { name } : {}),
      ...(draft.visible !== base.visible ? { visible: draft.visible } : {}),
    };
    if (Object.keys(changes).length === 0) return onClose();
    setFailure(null);
    setCurrent(null);
    setState("loading");
    onSavingChange(true);
    const result = await callAction(() =>
      updateCategoryAction({
        categoryId: category.id,
        expectedVersion: base.version,
        ...changes,
      }),
    );
    if (!alive.current) return;
    setState("idle");
    onSavingChange(false);
    if (result.ok) {
      onSaved(result.data);
      onClose();
      return;
    }
    if (result.error.fieldErrors?.name)
      return setError("Vérifie le nom (1 à 60 caractères).");
    setFailure(result.error);
    if (result.error.code === "category_not_found") onReload();
    // Changed elsewhere: read it now, to compare.
    if (result.error.code === "stale_category") compare();
  }

  /** What she changed stays; every other field takes the current value. */
  function keepMine(latest: CatalogCategory) {
    const before = draftOf(base);
    setDraft({
      name: draft.name.trim() === before.name ? latest.name : draft.name,
      visible:
        draft.visible === before.visible ? latest.visible : draft.visible,
    });
    setBase(latest);
    setFailure(null);
    setCurrent(null);
  }

  function takeTheirs(latest: CatalogCategory) {
    setDraft(draftOf(latest));
    setBase(latest);
    setFailure(null);
    setCurrent(null);
    setError(null);
  }

  async function remove() {
    if (busy) return;
    setDeleting("loading");
    onSavingChange(true);
    const result = await callAction(() =>
      deleteCategoryAction({ categoryId: category.id }),
    );
    if (!alive.current) return;
    setDeleting("idle");
    onSavingChange(false);
    // Already deleted elsewhere: what she asked for is done.
    if (result.ok || result.error.code === "category_not_found") {
      onDeleted(category);
      onClose();
      return;
    }
    setConfirming(false);
    setFailure(result.error);
  }

  return (
    <form
      noValidate
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-5 pt-1"
    >
      <Fields
        draft={draft}
        error={error}
        busy={busy}
        onChange={(next) => {
          if (busy) return;
          setDraft(next);
          setError(null);
        }}
      />

      {gone ? (
        <Notice tone="warning" title="Catégorie supprimée entre-temps">
          Elle n’existe plus : ses prestations sont restées dans ta liste, sans
          catégorie. Ta liste a été actualisée.
        </Notice>
      ) : stale ? (
        <StaleCategory
          base={base}
          draft={draft}
          current={current}
          onCompare={compare}
          onKeepMine={keepMine}
          onTakeTheirs={takeTheirs}
        />
      ) : failure ? (
        <CommonFailure error={failure} onRetry={() => void save()} />
      ) : null}

      {gone ? null : confirming ? (
        <Notice
          tone="warning"
          title={`Supprimer « ${category.name} » ?`}
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="md"
                state={deleting}
                loadingLabel="Suppression…"
                onClick={() => void remove()}
              >
                Supprimer la catégorie
              </Button>
              <Button
                variant="ghost"
                size="md"
                disabled={deleting !== "idle"}
                onClick={() => setConfirming(false)}
              >
                Garder
              </Button>
            </div>
          }
        >
          {serviceCount === 0
            ? "Elle ne contient aucune prestation."
            : serviceCount === 1
              ? "Sa prestation reste dans ta liste, sans catégorie, avec son prix et ses rendez-vous."
              : `Ses ${serviceCount} prestations restent dans ta liste, sans catégorie, avec leurs prix et leurs rendez-vous.`}
        </Notice>
      ) : (
        <Button
          variant="ghost"
          size="md"
          disabled={busy}
          onClick={() => setConfirming(true)}
          className="self-start"
        >
          <span className="text-danger">Supprimer cette catégorie</span>
        </Button>
      )}

      <Footer state={state} onClose={onClose} saveDisabled={stale || gone} />
    </form>
  );
}

function StaleCategory({
  base,
  draft,
  current,
  onCompare,
  onKeepMine,
  onTakeTheirs,
}: {
  base: CatalogCategory;
  draft: Draft;
  current: CurrentCategory | { status: "loading" } | null;
  onCompare: () => void;
  onKeepMine: (latest: CatalogCategory) => void;
  onTakeTheirs: (latest: CatalogCategory) => void;
}) {
  if (current?.status === "found") {
    const latest = current.category;
    const visibility = (visible: boolean) =>
      visible ? "visible en ligne" : "masquée en ligne";
    return (
      <Notice tone="warning" title="Version actuelle de la catégorie">
        <dl className="mt-1 flex flex-col gap-2">
          {latest.name !== base.name ? (
            <div className="flex flex-col">
              <dt className="font-semibold">Nom</dt>
              <dd className="wrap-anywhere">Maintenant : {latest.name}</dd>
              <dd className="wrap-anywhere">
                {draft.name.trim() !== base.name
                  ? `Ta saisie : ${draft.name}`
                  : "Tu ne l’avais pas modifié : la valeur actuelle sera gardée."}
              </dd>
            </div>
          ) : null}
          {latest.visible !== base.visible ? (
            <div className="flex flex-col">
              <dt className="font-semibold">En ligne</dt>
              <dd>Maintenant : {visibility(latest.visible)}</dd>
              <dd>
                {draft.visible !== base.visible
                  ? `Ton choix : ${visibility(draft.visible)}`
                  : "Tu ne l’avais pas modifié : la valeur actuelle sera gardée."}
              </dd>
            </div>
          ) : null}
        </dl>
        <p className="mt-2">
          Rien n’a été enregistré. Choisis, puis enregistre.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <button
            type="button"
            onClick={() => onKeepMine(latest)}
            className={linkAction}
          >
            Garder ma saisie
          </button>
          <button
            type="button"
            onClick={() => onTakeTheirs(latest)}
            className={linkAction}
          >
            Reprendre la version actuelle
          </button>
        </div>
      </Notice>
    );
  }
  return (
    <Notice
      tone="warning"
      title="Catégorie modifiée ailleurs"
      action={
        current?.status === "loading" ? (
          <span className="text-[14px]">
            Chargement de la version actuelle…
          </span>
        ) : (
          <button type="button" onClick={onCompare} className={linkAction}>
            Voir la version actuelle
          </button>
        )
      }
    >
      {current?.status === "error"
        ? "La version actuelle n’a pas pu être chargée. Ta saisie est conservée : réessaie."
        : "Cette catégorie a changé depuis que tu l’as ouverte. Rien n’a été enregistré et ta saisie est conservée."}
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function Fields({
  draft,
  error,
  busy,
  onChange,
}: {
  draft: Draft;
  error: string | null;
  busy: boolean;
  onChange: (next: Draft) => void;
}) {
  const id = useId();
  return (
    <>
      <TextField
        label="Nom"
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        error={error ?? undefined}
        readOnly={busy}
        maxLength={catalogLimits.categoryName}
        autoComplete="off"
        data-autofocus=""
      />
      <div className="flex items-start justify-between gap-4 rounded-2xl border border-line px-4 py-3">
        <span className="flex flex-col gap-0.5">
          <label
            htmlFor={`${id}-visible`}
            className="text-[15px] font-medium text-ink"
          >
            Visible sur ta page de réservation
          </label>
          <span id={`${id}-said`} className="text-[13.5px] text-ink-muted">
            {draft.visible
              ? "Ses prestations actives sont réservables en ligne."
              : "Masquée : ses prestations ne sont plus réservables en ligne. Tu peux toujours les ajouter dans ton agenda."}
          </span>
        </span>
        <Switch
          id={`${id}-visible`}
          aria-describedby={`${id}-said`}
          checked={draft.visible}
          disabled={busy}
          onChange={(event) =>
            onChange({ ...draft, visible: event.target.checked })
          }
        />
      </div>
    </>
  );
}

function Footer({
  state,
  saveDisabled = false,
  onClose,
}: {
  state: ButtonState;
  saveDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="sticky -bottom-6 -mx-5 -mb-6 flex flex-col-reverse gap-2 border-t border-line bg-paper-raised px-5 pt-3 pb-[max(env(safe-area-inset-bottom),1.25rem)] sm:-mx-6 sm:flex-row sm:justify-end sm:px-6">
      <Button
        variant="ghost"
        size="md"
        onClick={onClose}
        disabled={state !== "idle"}
      >
        Annuler
      </Button>
      <Button
        type="submit"
        size="md"
        state={state}
        loadingLabel="Enregistrement…"
        disabled={saveDisabled}
        className="sm:min-w-36"
      >
        Enregistrer
      </Button>
    </div>
  );
}

function CommonFailure({
  error,
  onRetry,
}: {
  error: UiError;
  onRetry: () => void;
}) {
  if (error.code === "unauthenticated")
    return (
      <Notice
        tone="error"
        title="Session expirée"
        action={
          <a href="/login" className={linkAction}>
            Me reconnecter
          </a>
        }
      >
        Reconnecte-toi pour enregistrer. Ta saisie reste ici tant que la page
        est ouverte.
      </Notice>
    );
  return (
    <Notice
      tone={error.code === "network" ? "offline" : "error"}
      title={
        error.code === "network"
          ? "Connexion interrompue"
          : "Enregistrement impossible"
      }
      action={
        <button type="button" onClick={onRetry} className={linkAction}>
          Réessayer
        </button>
      }
    >
      {error.code === "network"
        ? "La modification a peut-être été enregistrée. Réessaie : les mêmes valeurs ne changent rien."
        : "La catégorie n’a pas pu être enregistrée. Ta saisie est conservée."}
    </Notice>
  );
}
