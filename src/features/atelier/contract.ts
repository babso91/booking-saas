// Atelier: her site made with the studio's team (R5-03, pro side). PROPOSED
// contract (docs/ATELIER_PROPOSAL.md): no server serves it yet, and nothing
// here bills anything; the order and its billing belong to M7. The screen
// takes its actions as a whole; only the design preview and the tests give
// it an in-memory server.
//
// A proposal is applied to her draft, never published: she previews and
// publishes from the Studio herself. Corrections included in the quote are
// counted once per request.

export type AtelierOrderStatus =
  | "quoted"
  | "accepted"
  | "awaiting_assets"
  | "in_production"
  | "in_review"
  | "revision_requested"
  | "delivered"
  | "cancelled";

export type AtelierOrderDto = {
  orderId: string;
  title: string;
  status: AtelierOrderStatus;
  quote: {
    version: number;
    amountCents: number;
    currency: string;
    includedCorrections: number;
  };
  correctionsUsed: number;
};

export type AtelierProposalDto = {
  proposalId: string;
  /** The draft revision this proposal was made on. */
  baseDraftRevision: number;
  state: "submitted" | "changes_requested" | "accepted" | "applied";
  submittedAt: string;
  authorLabel: string;
  /** What changes, in words she can check. */
  changes: string[];
};

export type AtelierView = {
  order: AtelierOrderDto;
  proposals: AtelierProposalDto[];
  /** Her Studio draft as it is now. */
  currentDraftRevision: number;
};

export type AtelierResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; currentRevision?: number } };

export type AtelierActions = {
  read: (orderId: string) => Promise<AtelierResult<AtelierView>>;
  requestCorrection: (input: {
    proposalId: string;
    scope: string;
    requestId: string;
  }) => Promise<AtelierResult<AtelierView>>;
  /** Ask for the same proposal remade on her current draft (not a correction). */
  requestRebase: (input: {
    proposalId: string;
    requestId: string;
  }) => Promise<AtelierResult<AtelierView>>;
  apply: (input: {
    proposalId: string;
    expectedDraftRevision: number;
    requestId: string;
  }) => Promise<AtelierResult<{ draftRevision: number }>>;
};

export const atelierErrors = {
  accessExpired: "atelier_access_expired",
  quoteChanged: "atelier_quote_changed",
  outOfScope: "atelier_out_of_scope",
  limitReached: "atelier_revision_limit_reached",
  staleDraft: "stale_site_draft",
} as const;
