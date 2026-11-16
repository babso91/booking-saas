"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

import {
  roleLabels,
  teamErrors,
  type TeamActions,
  type TeamDto,
  type TeamMemberDto,
  type TeamResult,
} from "./contract";

// Her team: who her clients can book, and who can use the software. The
// two are separate switches, never one: a person may be bookable without
// an account, and an account may exist for someone not bookable.
// Every write is the server's to accept; a stale one is said, her typing
// kept, the team read again; a lost answer is resent with the same
// operation id.

const linkAction =
  "cursor-pointer text-left text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4 disabled:cursor-not-allowed disabled:opacity-50";

type Read =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; team: TeamDto };

/** One operation id per content: a retry of the same content reuses it. */
function useOperationIds() {
  const ids = useRef(new Map<string, string>());
  return (key: string) => {
    if (!ids.current.has(key)) ids.current.set(key, crypto.randomUUID());
    return ids.current.get(key)!;
  };
}

export function TeamManager({
  actions,
  invitations = "enabled",
}: {
  actions: TeamActions;
  /**
   * "not_sent_yet" while no email transport is validated: an invitation
   * could be recorded but would never reach her, so none is offered.
   */
  invitations?: "enabled" | "not_sent_yet";
}) {
  const [read, setRead] = useState<Read>({ status: "loading" });
  const [run, setRun] = useState(0);
  const [open, setOpen] = useState<{ memberId: string | null } | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void actions.read().then((result) => {
      if (!current) return;
      setRead(
        result.ok
          ? { status: "ready", team: result.data }
          : { status: "error" },
      );
    });
    return () => {
      current = false;
    };
  }, [actions, run]);

  const reload = () => setRun((value) => value + 1);

  if (read.status === "loading")
    return (
      <div role="status" aria-label="Chargement de l’équipe…">
        <div className="h-40 animate-pulse rounded-3xl bg-sand/70" />
      </div>
    );
  if (read.status === "error")
    return (
      <Notice
        tone="error"
        title="L’équipe n’a pas pu être chargée"
        action={
          <button type="button" className={linkAction} onClick={reload}>
            Réessayer
          </button>
        }
      >
        Rien n’a été modifié.
      </Notice>
    );

  const { team } = read;
  const member = open?.memberId
    ? (team.members.find((item) => item.id === open.memberId) ?? null)
    : null;
  const serviceName = new Map(team.services.map((s) => [s.id, s.name]));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-[34px] leading-tight text-ink">
          Équipe
        </h1>
        <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
          Qui tes clientes peuvent réserver, et qui peut utiliser le logiciel.
          Une personne peut être réservable sans compte.
        </p>
      </header>

      {said ? (
        <p role="status" className="text-[14px] text-ink-soft">
          {said}
        </p>
      ) : null}

      <ul className="flex flex-col gap-3" aria-label="Membres de l’équipe">
        {team.members.map((item) => (
          <li
            key={item.id}
            className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h2 className="text-[17px] font-semibold wrap-anywhere text-ink">
                  {item.displayName}
                </h2>
                <p className="flex flex-wrap gap-1.5 text-[12.5px]">
                  <Chip on={item.bookable}>
                    {item.bookable ? "Réservable" : "Non réservable"}
                  </Chip>
                  <Chip on={item.access !== null}>
                    {item.access
                      ? roleLabels[item.access.role]
                      : "Sans accès au logiciel"}
                  </Chip>
                </p>
              </div>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setSaid(null);
                  setOpen({ memberId: item.id });
                }}
                aria-label={`Gérer ${item.displayName}`}
              >
                Gérer
              </Button>
            </div>
            {item.bookable ? (
              <p className="text-[13.5px] text-ink-soft">
                {item.serviceIds.length
                  ? item.serviceIds
                      .map((id) => serviceName.get(id))
                      .filter(Boolean)
                      .join(" · ")
                  : "Aucune prestation attribuée : personne ne peut la réserver."}
              </p>
            ) : null}
            <InviteLine member={item} />
          </li>
        ))}
      </ul>

      <Button
        variant="secondary"
        size="md"
        onClick={() => {
          setSaid(null);
          setOpen({ memberId: null });
        }}
      >
        Ajouter une personne
      </Button>

      <Sheet
        open={open !== null}
        onClose={() => setOpen(null)}
        title={member ? member.displayName : "Nouvelle personne"}
        description="Ses rendez-vous et son accès au logiciel se règlent séparément."
      >
        {open ? (
          <MemberEditor
            // By id only: a new revision read after a conflict keeps her typing.
            key={member ? member.id : "new"}
            member={member}
            services={team.services}
            actions={actions}
            invitations={invitations}
            onDone={(message) => {
              setSaid(message);
              setOpen(null);
              reload();
            }}
            onStale={reload}
          />
        ) : null}
      </Sheet>
    </div>
  );
}

function Chip({ on, children }: { on: boolean; children: string }) {
  return (
    <span
      className={cn(
        "rounded-full px-2.5 py-0.5 font-medium",
        on ? "bg-ink text-paper-raised" : "bg-sand text-ink-soft",
      )}
    >
      {children}
    </span>
  );
}

function InviteLine({ member }: { member: TeamMemberDto }) {
  if (member.access)
    return (
      <p className="text-[13px] text-ink-muted">
        Compte : {member.access.email}
      </p>
    );
  const invite = member.invite;
  if (!invite) return null;
  const day = invite.expiresAt
    ? new Intl.DateTimeFormat("fr-FR", {
        day: "numeric",
        month: "long",
      }).format(new Date(invite.expiresAt))
    : null;
  return (
    <p className="text-[13px] text-ink-muted">
      {invite.status === "pending"
        ? `Invitation en attente pour ${invite.email}${day ? `, valable jusqu’au ${day}` : ""}.`
        : invite.status === "expired"
          ? `L’invitation envoyée à ${invite.email} a expiré.`
          : invite.status === "revoked"
            ? `L’invitation envoyée à ${invite.email} a été annulée.`
            : `Invitation acceptée par ${invite.email}.`}
    </p>
  );
}

function MemberEditor({
  member,
  services,
  actions,
  invitations,
  onDone,
  onStale,
}: {
  member: TeamMemberDto | null;
  services: TeamDto["services"];
  actions: TeamActions;
  invitations: "enabled" | "not_sent_yet";
  onDone: (message: string) => void;
  /** The profile changed elsewhere: the team is read again. */
  onStale: () => void;
}) {
  const [name, setName] = useState(member?.displayName ?? "");
  const [bookable, setBookable] = useState(member?.bookable ?? true);
  const [serviceIds, setServiceIds] = useState<string[]>(
    member?.serviceIds ?? [],
  );
  const [email, setEmail] = useState(
    member?.invite && member.invite.status !== "accepted"
      ? member.invite.email
      : "",
  );
  const [role, setRole] = useState<"admin" | "practitioner">(
    member?.invite?.role === "admin" ? "admin" : "practitioner",
  );
  const [busy, setBusy] = useState<"save" | "invite" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const idFor = useOperationIds();

  function failed(result: TeamResult<unknown>, what: string) {
    if (result.ok) return;
    const code = result.error.code;
    if (code === teamErrors.versionConflict) {
      // Her typing stays here; the list behind is read again.
      onStale();
      return setError(
        "Ce profil a changé ailleurs. Ta saisie est gardée : vérifie-la, puis enregistre de nouveau.",
      );
    }
    setError(
      code === "network"
        ? "Pas de réponse. Réessaie : la même demande ne s’applique jamais deux fois."
        : code === teamErrors.lastOwner
          ? "C’est la seule propriétaire : son accès ne peut pas être retiré."
          : code === teamErrors.permissionDenied
            ? "Tu n’as pas le droit de faire cela."
            : code === teamErrors.upcoming
              ? "Cette personne a des rendez-vous à venir : déplace-les d’abord."
              : code === "role_unavailable"
                ? "Ce rôle n’est pas encore disponible."
                : code === "access_exists" || code === "already_member"
                  ? "Cette personne a déjà accès au logiciel."
                  : code === "not_found"
                    ? "Cette personne n’est plus dans l’équipe."
                    : `${what} n’a pas abouti. Réessaie dans un instant.`,
    );
  }

  async function save() {
    if (busy) return;
    if (!name.trim()) return setError("Indique son prénom ou son nom.");
    setBusy("save");
    setError(null);
    const body = {
      displayName: name.trim(),
      bookable,
      serviceIds: bookable ? serviceIds : [],
    };
    const result = member
      ? await actions.updateStaff({
          ...body,
          staffId: member.id,
          expectedRevision: member.revision,
          operationId: idFor(
            `update:${member.revision}:${JSON.stringify(body)}`,
          ),
        })
      : await actions.createStaff({
          ...body,
          operationId: idFor(`create:${JSON.stringify(body)}`),
        });
    setBusy(null);
    if (result.ok) return onDone(`${result.data.displayName} est enregistrée.`);
    failed(result, "L’enregistrement");
  }

  async function invite() {
    if (!member || busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return setError("Une adresse email valide.");
    setBusy("invite");
    setError(null);
    const body = { email: email.trim().toLowerCase(), role };
    const result = await actions.sendInvite({
      ...body,
      staffId: member.id,
      expectedRevision: member.revision,
      operationId: idFor(`invite:${member.revision}:${JSON.stringify(body)}`),
    });
    setBusy(null);
    if (result.ok) return onDone(`Invitation enregistrée pour ${body.email}.`);
    failed(result, "L’invitation");
  }

  async function revoke() {
    if (!member || busy) return;
    setBusy("revoke");
    setError(null);
    const result = await actions.revokeAccess({
      staffId: member.id,
      expectedRevision: member.revision,
      operationId: idFor(`revoke:${member.revision}`),
    });
    setBusy(null);
    setConfirmRevoke(false);
    if (result.ok)
      return onDone(
        `L’accès de ${member.displayName} est retiré. Son profil et ses rendez-vous restent.`,
      );
    failed(result, "Le retrait");
  }

  const pendingInvite = member?.invite?.status === "pending";

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <Notice tone="error" title="À revoir">
          {error}
        </Notice>
      ) : null}

      <section className="flex flex-col gap-4" aria-label="Rendez-vous">
        <TextField
          label="Nom affiché à tes clientes"
          name="staff-name"
          autoComplete="off"
          value={name}
          readOnly={busy !== null}
          onChange={(event) => setName(event.target.value)}
        />
        <label className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-paper px-4 py-3">
          <span className="flex flex-col">
            <span className="text-[15px] font-medium text-ink">
              Peut recevoir des rendez-vous
            </span>
            <span className="text-[13px] text-ink-muted">
              Tes clientes peuvent la choisir pour ses prestations.
            </span>
          </span>
          <Switch
            checked={bookable}
            onChange={() => setBookable((value) => !value)}
            aria-label="Peut recevoir des rendez-vous"
          />
        </label>
        {!bookable && member && member.upcomingAppointments > 0 ? (
          <p className="text-[13.5px] text-ink-soft">
            {member.upcomingAppointments === 1
              ? "Elle a 1 rendez-vous à venir : il faudra le déplacer avant."
              : `Elle a ${member.upcomingAppointments} rendez-vous à venir : il faudra les déplacer avant.`}
          </p>
        ) : null}
        {bookable ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[14px] font-medium text-ink">
              Ses prestations
            </legend>
            {services.map((service) => (
              <label
                key={service.id}
                className="flex cursor-pointer items-center gap-3 text-[14.5px] text-ink"
              >
                <input
                  type="checkbox"
                  checked={serviceIds.includes(service.id)}
                  onChange={(event) =>
                    setServiceIds((current) =>
                      event.target.checked
                        ? [...current, service.id]
                        : current.filter((id) => id !== service.id),
                    )
                  }
                  className="size-4 accent-[var(--ink)]"
                />
                {service.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button
          size="md"
          state={busy === "save" ? "loading" : "idle"}
          loadingLabel="Enregistrement…"
          disabled={busy !== null && busy !== "save"}
          onClick={() => void save()}
        >
          {member ? "Enregistrer" : "Ajouter à l’équipe"}
        </Button>
      </section>

      {member ? (
        <section
          className="flex flex-col gap-3 border-t border-line pt-5"
          aria-label="Accès au logiciel"
        >
          <p className="text-[15px] font-medium text-ink">Accès au logiciel</p>
          {member.access ? (
            <>
              <p className="text-[14px] text-ink-soft">
                {roleLabels[member.access.role]} · {member.access.email}
              </p>
              {confirmRevoke ? (
                <div className="flex flex-col gap-2 rounded-2xl bg-danger-soft/50 px-4 py-3">
                  <p className="text-[14px] text-ink">
                    Retirer l’accès de {member.displayName} ? Son profil et ses
                    rendez-vous restent ; elle ne pourra plus se connecter.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="danger"
                      size="md"
                      state={busy === "revoke" ? "loading" : "idle"}
                      loadingLabel="Retrait…"
                      onClick={() => void revoke()}
                    >
                      Retirer l’accès
                    </Button>
                    <Button
                      variant="ghost"
                      size="md"
                      disabled={busy !== null}
                      onClick={() => setConfirmRevoke(false)}
                    >
                      Annuler
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={cn(linkAction, "w-fit text-danger")}
                  onClick={() => setConfirmRevoke(true)}
                >
                  Retirer l’accès
                </button>
              )}
            </>
          ) : invitations === "not_sent_yet" ? (
            <p className="text-[14px] text-ink-soft">
              Sans accès pour le moment. Les invitations par e-mail arrivent
              bientôt : tant que l’envoi n’est pas activé, aucune n’est
              proposée, pour qu’aucune ne reste sans réponse.
            </p>
          ) : (
            <>
              <p className="text-[14px] text-ink-soft">
                {pendingInvite
                  ? "Une invitation est en attente. La renvoyer rend l’ancienne inutilisable."
                  : "Invite-la par email : elle choisira son mot de passe."}
              </p>
              <TextField
                label="Son email"
                name="invite-email"
                type="email"
                autoComplete="off"
                value={email}
                readOnly={busy !== null}
                onChange={(event) => setEmail(event.target.value)}
              />
              <div
                role="group"
                aria-label="Rôle"
                className="flex w-fit rounded-full bg-sand p-1"
              >
                {(["practitioner", "admin"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={role === value}
                    onClick={() => setRole(value)}
                    className={cn(
                      "h-9 cursor-pointer rounded-full px-4 text-[13.5px] font-medium",
                      role === value
                        ? "bg-paper-raised text-ink shadow-sm"
                        : "text-ink-soft",
                    )}
                  >
                    {roleLabels[value]}
                  </button>
                ))}
              </div>
              <p className="text-[13px] text-ink-muted">
                {role === "practitioner"
                  ? "Elle voit ses rendez-vous et ce qu’il faut pour les faire."
                  : "Elle gère l’agenda et la fiche des clientes, comme toi."}
              </p>
              <Button
                variant="secondary"
                size="md"
                state={busy === "invite" ? "loading" : "idle"}
                loadingLabel="Envoi…"
                disabled={busy !== null && busy !== "invite"}
                onClick={() => void invite()}
              >
                {pendingInvite
                  ? "Renvoyer l’invitation"
                  : "Envoyer l’invitation"}
              </Button>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
