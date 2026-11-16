// Her team (M6-R01). PROPOSED contract (docs/TEAM_PROPOSAL.md): no server
// serves it yet. The screens take their actions as a whole; only the
// design preview and the tests give them an in-memory server. No real page
// shows a team until Cloud provides it.
//
// Two things are kept apart, always: being bookable (her clients can book
// this person) and having access to the software (an account, a role).
// A profile can be bookable without any account or email.

export type TeamRole = "owner" | "admin" | "practitioner";

export type InviteDto = {
  /** Never a secret: the list only says where the invitation stands. */
  status: "pending" | "accepted" | "expired" | "revoked";
  email: string;
  role: TeamRole;
  expiresAt: string | null;
};

export type TeamMemberDto = {
  id: string;
  revision: number;
  displayName: string;
  /** Her clients can book this person. */
  bookable: boolean;
  /** The services this person performs (ids of her catalogue). */
  serviceIds: string[];
  /** An account linked to this profile, with its role; null: none. */
  access: { role: TeamRole; email: string } | null;
  /** The last invitation sent for this profile, if any. */
  invite: InviteDto | null;
  /** Upcoming appointments assigned to this person. */
  upcomingAppointments: number;
};

export type TeamDto = {
  members: TeamMemberDto[];
  /** Her services, to assign (id and name). */
  services: { id: string; name: string }[];
};

export type TeamResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: string } };

export type TeamActions = {
  read: () => Promise<TeamResult<TeamDto>>;
  createStaff: (input: {
    operationId: string;
    displayName: string;
    bookable: boolean;
    serviceIds: string[];
  }) => Promise<TeamResult<TeamMemberDto>>;
  updateStaff: (input: {
    operationId: string;
    staffId: string;
    expectedRevision: number;
    displayName: string;
    bookable: boolean;
    serviceIds: string[];
  }) => Promise<TeamResult<TeamMemberDto>>;
  sendInvite: (input: {
    operationId: string;
    staffId: string;
    expectedRevision: number;
    email: string;
    role: Exclude<TeamRole, "owner">;
  }) => Promise<TeamResult<TeamMemberDto>>;
  revokeAccess: (input: {
    operationId: string;
    staffId: string;
    expectedRevision: number;
  }) => Promise<TeamResult<TeamMemberDto>>;
};

/** Refusals handled by name (proposed codes). */
export const teamErrors = {
  versionConflict: "version_conflict",
  lastOwner: "last_owner",
  permissionDenied: "permission_denied",
  upcoming: "upcoming_appointments",
} as const;

export const roleLabels: Record<TeamRole, string> = {
  owner: "Propriétaire",
  admin: "Administratrice",
  practitioner: "Praticienne",
};
