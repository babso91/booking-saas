import {
  unsubscribeErrors,
  type UnsubscribeActions,
  type UnsubscribeResult,
  type UnsubscribeView,
} from "./contract";

// An in-memory server of the PROPOSED unsubscribe contract, for the preview
// and the tests only. Two tokens, two businesses: withdrawing from one
// never touches the other.

const fail = (code: string): UnsubscribeResult<never> => ({
  ok: false,
  error: { code },
});

export function memoryUnsubscribe(options: { delayMs?: number } = {}) {
  const subjects = new Map<string, UnsubscribeView>([
    [
      "tok-a-email",
      {
        businessName: "Atelier Maëlys",
        channel: "email",
        alreadyWithdrawn: false,
      },
    ],
    [
      "tok-b-sms",
      { businessName: "Studio Nora", channel: "sms", alreadyWithdrawn: false },
    ],
  ]);
  let writes = 0;
  const pause = () =>
    options.delayMs
      ? new Promise((resolve) => setTimeout(resolve, options.delayMs))
      : Promise.resolve();
  const set = (
    token: string,
    alreadyWithdrawn: boolean,
  ): UnsubscribeResult<UnsubscribeView> => {
    const subject = subjects.get(token);
    if (!subject) return fail(unsubscribeErrors.invalid);
    if (subject.alreadyWithdrawn !== alreadyWithdrawn) writes += 1;
    subject.alreadyWithdrawn = alreadyWithdrawn;
    return { ok: true, data: { ...subject } };
  };

  const actions: UnsubscribeActions = {
    async read(token) {
      await pause();
      const subject = subjects.get(token);
      return subject
        ? { ok: true, data: { ...subject } }
        : fail(unsubscribeErrors.invalid);
    },
    async withdraw(token) {
      await pause();
      return set(token, true);
    },
    async resubscribe(token) {
      await pause();
      return set(token, false);
    },
  };
  return {
    actions,
    subject: (token: string) => subjects.get(token),
    get writes() {
      return writes;
    },
  };
}
