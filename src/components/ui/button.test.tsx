// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";

describe("Button", () => {
  it.each(["loading", "success"] as const)(
    "cannot be activated while %s, by pointer or keyboard",
    async (state) => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(
        <Button state={state} onClick={onClick}>
          Envoyer
        </Button>,
      );
      const button = screen.getByRole("button");

      fireEvent.click(button);
      button.focus();
      await user.keyboard("{Enter}");
      await user.keyboard(" ");

      expect(onClick).not.toHaveBeenCalled();
      expect(button.getAttribute("aria-disabled")).toBe("true");
    },
  );

  it("does not submit its form while busy", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <Button type="submit" state="loading">
          Créer
        </Button>
      </form>,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("works normally when idle", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Envoyer</Button>);
    await userEvent.setup().click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
