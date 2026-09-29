// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OnboardingSuccess } from "./onboarding-success";

describe("OnboardingSuccess (/app/welcome)", () => {
  it("shows the business returned by the server and leads to /app", () => {
    render(<OnboardingSuccess slug="studio-mila" businessName="Studio Mila" />);

    expect(
      screen.getByRole("heading", { name: "Ton espace est prêt." }),
    ).toBeTruthy();
    expect(screen.getByText("Studio Mila")).toBeTruthy();
    expect(screen.getByText("studio-mila")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /accéder à mon espace/i })
        .getAttribute("href"),
    ).toBe("/app");
  });

  it("copies the full public link", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    render(<OnboardingSuccess slug="studio-mila" businessName="Studio Mila" />);

    await user.click(screen.getByRole("button", { name: /copier/i }));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/\/b\/studio-mila$/),
    );
    await waitFor(() => expect(screen.getByText("Copié")).toBeTruthy());
  });
});
