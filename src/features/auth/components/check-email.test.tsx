// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckEmail } from "./check-email";

function renderScreen(onResend = vi.fn().mockResolvedValue(true)) {
  render(
    <CheckEmail
      email="mila@studio.fr"
      headingRef={{ current: null }}
      onChangeEmail={vi.fn()}
      onResend={onResend}
    />,
  );
  return {
    onResend,
    resend: () => screen.getByRole("button", { name: /renvoy/i }),
  };
}

/** The cooldown ticks once per second, one timer per render. */
async function waitSeconds(seconds: number) {
  for (let second = 0; second < seconds; second += 1) {
    await act(async () => vi.advanceTimersByTime(1_000));
  }
}

describe("CheckEmail resend", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is natively disabled during the cooldown, keyboard included", () => {
    const { onResend, resend } = renderScreen();

    expect((resend() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(resend());
    fireEvent.keyDown(resend(), { key: "Enter" });

    expect(onResend).not.toHaveBeenCalled();
  });

  it("sends once on repeated activation, then restarts the cooldown", async () => {
    let finish: (sent: boolean) => void = () => {};
    const onResend = vi.fn(
      () => new Promise<boolean>((done) => (finish = done)),
    );
    const { resend } = renderScreen(onResend);

    await waitSeconds(30);
    expect((resend() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(resend());
    fireEvent.click(resend());
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(1);

    await act(async () => finish(true));
    expect(screen.getByText("Un nouvel email est en route.")).toBeTruthy();
    fireEvent.click(resend());
    expect(onResend).toHaveBeenCalledTimes(1);

    await waitSeconds(2);
    expect((resend() as HTMLButtonElement).disabled).toBe(true);
  });
});
