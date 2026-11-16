import type { ConsentChannel } from "../schemas";

/**
 * Every choice a client made about offers, newest first: when, on which
 * channel, with which business, and the version of the wording she saw.
 * The register keeps them all (append-only); reading them is a proposed
 * contract (docs/MARKETING_CONSENT_WORDING_PROPOSAL.md § Historique),
 * not served yet.
 */

export type ConsentEventDto = {
  channel: ConsentChannel;
  state: "granted" | "withdrawn";
  /** The wording she agreed to; null for a withdrawal. */
  proofVersion: string | null;
  source:
    | "booking"
    | "professional"
    | "client_hub"
    | "unsubscribe_link"
    | "unsubscribe_undo";
  businessName: string;
  occurredAt: string;
};

const channelLabel = { email: "E-mail", sms: "SMS" } as const;

const sourceLabel: Record<ConsentEventDto["source"], string> = {
  booking: "en réservant",
  professional: "noté par l’établissement",
  client_hub: "depuis son espace",
  unsubscribe_link: "depuis un message",
  unsubscribe_undo: "annulation de sa désinscription",
};

const when = new Intl.DateTimeFormat("fr-FR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Paris",
});

export function ConsentHistory({ events }: { events: ConsentEventDto[] }) {
  const sorted = [...events].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  );
  if (sorted.length === 0)
    return (
      <p className="text-[13.5px] text-ink-soft">
        Aucun choix enregistré : elle ne reçoit pas d’offres.
      </p>
    );
  return (
    <ol aria-label="Historique de ses choix" className="flex flex-col">
      {sorted.map((event, index) => (
        <li
          key={`${event.occurredAt}-${event.channel}-${index}`}
          className="grid grid-cols-[auto_1fr] gap-x-3 border-l border-line py-2 pl-4 relative"
        >
          <span
            aria-hidden="true"
            className={
              "absolute top-3.5 -left-[5px] size-2.5 rounded-full " +
              (event.state === "granted"
                ? "bg-ink"
                : "border border-line-strong bg-paper")
            }
          />
          <span className="col-span-2 flex flex-wrap items-baseline gap-x-2 text-[14.5px] text-ink">
            <span className="font-semibold">
              {channelLabel[event.channel]} :{" "}
              {event.state === "granted" ? "accord donné" : "accord retiré"}
            </span>
            <span className="text-ink-soft">{sourceLabel[event.source]}</span>
          </span>
          <span className="col-span-2 text-[13px] text-ink-muted">
            <time dateTime={event.occurredAt}>
              {when.format(new Date(event.occurredAt))}
            </time>
            {" · "}
            {event.businessName}
            {event.proofVersion ? (
              <>
                {" · texte "}
                <span className="font-mono text-[12px]">
                  {event.proofVersion}
                </span>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
