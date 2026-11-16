"use client";

import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Button } from "@/components/ui/button";
import {
  CalendarIcon,
  HomeIcon,
  LogOutIcon,
  SparkIcon,
} from "@/components/ui/icons";
import { Sheet } from "@/components/ui/sheet";
import type {
  ClientHubBusinessDto,
  ClientHubProfileDto,
} from "@/features/client-hub/types";
import { cn } from "@/lib/cn";

import type { HubError } from "../client/api";
import { initial } from "../client/format";
import { ClientHubSessionProvider, useClientHub } from "../client/session";
import { HubErrorNotice, Skeleton, hubErrorCopy } from "./hub-parts";

export const hubHref = {
  home: "/espace" as Route,
  signIn: "/espace/connexion" as Route,
  appointments: (businessId: string) =>
    `/espace/${encodeURIComponent(businessId)}/rendez-vous` as Route,
  appointment: (businessId: string, appointmentId: string) =>
    `/espace/${encodeURIComponent(businessId)}/rendez-vous/${encodeURIComponent(appointmentId)}` as Route,
  loyalty: (businessId: string) =>
    `/espace/${encodeURIComponent(businessId)}/fidelite` as Route,
};

/** The business's public booking page (outside the hub, no session). */
export const bookingHref = (slug: string) =>
  `/b/${encodeURIComponent(slug)}` as Route;

/**
 * The hub's root, in the /espace layout (kept across its pages): the
 * session, and the screens remounted for each identity, so nothing shown
 * to one customer stays for the next one on the same browser.
 */
export function HubRoot({ children }: { children: ReactNode }) {
  return (
    <ClientHubSessionProvider>
      <Generation>{children}</Generation>
    </ClientHubSessionProvider>
  );
}

function Generation({ children }: { children: ReactNode }) {
  const { session } = useClientHub();
  return <Fragment key={session.generation}>{children}</Fragment>;
}

type Section = "home" | "appointments" | "loyalty";

/**
 * A signed-in page of the hub. Before the session is known nothing private
 * is rendered; signed out, it goes to the sign-in page. `businessId` pages
 * show a business only if the profile lists it (the API refuses the rest
 * anyway: this only avoids a useless request).
 */
export function HubPage({
  section,
  businessId,
  children,
}: {
  section: Section;
  businessId?: string;
  children: (context: {
    profile: ClientHubProfileDto;
    business: ClientHubBusinessDto | null;
    /** The other businesses of the customer, placed by the page. */
    switcher: ReactNode;
  }) => ReactNode;
}) {
  const { session, recheck, verify } = useClientHub();
  const router = useRouter();
  const signedOut = session.status === "signed-out";

  useEffect(() => {
    if (signedOut) router.replace(hubHref.signIn);
  }, [router, signedOut]);

  if (session.status === "signed-in") {
    const { profile } = session;
    const business = businessId
      ? (profile.businesses.find((item) => item.businessId === businessId) ??
        null)
      : null;
    const navBusiness = business ?? profile.businesses[0] ?? null;
    const switcher =
      business && profile.businesses.length > 1 && section !== "home" ? (
        <BusinessSwitcher
          businesses={profile.businesses}
          current={business}
          section={section}
        />
      ) : null;
    // While her identity is being confirmed (back on the tab), nothing of
    // hers is visible: her screens stay mounted but hidden and inert, so
    // they come back as she left them once she is confirmed. What they
    // render outside this subtree (the account panel, a portal on <body>)
    // is suspended with them: closed, its inert and focus trap released.
    const veiled = session.check !== "ok";
    return (
      <>
        {veiled ? (
          <Verifying failed={session.check === "failed"} onRetry={verify} />
        ) : null}
        <div
          hidden={veiled}
          inert={veiled}
          className={veiled ? undefined : "contents"}
        >
          <Chrome
            section={section}
            profile={profile}
            navBusiness={navBusiness}
            suspended={veiled}
          >
            {businessId && !business ? (
              <UnknownBusiness />
            ) : (
              children({ profile, business, switcher })
            )}
          </Chrome>
        </div>
      </>
    );
  }

  return (
    <Chrome section={section} profile={null} navBusiness={null}>
      {session.status === "error" ? (
        <SessionError error={session.error} onRetry={recheck} />
      ) : (
        <div role="status" aria-live="polite" className="flex flex-col gap-4">
          <span className="sr-only">
            {signedOut
              ? "Redirection vers la connexion…"
              : "Chargement de votre espace…"}
          </span>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-11 w-64 rounded-2xl" />
          <Skeleton className="mt-4 h-44 w-full rounded-[28px]" />
          <Skeleton className="h-28 w-full rounded-[28px]" />
        </div>
      )}
    </Chrome>
  );
}

/** Whether focus is nowhere usable: on the page itself or on hidden content. */
const focusLost = () => {
  const active = document.activeElement;
  return (
    !active ||
    active === document.body ||
    Boolean(active.closest("[hidden], [inert]"))
  );
};

/**
 * The neutral screen of a check: no name, no data, no navigation. What had
 * focus is hidden now: focus comes here, and on the retry when it appears,
 * so a keyboard never ends up on nothing.
 */
function Verifying({
  failed,
  onRetry,
}: {
  failed: boolean;
  onRetry: () => void;
}) {
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = failed
      ? region.current?.querySelector<HTMLElement>("[data-retry]")
      : region.current;
    if (focusLost() || document.activeElement === region.current) {
      target?.focus({ preventScroll: true });
    }
  }, [failed]);

  return (
    <Chrome section="home" profile={null} navBusiness={null}>
      <div ref={region} tabIndex={-1} className="outline-none">
        {failed ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-4 rounded-[28px] border border-line bg-paper-raised px-6 py-8"
          >
            <h1 className="font-display text-[30px] leading-tight text-ink">
              Impossible de vérifier votre session
            </h1>
            <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
              Par sécurité, votre espace reste masqué tant que nous ne pouvons
              pas confirmer qu’il s’agit bien de vous. Vérifiez votre connexion
              puis réessayez.
            </p>
            <Button data-retry="" size="md" onClick={onRetry}>
              Réessayer
            </Button>
          </div>
        ) : (
          <div role="status" aria-live="polite" className="flex flex-col gap-4">
            <span className="sr-only">Vérification de votre session…</span>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-11 w-64 rounded-2xl" />
            <Skeleton className="mt-4 h-44 w-full rounded-[28px]" />
          </div>
        )}
      </div>
    </Chrome>
  );
}

function SessionError({
  error,
  onRetry,
}: {
  error: HubError;
  onRetry: () => void;
}) {
  const copy = hubErrorCopy(error);
  return (
    <div className="flex flex-col items-start gap-4 rounded-[28px] border border-line bg-paper-raised px-6 py-8">
      <h1 className="font-display text-[32px] leading-tight text-ink">
        {copy.title}
      </h1>
      <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
        {copy.message}
      </p>
      <Button size="md" onClick={onRetry}>
        Réessayer
      </Button>
    </div>
  );
}

function UnknownBusiness() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[28px] border border-line bg-paper-raised px-6 py-8">
      <h1 className="font-display text-[30px] leading-tight text-ink">
        Établissement introuvable
      </h1>
      <p className="max-w-prose text-[15px] leading-relaxed text-ink-soft">
        Cet établissement n’est pas, ou plus, accessible depuis votre espace.
        L’accès est ouvert par l’établissement lui-même.
      </p>
      <Link
        href={hubHref.home}
        className="text-[14.5px] font-semibold text-ink underline decoration-line-strong underline-offset-4"
      >
        Retour à l’accueil
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Chrome({
  section,
  profile,
  navBusiness,
  suspended = false,
  children,
}: {
  section: Section;
  profile: ClientHubProfileDto | null;
  navBusiness: ClientHubBusinessDto | null;
  /** Her identity is being confirmed: nothing of hers may show, no panel. */
  suspended?: boolean;
  children: ReactNode;
}) {
  // Kept while suspended: the panel she had open comes back with her.
  const [account, setAccount] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const items = navItems(navBusiness);

  return (
    <div className="relative isolate flex min-h-dvh flex-1 flex-col">
      {/* Warm light behind the top of the page: decoration only. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] overflow-hidden"
      >
        <div className="absolute -top-48 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(151,73,58,0.13),transparent_62%)]" />
        <div className="absolute -top-24 -right-40 size-[420px] rounded-full bg-[radial-gradient(circle_at_center,rgba(255,252,248,0.95),transparent_60%)]" />
      </div>

      <header className="sticky top-0 z-30 border-b border-transparent bg-paper/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-[backdrop-filter]:bg-paper/65">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link
            href={hubHref.home}
            className="inline-flex min-w-0 items-center gap-2.5 text-ink"
            aria-label="Mon espace — accueil"
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 32 32"
              aria-hidden="true"
              className="shrink-0"
            >
              <circle cx="16" cy="16" r="15" fill="var(--ink)" />
              <path
                d="M8.5 19.5a8 8 0 0 1 15 0"
                fill="none"
                stroke="var(--paper-raised)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <circle cx="21.3" cy="12.6" r="2.1" fill="var(--accent-soft)" />
            </svg>
            <span className="truncate font-display text-[22px] leading-none tracking-[-0.01em]">
              Mon espace
            </span>
          </Link>

          {profile && items.length > 1 ? (
            <nav aria-label="Navigation principale" className="hidden md:block">
              <ul className="flex items-center gap-1 rounded-full border border-line bg-paper-raised/80 p-1">
                {items.map((item) => (
                  <li key={item.section}>
                    <Link
                      href={item.href}
                      aria-current={
                        item.section === section ? "page" : undefined
                      }
                      className={cn(
                        "flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors",
                        item.section === section
                          ? "bg-ink text-paper-raised"
                          : "text-ink-soft hover:bg-sand/70 hover:text-ink",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          {profile ? (
            <button
              ref={accountButton}
              type="button"
              onClick={() => setAccount(true)}
              aria-label="Mon compte"
              aria-haspopup="dialog"
              className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line bg-paper-raised font-display text-[18px] text-ink transition-colors hover:border-line-strong"
            >
              {initial(profile.email)}
            </button>
          ) : (
            <span className="size-10" aria-hidden="true" />
          )}
        </div>
      </header>

      <main
        id="contenu"
        className={cn(
          "mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 pt-4 sm:px-6 md:pt-8",
          profile && items.length > 1
            ? "pb-[calc(6.5rem+env(safe-area-inset-bottom))] md:pb-16"
            : "pb-16",
        )}
      >
        {children}
      </main>

      {profile && items.length > 1 ? (
        <nav
          aria-label="Navigation principale"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line/80 bg-paper-raised/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
        >
          <ul className="mx-auto grid max-w-md grid-cols-3">
            {items.map((item) => {
              const active = item.section === section;
              return (
                <li key={item.section}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-16 flex-col items-center justify-center gap-1 text-[11.5px] font-medium transition-colors",
                      active
                        ? "text-ink"
                        : "text-ink-muted hover:text-ink-soft",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-12 items-center justify-center rounded-full transition-colors",
                        active ? "bg-accent-soft text-accent-strong" : "",
                      )}
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {profile ? (
        <AccountSheet
          open={account && !suspended}
          returnFocus={accountButton}
          email={profile.email}
          onClose={() => setAccount(false)}
        />
      ) : null}
    </div>
  );
}

function navItems(business: ClientHubBusinessDto | null) {
  const items: {
    section: Section;
    label: string;
    href: Route;
    icon: ReactNode;
  }[] = [
    {
      section: "home",
      label: "Accueil",
      href: hubHref.home,
      icon: <HomeIcon size={19} />,
    },
  ];
  if (business) {
    items.push(
      {
        section: "appointments",
        label: "Rendez-vous",
        href: hubHref.appointments(business.businessId),
        icon: <CalendarIcon size={19} />,
      },
      {
        section: "loyalty",
        label: "Fidélité",
        href: hubHref.loyalty(business.businessId),
        icon: <SparkIcon size={19} />,
      },
    );
  }
  return items;
}

/** One business at a time: its data is never merged with another's. */
function BusinessSwitcher({
  businesses,
  current,
  section,
}: {
  businesses: ClientHubBusinessDto[];
  current: ClientHubBusinessDto;
  section: Section;
}) {
  const target = section === "loyalty" ? hubHref.loyalty : hubHref.appointments;
  return (
    <nav
      aria-label="Établissements"
      className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]"
    >
      <ul className="flex w-max gap-2">
        {businesses.map((business) => {
          const active = business.businessId === current.businessId;
          return (
            <li key={business.businessId}>
              <Link
                href={target(business.businessId)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 max-w-[16rem] items-center gap-2 rounded-full border px-4 text-[14px] font-medium transition-colors",
                  active
                    ? "border-ink bg-ink text-paper-raised"
                    : "border-line bg-paper-raised text-ink-soft hover:border-line-strong hover:text-ink",
                )}
              >
                <span className="truncate">{business.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function AccountSheet({
  open,
  returnFocus,
  email,
  onClose,
}: {
  open: boolean;
  returnFocus: RefObject<HTMLElement | null>;
  email: string;
  onClose: () => void;
}) {
  const { signOut } = useClientHub();
  const [pending, setPending] = useState<"one" | "all" | null>(null);
  const [error, setError] = useState<HubError | null>(null);

  async function leave(all: boolean) {
    if (pending) return;
    setPending(all ? "all" : "one");
    setError(null);
    const result = await signOut(all);
    // Signed out: this sheet is unmounted with the session's screens.
    if (!result.ok) {
      setPending(null);
      setError(result.error);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => (pending ? undefined : onClose())}
      returnFocus={returnFocus}
      title="Mon compte"
      description="Connectée avec un code envoyé par email."
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3.5">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink font-display text-[20px] text-paper-raised"
            aria-hidden="true"
          >
            {initial(email)}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-[12.5px] text-ink-muted">Adresse email</span>
            <span className="truncate text-[15px] font-medium text-ink">
              {email}
            </span>
          </div>
        </div>

        <p className="text-[14px] leading-relaxed text-ink-soft">
          Votre espace est en lecture seule : pour modifier un rendez-vous ou
          utiliser une récompense, adressez-vous directement à votre
          établissement.
        </p>

        {error ? (
          <HubErrorNotice error={error}>
            La déconnexion n’a pas été confirmée : vous êtes peut-être encore
            connectée. Réessayez.
          </HubErrorNotice>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            size="md"
            fullWidth
            icon={<LogOutIcon size={18} />}
            state={pending === "one" ? "loading" : "idle"}
            loadingLabel="Déconnexion…"
            disabled={pending === "all"}
            onClick={() => void leave(false)}
          >
            Se déconnecter
          </Button>
          <Button
            variant="ghost"
            size="md"
            fullWidth
            state={pending === "all" ? "loading" : "idle"}
            loadingLabel="Déconnexion…"
            disabled={pending === "one"}
            onClick={() => void leave(true)}
          >
            Se déconnecter de tous les appareils
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
