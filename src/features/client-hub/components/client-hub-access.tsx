"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CheckIcon, CopyIcon, LockIcon, MailIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  getClientHubAccessAction,
  setClientHubAccessAction,
} from "@/features/client-hub/actions/access";
import type { ClientHubAccessDto } from "@/features/client-hub/types";
import { CrmError } from "@/features/crm/components/crm-error";
import {
  WriteError,
  isUncertain,
} from "@/features/loyalty/components/loyalty-parts";

import { shortDate } from "../client/format";

// The professional's control over a customer's Client Hub access, on her
// CRM record (docs/CLIENT_HUB_CONTRACT.md §5). Never automatic: a member
// vouches that the record belongs to whoever controls its current email.
// The grant carries `expectedEmail` (the address shown here), so a record
// whose email changed meanwhile is refused (`stale_client`), never granted
// for an address she did not see. The email shown as authorized is the one
// the backend returns. No invitation is sent (none exists yet).

const sameEmail = (a: string | null, b: string | null) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** The hub's address, to give the customer by hand. */
function hubUrl() {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ??
    (typeof window === "undefined" ? undefined : window.location.origin);
  try {
    return new URL("/espace", origin).toString();
  } catch {
    return "/espace";
  }
}

type Read =
  | { status: "loading" }
  | { status: "ready"; access: ClientHubAccessDto }
  | { status: "error"; error: UiError };

export function ClientHubAccess({
  clientId,
  email,
  displayName,
  timezone,
  onEditClient,
  onStale,
}: {
  clientId: string;
  /** The business time zone (dates of the access). */
  timezone: string;
  /** The record's email as shown on this page. */
  email: string | null;
  displayName: string;
  onEditClient: () => void;
  /** The record changed meanwhile: read the profile again. */
  onStale: () => void;
}) {
  const headingId = useId();
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [confirm, setConfirm] = useState<"grant" | "revoke" | null>(null);
  const [write, setWrite] = useState<"idle" | "loading" | UiError>("idle");
  const [done, setDone] = useState<string | null>(null);
  /** The address access was granted for before the record's email changed. */
  const [revokedFor, setRevokedFor] = useState<string | null>(null);
  const reads = useRef(0);
  const writes = useRef(0);
  const granted = useRef<string | null>(null);

  // Read on arrival, on retry, and whenever the record's email changes
  // (a change of email revokes the access in the database).
  useEffect(() => {
    const token = (reads.current += 1);
    void callAction(() => getClientHubAccessAction({ clientId })).then(
      (result) => {
        if (token !== reads.current) return;
        if (result.ok) {
          const before = granted.current;
          if (before && !result.data.granted && !sameEmail(before, email)) {
            setRevokedFor(before);
          }
          granted.current = result.data.granted ? result.data.email : null;
          setRead({ status: "ready", access: result.data });
        } else {
          setRead({ status: "error", error: result.error });
        }
      },
    );
    return () => {
      reads.current += 1;
    };
  }, [clientId, email, run]);

  const reread = () => setRun((value) => value + 1);

  async function send(grant: boolean) {
    if (write === "loading") return;
    const token = (writes.current += 1);
    /** The read generation this write started from. */
    const from = reads.current;
    setWrite("loading");
    setDone(null);
    const result = await callAction(() =>
      setClientHubAccessAction(
        grant
          ? { clientId, granted: true, expectedEmail: email ?? undefined }
          : { clientId, granted: false },
      ),
    );
    if (token !== writes.current) return;
    if (result.ok && reads.current !== from) {
      // The record was read again meanwhile (its email may have changed and
      // revoked the access): this answer may be out of date, read again.
      setWrite("idle");
      setConfirm(null);
      reread();
      return;
    }
    if (result.ok) {
      reads.current += 1; // older reads are superseded by this answer
      granted.current = result.data.granted ? result.data.email : null;
      setRevokedFor(null);
      setRead({ status: "ready", access: result.data });
      setWrite("idle");
      setConfirm(null);
      setDone(
        result.data.granted
          ? `Accès ouvert pour ${result.data.email}. Aucune invitation n’est envoyée : transmets-lui le lien de son espace.`
          : "Accès retiré : son espace n’affiche plus rien de ta part.",
      );
      return;
    }
    setWrite(result.error);
    if (
      result.error.code === "stale_client" ||
      result.error.code === "client_hub_email_required"
    ) {
      // The record changed: never decide on what this page showed.
      setConfirm(null);
      onStale();
      reread();
    } else if (isUncertain(result.error)) {
      // Without an answer it may have been applied: read the truth.
      setConfirm(null);
      reread();
    }
  }

  useEffect(
    () => () => {
      writes.current += 1;
      reads.current += 1;
    },
    [],
  );

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2
          id={headingId}
          className="font-display text-[22px] leading-tight text-ink"
        >
          Espace client
        </h2>
        {read.status === "ready" ? (
          read.access.granted ? (
            <span className="inline-flex h-6 items-center gap-1 rounded-full bg-success-soft px-2.5 text-[12px] font-semibold text-success">
              <CheckIcon size={13} strokeWidth={2.2} /> Accès autorisé
            </span>
          ) : (
            <span className="inline-flex h-6 items-center rounded-full bg-sand px-2.5 text-[12px] font-semibold text-ink-soft">
              Non autorisé
            </span>
          )
        ) : null}
      </div>

      {read.status === "loading" ? (
        <p role="status" className="text-[14px] text-ink-muted">
          Chargement de l’accès…
        </p>
      ) : read.status === "error" ? (
        <CrmError error={read.error} onRetry={reread}>
          {read.error.code === "unauthenticated"
            ? undefined
            : "L’accès à l’espace client n’a pas pu être chargé."}
        </CrmError>
      ) : (
        <Body
          access={read.access}
          email={email}
          displayName={displayName}
          timezone={timezone}
          revokedFor={revokedFor}
          busy={write === "loading"}
          onGrant={() => {
            setWrite("idle");
            setConfirm("grant");
          }}
          onRevoke={() => {
            setWrite("idle");
            setConfirm("revoke");
          }}
          onEditClient={onEditClient}
          onReload={() => {
            onStale();
            reread();
          }}
        />
      )}

      {done ? <Notice tone="success">{done}</Notice> : null}
      {typeof write === "object" && confirm === null ? (
        write.code === "stale_client" ||
        write.code === "client_hub_email_required" ? (
          // Its own words: the record is already being read again.
          <Notice tone="warning" title="Rien n’a été autorisé">
            {write.code === "stale_client"
              ? "L’email de la fiche a changé entre-temps. La fiche vient d’être relue : vérifie la nouvelle adresse avant de recommencer."
              : "La fiche n’a plus d’adresse email. Ajoute-la avant d’ouvrir son espace client."}
          </Notice>
        ) : (
          <WriteError
            error={write}
            uncertain="Sans réponse, le changement a peut-être été enregistré : l’état affiché vient d’être relu."
          >
            Le changement n’a pas été enregistré.
          </WriteError>
        )
      ) : null}

      <ConfirmDialog
        open={confirm === "grant" && read.status === "ready" && Boolean(email)}
        title="Ouvrir l’espace client ?"
        description={
          <>
            Pour <strong className="font-semibold text-ink">{email}</strong>
          </>
        }
        confirmLabel="Autoriser l’accès"
        state={write === "loading" ? "loading" : "idle"}
        onConfirm={() => void send(true)}
        onCancel={() => setConfirm(null)}
      >
        <div className="flex flex-col gap-3 text-[14.5px] leading-relaxed text-ink-soft">
          <p>
            Vérifie que cette adresse appartient bien à{" "}
            <strong className="font-semibold text-ink">{displayName}</strong>.
            En se connectant avec un code reçu à cette adresse, elle verra :
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>
              ses rendez-vous à venir et passés, y compris les réservations
              faites avant aujourd’hui ;
            </li>
            <li>son solde de points, son historique et ses récompenses.</li>
          </ul>
          <p>
            Jamais tes notes, les motifs d’annulation ou d’ajustement, ni les
            autres fiches. Elle ne peut rien modifier.
          </p>
          {typeof write === "object" ? (
            <WriteError error={write}>Rien n’a été autorisé.</WriteError>
          ) : null}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirm === "revoke" && read.status === "ready"}
        title="Retirer l’accès ?"
        description={displayName}
        confirmLabel="Retirer l’accès"
        tone="danger"
        state={write === "loading" ? "loading" : "idle"}
        onConfirm={() => void send(false)}
        onCancel={() => setConfirm(null)}
      >
        <div className="flex flex-col gap-3 text-[14.5px] leading-relaxed text-ink-soft">
          <p>
            Dès maintenant, son espace n’affiche plus rien de ton activité, même
            si elle est déjà connectée. Ses rendez-vous et ses points ne
            changent pas.
          </p>
          {typeof write === "object" ? (
            <WriteError error={write}>L’accès n’a pas été retiré.</WriteError>
          ) : null}
        </div>
      </ConfirmDialog>
    </section>
  );
}

function Body({
  access,
  email,
  displayName,
  timezone,
  revokedFor,
  busy,
  onGrant,
  onRevoke,
  onEditClient,
  onReload,
}: {
  access: ClientHubAccessDto;
  email: string | null;
  displayName: string;
  timezone: string;
  revokedFor: string | null;
  busy: boolean;
  onGrant: () => void;
  onRevoke: () => void;
  onEditClient: () => void;
  onReload: () => void;
}) {
  if (access.granted) {
    const mismatch = !sameEmail(access.email, email);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-3.5 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success-soft text-success">
            <MailIcon size={17} />
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-[12.5px] text-ink-muted">
              Adresse autorisée
            </span>
            <span className="text-[14.5px] font-medium wrap-anywhere text-ink">
              {access.email}
            </span>
          </div>
        </div>
        {access.grantedAt ? (
          <p className="text-[13px] text-ink-muted">
            Autorisé le {shortDate(access.grantedAt, timezone)}.
          </p>
        ) : null}
        {mismatch ? (
          <Notice
            tone="warning"
            action={
              <button
                type="button"
                onClick={onReload}
                className="cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
              >
                Recharger la fiche
              </button>
            }
          >
            L’accès est autorisé pour une autre adresse que celle affichée : la
            fiche a peut-être changé entre-temps.
          </Notice>
        ) : null}
        <p className="text-[13.5px] leading-relaxed text-ink-soft">
          Changer l’email de la fiche retire automatiquement l’accès : il faudra
          l’autoriser à nouveau pour la nouvelle adresse.
        </p>
        <HubLink />
        <Button
          variant="secondary"
          size="md"
          onClick={onRevoke}
          disabled={busy}
          className="w-fit"
        >
          Retirer l’accès
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {revokedFor ? (
        <Notice tone="info" title="Accès retiré">
          L’email de la fiche a changé : l’accès accordé à {revokedFor} a été
          retiré automatiquement.
        </Notice>
      ) : null}
      {email ? (
        <>
          <p className="text-[14px] leading-relaxed text-ink-soft">
            {displayName} pourra consulter ses rendez-vous et sa fidélité en se
            connectant avec un code reçu à{" "}
            <strong className="font-semibold wrap-anywhere text-ink">
              {email}
            </strong>
            .
          </p>
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-ink-muted">
            <LockIcon size={15} className="mt-0.5 shrink-0" />
            Rien n’est ouvert sans ton accord, et aucune invitation n’est
            envoyée : tu lui transmets toi-même le lien de son espace.
          </p>
          <Button size="md" onClick={onGrant} disabled={busy} className="w-fit">
            Autoriser l’accès
          </Button>
        </>
      ) : (
        <>
          <p className="text-[14px] leading-relaxed text-ink-soft">
            Ajoute une adresse email à la fiche pour pouvoir ouvrir son espace
            client.
          </p>
          <button
            type="button"
            onClick={onEditClient}
            className="flex h-10 w-fit cursor-pointer items-center rounded-xl border border-line px-3 text-[13.5px] font-medium text-ink hover:border-line-strong"
          >
            Ajouter un email
          </button>
        </>
      )}
    </div>
  );
}

function HubLink() {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [url] = useState(hubUrl);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-ink-muted">
        Lien à lui transmettre
      </span>
      <div className="flex min-w-0 items-center gap-2 rounded-2xl border border-line bg-paper px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
          {url}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copier le lien de l’espace client"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-ink-soft hover:bg-sand/70 hover:text-ink"
        >
          {copied === "copied" ? (
            <CheckIcon size={17} />
          ) : (
            <CopyIcon size={17} />
          )}
        </button>
      </div>
      <span role="status" className="text-[12.5px] text-ink-muted">
        {copied === "copied"
          ? "Lien copié."
          : copied === "failed"
            ? "Copie impossible : sélectionne le lien."
            : ""}
      </span>
    </div>
  );
}
