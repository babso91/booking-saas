// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { setCancellationPolicyAction } from "../actions";
import { CancellationPolicyEditor } from "./cancellation-policy-editor";

vi.mock("../actions", () => ({ setCancellationPolicyAction: vi.fn() }));
const save = vi.mocked(setCancellationPolicyAction);
const businessId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => save.mockReset());

it("requires an explicit choice to open cancellation for new appointments", async () => {
  save.mockResolvedValue({
    ok: true,
    data: { cancellationLeadMinutes: 0, rescheduleLeadMinutes: null },
  });
  render(
    <CancellationPolicyEditor businessId={businessId} leadMinutes={null} />,
  );
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "0" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Enregistrer la règle d’annulation" }),
  );
  await screen.findByText("Règle enregistrée pour les nouveaux rendez-vous.");
  expect(save).toHaveBeenCalledWith({ businessId, cancellationLeadMinutes: 0 });
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});

it("keeps a failed setting editable and never claims it was saved", async () => {
  save.mockResolvedValue({
    ok: false,
    error: { code: "forbidden", message: "not shown" },
  });
  render(
    <CancellationPolicyEditor businessId={businessId} leadMinutes={1440} />,
  );
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "none" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Enregistrer la règle d’annulation" }),
  );
  await screen.findByText(/La règle n’a pas pu être enregistrée/);
  expect(
    screen.queryByText("Règle enregistrée pour les nouveaux rendez-vous."),
  ).toBeNull();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Enregistrer la règle d’annulation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
});
