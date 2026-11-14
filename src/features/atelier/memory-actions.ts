import {
  atelierErrors,
  type AtelierActions,
  type AtelierResult,
  type AtelierView,
} from "./contract";

// An in-memory server of the PROPOSED Atelier contract, for the preview and
// the tests only. The recipe's fixture: order AT1, quote v2, two included
// corrections, a proposal made on draft revision 12. Nothing is billed,
// published or sent.

const fail = (
  code: string,
  currentRevision?: number,
): AtelierResult<never> => ({
  ok: false,
  error: currentRevision === undefined ? { code } : { code, currentRevision },
});

export function sampleAtelier(): AtelierView {
  return {
    order: {
      orderId: "AT1",
      title: "Création de ton site",
      status: "in_review",
      quote: {
        version: 2,
        amountCents: 14900,
        currency: "EUR",
        includedCorrections: 2,
      },
      correctionsUsed: 0,
    },
    proposals: [
      {
        proposalId: "p-1",
        baseDraftRevision: 12,
        state: "submitted",
        submittedAt: "2026-11-13T16:00:00.000Z",
        authorLabel: "Camille, de l’atelier",
        changes: [
          "Univers Alma, palette sable",
          "Page d’accueil avec tes 6 photos",
          "Textes de présentation réécrits",
        ],
      },
    ],
    currentDraftRevision: 12,
  };
}

export function memoryAtelier(
  options: { delayMs?: number; start?: AtelierView; expired?: boolean } = {},
) {
  let view = structuredClone(options.start ?? sampleAtelier());
  const answered = new Map<string, AtelierResult<unknown>>();
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  async function once<T>(requestId: string, run: () => AtelierResult<T>) {
    await pause();
    const earlier = answered.get(requestId);
    if (earlier) return earlier as AtelierResult<T>;
    if (options.expired) return fail(atelierErrors.accessExpired);
    const result = run();
    if (result.ok) answered.set(requestId, result);
    return result;
  }
  const proposal = (id: string) =>
    view.proposals.find((p) => p.proposalId === id);

  const actions: AtelierActions = {
    async read(orderId) {
      await pause();
      if (options.expired) return fail(atelierErrors.accessExpired);
      if (orderId !== view.order.orderId) return fail("not_found");
      return { ok: true, data: structuredClone(view) };
    },
    requestCorrection: ({ proposalId, scope, requestId }) =>
      once(requestId, () => {
        const item = proposal(proposalId);
        if (!item || item.state !== "submitted") return fail("not_found");
        if (/nouvelle page|boutique|logo/i.test(scope))
          return fail(atelierErrors.outOfScope);
        if (view.order.correctionsUsed >= view.order.quote.includedCorrections)
          return fail(atelierErrors.limitReached);
        view = {
          ...view,
          order: {
            ...view.order,
            status: "revision_requested",
            correctionsUsed: view.order.correctionsUsed + 1,
          },
          proposals: view.proposals.map((p) =>
            p.proposalId === proposalId
              ? { ...p, state: "changes_requested" }
              : p,
          ),
        };
        return { ok: true, data: structuredClone(view) };
      }),
    requestRebase: ({ proposalId, requestId }) =>
      once(requestId, () => {
        if (!proposal(proposalId)) return fail("not_found");
        view = {
          ...view,
          order: { ...view.order, status: "in_production" },
          proposals: view.proposals.map((p) =>
            p.proposalId === proposalId
              ? { ...p, state: "changes_requested" }
              : p,
          ),
        };
        return { ok: true, data: structuredClone(view) };
      }),
    apply: ({ proposalId, expectedDraftRevision, requestId }) =>
      once(requestId, () => {
        const item = proposal(proposalId);
        if (!item || item.state !== "submitted") return fail("not_found");
        if (
          item.baseDraftRevision !== view.currentDraftRevision ||
          expectedDraftRevision !== view.currentDraftRevision
        )
          return fail(atelierErrors.staleDraft, view.currentDraftRevision);
        const draftRevision = view.currentDraftRevision + 1;
        view = {
          ...view,
          currentDraftRevision: draftRevision,
          order: { ...view.order, status: "delivered" },
          proposals: view.proposals.map((p) =>
            p.proposalId === proposalId ? { ...p, state: "applied" } : p,
          ),
        };
        return { ok: true, data: { draftRevision } };
      }),
  };
  return {
    actions,
    get view() {
      return view;
    },
    /** She saves her draft in the Studio meanwhile. */
    editDraft() {
      view = { ...view, currentDraftRevision: view.currentDraftRevision + 1 };
    },
  };
}
