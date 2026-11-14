import {
  teamErrors,
  type TeamActions,
  type TeamDto,
  type TeamMemberDto,
  type TeamResult,
} from "./contract";

// An in-memory server of the PROPOSED team contract, for the preview and
// the tests only: revisions, a replayed operation id, the last owner kept.

const fail = (code: string): TeamResult<never> => ({
  ok: false,
  error: { code },
});

export function sampleTeam(): TeamDto {
  return {
    services: [
      { id: "s-lift", name: "Rehaussement de cils" },
      { id: "s-henna", name: "Motif au henné" },
      { id: "s-wax", name: "Épilation jambes" },
    ],
    members: [
      {
        id: "m-owner",
        revision: 1,
        displayName: "Maëlys",
        bookable: true,
        serviceIds: ["s-lift", "s-henna", "s-wax"],
        access: { role: "owner", email: "maelys@exemple.fr" },
        invite: null,
        upcomingAppointments: 12,
      },
      {
        id: "m-ines",
        revision: 2,
        displayName: "Inès",
        bookable: true,
        serviceIds: ["s-henna"],
        access: null,
        invite: {
          status: "pending",
          email: "ines@exemple.fr",
          role: "practitioner",
          expiresAt: "2026-11-21T12:00:00.000Z",
        },
        upcomingAppointments: 3,
      },
    ],
  };
}

export function memoryTeam(
  start: TeamDto = sampleTeam(),
  options: { delayMs?: number } = {},
) {
  const state = structuredClone(start);
  const answered = new Map<string, TeamResult<TeamMemberDto>>();
  let ids = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  async function once(
    operationId: string,
    run: () => TeamResult<TeamMemberDto>,
  ) {
    await pause();
    const earlier = answered.get(operationId);
    if (earlier) return earlier;
    const result = run();
    if (result.ok) answered.set(operationId, result);
    return result;
  }
  const find = (id: string) => state.members.find((member) => member.id === id);
  const save = (member: TeamMemberDto): TeamResult<TeamMemberDto> => {
    state.members = state.members.map((item) =>
      item.id === member.id ? member : item,
    );
    return { ok: true, data: structuredClone(member) };
  };

  const actions: TeamActions = {
    async read() {
      await pause();
      return { ok: true, data: structuredClone(state) };
    },
    createStaff: (input) =>
      once(input.operationId, () => {
        const member: TeamMemberDto = {
          id: `m-${(ids += 1)}`,
          revision: 1,
          displayName: input.displayName,
          bookable: input.bookable,
          serviceIds: input.serviceIds,
          access: null,
          invite: null,
          upcomingAppointments: 0,
        };
        state.members.push(member);
        return { ok: true, data: structuredClone(member) };
      }),
    updateStaff: (input) =>
      once(input.operationId, () => {
        const member = find(input.staffId);
        if (!member) return fail("not_found");
        if (member.revision !== input.expectedRevision)
          return fail(teamErrors.versionConflict);
        if (member.bookable && !input.bookable && member.upcomingAppointments)
          return fail(teamErrors.upcoming);
        return save({
          ...member,
          revision: member.revision + 1,
          displayName: input.displayName,
          bookable: input.bookable,
          serviceIds: input.serviceIds,
        });
      }),
    sendInvite: (input) =>
      once(input.operationId, () => {
        const member = find(input.staffId);
        if (!member) return fail("not_found");
        if (member.revision !== input.expectedRevision)
          return fail(teamErrors.versionConflict);
        return save({
          ...member,
          revision: member.revision + 1,
          invite: {
            status: "pending",
            email: input.email,
            role: input.role,
            expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          },
        });
      }),
    revokeAccess: (input) =>
      once(input.operationId, () => {
        const member = find(input.staffId);
        if (!member) return fail("not_found");
        if (member.revision !== input.expectedRevision)
          return fail(teamErrors.versionConflict);
        const owners = state.members.filter(
          (item) => item.access?.role === "owner",
        );
        if (member.access?.role === "owner" && owners.length === 1)
          return fail(teamErrors.lastOwner);
        return save({
          ...member,
          revision: member.revision + 1,
          access: null,
          invite:
            member.invite?.status === "pending"
              ? { ...member.invite, status: "revoked" }
              : member.invite,
        });
      }),
  };
  return { actions, state };
}
