import { beforeEach, describe, expect, it, vi } from "vitest";

import { realVisitFormsActions } from "./real-pro-actions";

// The adapter between Cloud's form actions and the visit screen.

const { actions } = vi.hoisted(() => ({
  actions: {
    readVisitFormsAction: vi.fn(),
    assignVisitFormAction: vi.fn(),
    revokeVisitFormAction: vi.fn(),
    reviewVisitFormAction: vi.fn(),
    listFormTemplatesAction: vi.fn(),
    createFormTemplateAction: vi.fn(),
    readFormTemplateAction: vi.fn(),
    saveFormDraftAction: vi.fn(),
    publishFormTemplateAction: vi.fn(),
  },
}));
vi.mock("@/features/client-forms/actions/forms", () =>
  Object.fromEntries(
    Object.entries(actions).map(([name, mock]) => [
      name,
      (...args: unknown[]) => mock(...args),
    ]),
  ),
);

const APPOINTMENT = "70000000-0000-4000-8000-000000000001";
const view = {
  appointmentId: APPOINTMENT,
  clientName: "Inès",
  assignments: [],
  templates: [],
};

beforeEach(() => {
  Object.values(actions).forEach((mock) => mock.mockReset());
});

describe("realVisitFormsActions", () => {
  it("reads the visit again after a write, so the screen gets its view", async () => {
    actions.assignVisitFormAction.mockResolvedValue({
      ok: true,
      data: { assignmentId: "a1" },
    });
    actions.readVisitFormsAction.mockResolvedValue({ ok: true, data: view });
    const result = await realVisitFormsActions(APPOINTMENT).assign({
      appointmentId: APPOINTMENT,
      templateVersionId: "v1",
      requestId: "r1",
    });
    expect(result).toEqual({ ok: true, data: view });
    expect(actions.readVisitFormsAction).toHaveBeenCalledWith({
      appointmentId: APPOINTMENT,
    });
  });

  it("does not read again after a refusal, and keeps its code only", async () => {
    actions.revokeVisitFormAction.mockResolvedValue({
      ok: false,
      error: { code: "form_already_submitted", message: "never shown" },
    });
    const result = await realVisitFormsActions(APPOINTMENT).revoke({
      assignmentId: "a1",
      expectedVersion: 1,
      requestId: "r2",
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "form_already_submitted" },
    });
    expect(actions.readVisitFormsAction).not.toHaveBeenCalled();
  });
});
