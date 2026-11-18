"use client";

import { useSyncExternalStore } from "react";

import { Notice } from "@/components/ui/notice";

import { realUnsubscribeActions, unsubscribeTokenFrom } from "./real-actions";
import { UnsubscribePage } from "./unsubscribe-page";

// `/desinscription#t=uns_…`: the token is in the fragment, read here in the
// browser and passed to the actions only. Opening the page writes nothing.

// The fragment can change without a reload (another link opened in the
// same tab): read it again then.
const onHashChange = (callback: () => void) => {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
};

export function UnsubscribeLinkPage() {
  const token = useSyncExternalStore(
    onHashChange,
    () => unsubscribeTokenFrom(window.location.hash),
    () => undefined,
  );
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 pt-10 pb-16 sm:px-6 sm:pt-14">
      {token === undefined ? null : token ? (
        <UnsubscribePage token={token} actions={realUnsubscribeActions} />
      ) : (
        <Notice tone="warning" title="Ce lien est incomplet">
          Ouvrez-le directement depuis le message reçu, sans le recopier : sa
          fin indique de quels messages il s’agit.
        </Notice>
      )}
    </main>
  );
}
