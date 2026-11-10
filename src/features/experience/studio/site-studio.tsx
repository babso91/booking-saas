"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type MouseEvent } from "react";

import type { SiteConfig as SavedConfig } from "@/features/sites/config";
import type {
  SiteDto,
  SitePlan,
  SiteVersionSummary,
} from "@/features/sites/data/sites";

import type { ShowcaseGroup } from "../catalog/model";
import type { PhotoSlot, SiteConfig } from "../engine/config";
import { renderConfigOf } from "../engine/from-site";
import { ensureReadable } from "../engine/harmony";
import { MiniSite } from "../mini-site";
import {
  studioActionsFor,
  type StudioActions,
  type UploadType,
} from "./actions";
import { useDraftSync, type DraftStatus } from "./draft-sync";
import { useHistory } from "./history";
import type { UploadOutcome } from "./photo-editor";
import { effective } from "./plans";
import { StudioPhotos, studioPhoto } from "./photos";
import { firstDraft, savedConfigOf, withDemoPhotos } from "./saved";
import { Studio, type Online } from "./studio";
import { universes, type UniverseId } from "./universes";

// Her studio, on her real site (docs/SITE_PUBLISHING_CONTRACT.md): her
// draft (saved by itself, on its revision), her site as the preview, her
// version online, publishing, her history, her photos. Her plan is the
// server's. Her catalogue is the server's projection (get_public_catalog):
// shown, never edited nor published here.

export type StudioPhoto = {
  id: string;
  status: "pending" | "ready" | "revoked";
};

const UPLOAD_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
] satisfies UploadType[];

export function SiteStudio({
  site,
  plan,
  online: initialOnline,
  catalog,
  businessName,
  slug,
  photos: initialPhotos,
  fontClasses,
  businessId,
  actions: given,
}: {
  /** Her site as read now (null: nothing saved yet). */
  site: SiteDto | null;
  /** Her plan, set on the server only (never from here). */
  plan: SitePlan;
  /** Her published version's configuration, with its number and date. */
  online: { config: SavedConfig; number: number; publishedAt: string } | null;
  catalog: ShowcaseGroup[];
  businessName: string;
  /** Her public page's address: /b/[slug]. */
  slug: string;
  photos: StudioPhoto[];
  fontClasses: string;
  /** The business this studio is opened for: every call carries it. */
  businessId: string;
  /** Her server; an in-memory one only in a design preview or a test. */
  actions?: StudioActions;
}) {
  const actions = useMemo(
    () => given ?? studioActionsFor(businessId),
    [given, businessId],
  );
  const router = useRouter();
  const history = useHistory<SiteConfig>(
    site?.config
      ? renderConfigOf(site.config)
      : firstDraft(universes.mila, businessName),
  );
  const draft = history.value;
  const design = draft.universe as UniverseId;
  const universe = universes[design];

  const sync = useDraftSync({
    value: draft,
    revision: site?.revision ?? 0,
    saved: site?.config ?? null,
    save: actions.save,
    read: async () => {
      const result = await actions.read();
      return result.ok
        ? {
            ok: true as const,
            data: result.data
              ? { revision: result.data.revision, config: result.data.config }
              : null,
          }
        : result;
    },
    replace: history.reset,
  });

  const photoSource = actions.photo ?? studioPhoto;
  const [online, setOnline] = useState<Online>(
    initialOnline
      ? {
          config: renderConfigOf(initialOnline.config),
          number: initialOnline.number,
          publishedAt: initialOnline.publishedAt,
        }
      : null,
  );
  const [photos, setPhotos] = useState(initialPhotos);
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<"draft" | "live">("draft");
  const [photoSlot, setPhotoSlot] = useState<PhotoSlot | null>(null);
  const [replay, setReplay] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Her universe dressed with its demo photos where she has none yet:
  // only in this preview, never saved.
  const ownPhotos = photos.some((photo) => photo.status === "ready");
  const [dressed, setDressed] = useState(!ownPhotos);

  const revoked = useMemo(
    () =>
      photos
        .filter((photo) => photo.status === "revoked")
        .map((photo) => photo.id),
    [photos],
  );
  const library = photos
    .filter((photo) => photo.status === "ready")
    .map((photo) => photo.id);

  const say = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 4000);
  };

  // What the preview shows: her draft through her plan's rights (and her
  // universe's photos where she has none, if she wants), or her version
  // online as her clients see it.
  const preview = useMemo(() => {
    if (view === "live")
      return online
        ? ensureReadable(
            effective(withoutRevoked(online.config, revoked), plan),
          )
        : null;
    const shown = withoutRevoked(draft, revoked);
    return effective(dressed ? withDemoPhotos(shown, universe) : shown, plan);
  }, [view, online, draft, revoked, plan, dressed, universe]);

  /**
   * Out of her library ("Mes photos"): deleted when nothing uses it, or
   * revoked for good (also from what is online). Her list follows the
   * server's answer only.
   */
  async function removeFromLibrary(
    id: string,
    forGood: boolean,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const result = await actions.removePhoto(id, forGood);
    if (!result.ok) return { ok: false, code: result.error.code };
    setPhotos((list) =>
      forGood
        ? list.map((item) =>
            item.id === id ? { ...item, status: "revoked" as const } : item,
          )
        : list.filter((item) => item.id !== id),
    );
    say(
      forGood
        ? "Photo retirée partout, définitivement."
        : "Photo supprimée de tes photos.",
    );
    return { ok: true };
  }

  async function upload(file: File): Promise<UploadOutcome> {
    if (!UPLOAD_TYPES.includes(file.type))
      return { ok: false, code: "site_photo_unsupported" };
    const sent = await actions.upload(file, file.type as UploadType);
    if (!sent.ok) return { ok: false, code: sent.error.code };
    const { id } = sent.data;
    setPhotos((list) => [{ id, status: "ready" }, ...list]);
    return { ok: true, id };
  }

  /**
   * Her links out of the studio (her space, her services): a client-side
   * navigation unmounts it without any beforeunload, so her draft is saved
   * first, and if it cannot be, she decides whether to leave anyway.
   */
  async function leave(event: MouseEvent<HTMLAnchorElement>) {
    // A new tab or window keeps the studio open: nothing to protect.
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !sync.unsaved
    )
      return;
    event.preventDefault();
    const href = (event.currentTarget.getAttribute("href") ?? "/app") as Route;
    const at = await sync.flush();
    if (
      at !== null ||
      window.confirm(
        "Tes dernières modifications n’ont pas pu être enregistrées. Quitter quand même et les perdre ?",
      )
    )
      router.push(href);
  }

  async function publish(config: SiteConfig, corrections: number) {
    setPublishing(true);
    setProblem(null);
    // Her draft, saved exactly as published (readability fixed).
    const at = await sync.flush(config);
    if (at === null) {
      setPublishing(false);
      setProblem(
        "Ton brouillon n’a pas pu être enregistré : rien n’a été publié. Regarde ci-dessus.",
      );
      return;
    }
    const result = await actions.publish(at);
    setPublishing(false);
    if (!result.ok) {
      setProblem(
        result.error.code === "site_unreadable"
          ? "Certaines couleurs ne seraient pas lisibles pour tes clientes : rien n’a été publié. Corrige-les dans Couleurs."
          : result.error.code === "stale_site_draft"
            ? "Ton brouillon a changé ailleurs pendant la publication : rien n’a été publié. Regarde ci-dessus."
            : "La publication n’a pas abouti : rien n’a changé en ligne. Réessaie.",
      );
      return;
    }
    setOnline({
      // As the server keeps it (and as her history gives it back).
      config: renderConfigOf(savedConfigOf(config)),
      number: result.data.number,
      publishedAt: result.data.publishedAt,
    });
    say(
      `En ligne · version ${result.data.number}${corrections ? ` · ${corrections} correction${corrections > 1 ? "s" : ""} de lisibilité appliquée${corrections > 1 ? "s" : ""}` : ""}`,
    );
  }

  async function restore(version: SiteVersionSummary) {
    setProblem(null);
    const restored = await actions.restore(version.id, sync.revision);
    if (!restored.ok) {
      setProblem(
        restored.error.code === "stale_site_draft"
          ? "Ton brouillon a changé entre-temps : rien n’a été remplacé. Réessaie."
          : "Cette version n’a pas pu être reprise. Réessaie.",
      );
      return;
    }
    const read = await actions.version(version.id);
    if (!read.ok) {
      setProblem(
        "La version reprise n’a pas pu être affichée : recharge la page.",
      );
      return;
    }
    sync.adopt(read.data.config, restored.data.revision);
    setView("draft");
    say(
      `Version ${version.number} reprise dans ton brouillon : publie-la quand tu veux.`,
    );
  }

  return (
    <div className="relative min-h-dvh">
      {preview ? (
        <MiniSite
          key={`${view}-${replay}`}
          config={preview}
          catalog={catalog}
          photoBase="/api/sites/photos"
          photoSource={photoSource}
          // Her studio's preview never takes a booking.
          booking={null}
          fontClasses={fontClasses}
          edit={
            view === "draft"
              ? {
                  photo: (slot) => {
                    setOpen(true);
                    setPhotoSlot(slot);
                  },
                  selected: photoSlot,
                  service: () => undefined,
                  selectedService: null,
                }
              : undefined
          }
        />
      ) : (
        <div className="flex min-h-dvh items-center justify-center bg-[#141414] p-8 text-center text-white">
          <p className="max-w-sm text-[15px] leading-relaxed text-white/80">
            Ton site n’est pas encore publié. Tes clientes voient ta page de
            réservation en attendant.
          </p>
        </div>
      )}
      <StudioPhotos.Provider value={photoSource}>
        <Studio
          open={open}
          onOpen={setOpen}
          universe={universe}
          design={design}
          draft={history}
          catalog={catalog}
          plan={plan}
          onDesign={(next) => {
            // Another universe: her name, texts and photos follow; her
            // catalogue is not part of the design at all.
            const base = universes[next].config;
            history.set({
              ...base,
              brand: draft.brand,
              content: draft.content,
              hidden: draft.hidden,
            });
            setReplay((value) => value + 1);
          }}
          published={online}
          publishing={publishing}
          onPublish={(config, corrections) => void publish(config, corrections)}
          view={view}
          onView={setView}
          photoSlot={photoSlot}
          onPhotoSlot={setPhotoSlot}
          onReplay={() => setReplay((value) => value + 1)}
          library={library}
          onUpload={upload}
          onDeletePhoto={removeFromLibrary}
          flash={flash}
          publicPath={`/b/${slug}`}
          onLeave={leave}
          status={
            <DraftState
              status={sync.status}
              problem={problem}
              dressed={dressed}
              onDressed={setDressed}
              onRetry={sync.retry}
              onKeepMine={sync.keepMine}
              onTakeTheirs={sync.takeTheirs}
            />
          }
          history={
            <History
              online={online}
              versions={actions.versions}
              onRestore={restore}
            />
          }
        />
      </StudioPhotos.Provider>
    </div>
  );
}

/** A photo withdrawn since it was chosen: its place, without it. */
function withoutRevoked(config: SiteConfig, revoked: string[]): SiteConfig {
  if (!revoked.length) return config;
  const gone = new Set(revoked);
  const keep = (id: string | null) => (id && gone.has(id) ? null : id);
  return {
    ...config,
    content: {
      ...config.content,
      cover: keep(config.content.cover),
      portrait: {
        ...config.content.portrait,
        photo: keep(config.content.portrait.photo),
      },
      works: config.content.works.map((work) => ({
        ...work,
        photo: keep(work.photo) ?? "",
      })),
    },
  };
}

function DraftState({
  status,
  problem,
  dressed,
  onDressed,
  onRetry,
  onKeepMine,
  onTakeTheirs,
}: {
  status: DraftStatus;
  problem: string | null;
  dressed: boolean;
  onDressed: (value: boolean) => void;
  onRetry: () => void;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  const said =
    status.kind === "saved"
      ? "Brouillon enregistré"
      : status.kind === "pending"
        ? "Modifications en cours…"
        : status.kind === "saving"
          ? "Enregistrement…"
          : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-black/60">
        <span role="status">{said}</span>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={dressed}
            onChange={(event) => onDressed(event.target.checked)}
            className="size-4"
          />
          Photos d’exemple dans l’aperçu
        </label>
      </div>
      {status.kind === "error" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#FDECEA] p-3 text-[13px] text-[#7A1F17]"
        >
          <span>
            {status.error.code === "network"
              ? "Connexion interrompue : tes modifications ne sont pas encore enregistrées. Elles restent ici."
              : "Tes modifications n’ont pas pu être enregistrées. Elles restent ici."}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="h-9 cursor-pointer rounded-full bg-white px-3 font-semibold"
          >
            Réessayer
          </button>
        </div>
      ) : null}
      {status.kind === "conflict" ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl bg-[#FFF4E5] p-3 text-[13px] text-[#6B3A00]"
        >
          <p>
            Ton site a été modifié ailleurs (un autre onglet ou un autre
            appareil). Rien n’a été écrasé : choisis la version à garder.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onKeepMine}
              className="h-9 cursor-pointer rounded-full bg-[#141414] px-3 font-semibold text-white"
            >
              Garder ma version
            </button>
            <button
              type="button"
              onClick={onTakeTheirs}
              className="h-9 cursor-pointer rounded-full bg-white px-3 font-semibold"
            >
              Reprendre la version enregistrée
            </button>
          </div>
        </div>
      ) : null}
      {problem ? (
        <p
          role="alert"
          className="rounded-xl bg-[#FDECEA] p-3 text-[13px] text-[#7A1F17]"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** Her published versions; one is taken back into her draft, never online directly. */
function History({
  online,
  versions: list,
  onRestore,
}: {
  online: Online;
  versions: StudioActions["versions"];
  onRestore: (version: SiteVersionSummary) => Promise<void>;
}) {
  const [read, setRead] = useState<{
    at: number | undefined;
    versions: SiteVersionSummary[];
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // Read again after each publication (a new version).
  const known = online?.number;
  useEffect(() => {
    let active = true;
    void list().then((result) => {
      if (!active) return;
      if (result.ok) setRead({ at: known, versions: result.data });
      else setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [known, list]);
  const versions = read && read.at === known ? read.versions : null;
  if (failed)
    return (
      <p role="alert" className="text-[13.5px]">
        Ton historique n’a pas pu être chargé. Réessaie plus tard.
      </p>
    );
  if (!versions)
    return (
      <p role="status" className="text-[13.5px] text-black/60">
        Chargement de ton historique…
      </p>
    );
  if (!versions.length)
    return (
      <p className="text-[13.5px] text-black/60">
        Chaque publication garde une version de ton site. Tu pourras en
        reprendre une dans ton brouillon.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13.5px] text-black/60">
        Reprendre une version la met dans ton brouillon : rien ne change en
        ligne avant que tu publies. L’historique, lui, ne change jamais.
      </p>
      <ol className="flex flex-col gap-2">
        {versions.map((version) => (
          <li
            key={version.id}
            className="flex items-center justify-between gap-3 rounded-2xl bg-white p-3"
          >
            <span className="text-[14px]">
              <strong>Version {version.number}</strong>
              {version.current ? " · en ligne" : ""}
              <span className="block text-[12.5px] text-black/55">
                {new Date(version.publishedAt).toLocaleString("fr-FR", {
                  day: "numeric",
                  month: "long",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </span>
            {asked === version.id ? (
              <span className="flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setAsked(null);
                    void onRestore(version);
                  }}
                  className="h-11 cursor-pointer rounded-full bg-[#141414] px-3 text-[13px] font-semibold text-white"
                >
                  Remplacer mon brouillon
                </button>
                <button
                  type="button"
                  onClick={() => setAsked(null)}
                  className="h-11 cursor-pointer rounded-full px-3 text-[13px]"
                >
                  Annuler
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setAsked(version.id)}
                className="h-11 cursor-pointer rounded-full bg-black/5 px-4 text-[13px] font-semibold"
              >
                Reprendre
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
