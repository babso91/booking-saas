// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientNoteDto, ClientTimelineEvent } from "@/features/crm/types";

import {
  appointmentEvent,
  AUTHOR_ID,
  CLIENT_ID,
  clientRecord,
  emailEvent,
  note,
  noteEvent,
  notesPage,
  profile,
  timelinePage,
} from "../../../../tests/support/crm-fixtures";
import { ClientProfile } from "./client-profile";

// The profile as a workplace: editing the record and private notes, from
// what the professional sees and does. Server Actions are mocked at their
// module boundary with the real result shapes.

// Hoisted with the mocks below (vi.mock runs before the imports).
const { actions, call } = vi.hoisted(() => {
  const actions = {
    getClientProfileAction: vi.fn(),
    listClientTimelineAction: vi.fn(),
    listClientNotesAction: vi.fn(),
    createClientNoteAction: vi.fn(),
    updateClientNoteAction: vi.fn(),
    deleteClientNoteAction: vi.fn(),
    getClientRecordAction: vi.fn(),
    updateClientAction: vi.fn(),
  };
  const call =
    (name: keyof typeof actions) =>
    (...args: unknown[]) =>
      actions[name](...args);
  return { actions, call };
});
vi.mock("@/features/crm/actions/crm", () => ({
  listClientsAction: vi.fn(),
  getClientProfileAction: call("getClientProfileAction"),
  listClientTimelineAction: call("listClientTimelineAction"),
}));
vi.mock("@/features/crm/actions/client-notes", () => ({
  listClientNotesAction: call("listClientNotesAction"),
  createClientNoteAction: call("createClientNoteAction"),
  updateClientNoteAction: call("updateClientNoteAction"),
  deleteClientNoteAction: call("deleteClientNoteAction"),
}));
vi.mock("@/features/crm/actions/client-management", () => ({
  createClientAction: vi.fn(),
  getClientRecordAction: call("getClientRecordAction"),
  updateClientAction: call("updateClientAction"),
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string, fieldErrors?: Record<string, string[]>) => ({
  ok: false as const,
  error: { code, message: "backend text never shown", fieldErrors },
});
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

const originalMatchMedia = window.matchMedia;
function setViewport(wide: boolean) {
  window.matchMedia = (query: string) =>
    ({
      matches:
        query.includes("reduced-motion") ||
        (wide && query.includes("min-width: 1024px")),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList;
}

async function renderProfile({
  events = [appointmentEvent()],
  notes = [],
  legacyNotes = null,
}: {
  events?: ClientTimelineEvent[];
  notes?: ClientNoteDto[];
  legacyNotes?: string | null;
} = {}) {
  actions.getClientProfileAction.mockResolvedValue(ok(profile()));
  actions.listClientTimelineAction.mockResolvedValue(ok(timelinePage(events)));
  actions.listClientNotesAction.mockResolvedValue(
    ok(notesPage(notes, { legacyNotes })),
  );
  const view = render(<ClientProfile clientId={CLIENT_ID} />);
  await flush();
  return view;
}

const history = () =>
  within(screen.getByRole("region", { name: "Historique" }));
const notesSection = () =>
  within(screen.getByRole("region", { name: "Notes privées" }));
const dialog = () => within(screen.getByRole("dialog"));
const textarea = () => dialog().getByLabelText(/^Note/) as HTMLTextAreaElement;
const lastInput = (name: keyof typeof actions) =>
  actions[name].mock.calls[actions[name].mock.calls.length - 1]![0];
const timelineReads = () =>
  actions.listClientTimelineAction.mock.calls.map(([input]) => input);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  Object.values(actions).forEach((mock) => mock.mockReset());
  setViewport(true);
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = originalMatchMedia;
});

// ---------------------------------------------------------------------------

describe("notes in the relationship timeline", () => {
  it("a note sits at its date between other events, as plain text with its line breaks, never with its author's id", async () => {
    const written = note({
      local: "2026-10-02T16:10",
      content: "Peau sensible.\nPréfère <b>colle</b> douce.",
    });
    await renderProfile({
      events: [
        noteEvent(written),
        appointmentEvent({ start: "2026-10-02T14:30" }),
        emailEvent({ local: "2026-09-29T18:00" }),
      ],
    });
    const days = history().getAllByRole("time");
    expect(days.map((day) => day.getAttribute("datetime"))).toEqual([
      "2026-10-02",
      "2026-09-29",
    ]);
    const entry = history()
      .getByText(/Note privée · 16:10/)
      .closest("article")!;
    const text = within(entry).getByText(/Peau sensible/);
    expect(text.textContent).toBe(
      "Peau sensible.\nPréfère <b>colle</b> douce.",
    );
    expect(entry.querySelector("b")).toBeNull();
    // Server order kept: the note first on that day, then the appointment.
    const articles = history().getAllByRole("article");
    expect(articles[0]).toBe(entry);
    expect(document.body.textContent).not.toContain(AUTHOR_ID);
  });

  it("an edited note says when it was edited, from the backend's dates only", async () => {
    await renderProfile({
      events: [
        noteEvent(
          note({
            version: 2,
            edited: true,
            updatedAt: {
              at: "x",
              local: "2026-10-05T09:15",
              occurrence: null,
            },
            updatedBy: AUTHOR_ID,
          }),
        ),
      ],
    });
    expect(
      history().getByText("Modifiée le 5 octobre 2026 à 09:15"),
    ).toBeTruthy();
  });

  it("a page of notes only: every day shows its notes, none is empty", async () => {
    await renderProfile({
      events: [
        noteEvent(note({ local: "2026-10-03T10:00" })),
        noteEvent(note({ local: "2026-10-02T10:00" })),
      ],
    });
    for (const day of history().getAllByRole("time")) {
      const item = day.closest("li")!;
      expect(within(item).getAllByRole("article").length).toBe(1);
    }
  });

  it("a long note is folded without losing text", async () => {
    const content = `${"Une très longue remarque. ".repeat(40)}Fin.`;
    await renderProfile({ events: [noteEvent(note({ content }))] });
    const toggle = history().getByRole("button", { name: "Afficher plus" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(history().getByText(/Fin\.$/).textContent).toBe(content);
    fireEvent.click(toggle);
    expect(
      history()
        .getByRole("button", { name: "Afficher moins" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("an empty history mentions notes, without promising anything else", async () => {
    await renderProfile({ events: [] });
    expect(
      history().getByText(
        "Pas encore d’historique. Ses rendez-vous passés et tes notes apparaîtront ici.",
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("adding a note", () => {
  async function openComposer() {
    await renderProfile();
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    expect(
      screen.getByRole("dialog", { name: "Ajouter une note" }),
    ).toBeTruthy();
  }
  const save = () =>
    fireEvent.click(
      dialog().getByRole("button", { name: /^Enregistrer la note/ }),
    );
  const sentIds = () =>
    actions.createClientNoteAction.mock.calls.map(([input]) => input.requestId);

  it("writes the note once confirmed, then reads the history again from its first page", async () => {
    await openComposer();
    const written = note({ content: "Courbure D la prochaine fois." });
    let answer!: (value: unknown) => void;
    actions.createClientNoteAction.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );
    fireEvent.change(textarea(), {
      target: { value: "  Courbure D la prochaine fois.\n" },
    });
    save();
    save(); // double tap
    await flush();
    expect(actions.createClientNoteAction).toHaveBeenCalledTimes(1);
    expect(lastInput("createClientNoteAction")).toEqual({
      clientId: CLIENT_ID,
      content: "Courbure D la prochaine fois.",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // Not confirmed: the text is still there.
    expect(textarea().value).toBe("  Courbure D la prochaine fois.\n");

    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([noteEvent(written), appointmentEvent()])),
    );
    answer(ok({ note: written, created: true }));
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(timelineReads().at(-1)).toEqual({ clientId: CLIENT_ID, limit: 20 });
    expect(history().getByText("Courbure D la prochaine fois.")).toBeTruthy();
    expect(screen.getByText("Note ajoutée à l’historique.")).toBeTruthy();
    expect(actions.listClientNotesAction).toHaveBeenCalledTimes(2);

    // A new note is a new request.
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    expect(textarea().value).toBe("");
  });

  it("checks the text before sending, and the backend's limit", async () => {
    await openComposer();
    fireEvent.change(textarea(), { target: { value: "   " } });
    save();
    await flush();
    expect(actions.createClientNoteAction).not.toHaveBeenCalled();
    expect(
      dialog().getByText("Écris quelques mots avant d’enregistrer."),
    ).toBeTruthy();
    fireEvent.change(textarea(), { target: { value: "a".repeat(5001) } });
    save();
    await flush();
    expect(actions.createClientNoteAction).not.toHaveBeenCalled();
    expect(
      dialog().getByText(/^Note limitée à 5\s?000 caractères/),
    ).toBeTruthy();
  });

  it("a lost answer keeps the text; the retry of the same text reuses the request, another text is a new one", async () => {
    await openComposer();
    actions.createClientNoteAction.mockResolvedValueOnce(fail("network"));
    fireEvent.change(textarea(), { target: { value: "Allergie latex." } });
    save();
    await flush();
    expect(
      dialog().getByText(/La note a peut-être été enregistrée/),
    ).toBeTruthy();
    expect(textarea().value).toBe("Allergie latex.");

    actions.createClientNoteAction.mockResolvedValueOnce(fail("network"));
    fireEvent.click(dialog().getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(sentIds()[1]).toBe(sentIds()[0]);

    actions.createClientNoteAction.mockResolvedValueOnce(fail("network"));
    fireEvent.change(textarea(), { target: { value: "Allergie au latex." } });
    save();
    await flush();
    expect(sentIds()[2]).not.toBe(sentIds()[1]);
  });

  it("a replay whose note was deleted since: never reported as a new note, never re-sent on its own", async () => {
    await openComposer();
    actions.createClientNoteAction.mockResolvedValueOnce(fail("note_deleted"));
    fireEvent.change(textarea(), { target: { value: "Allergie latex." } });
    save();
    await flush();
    expect(
      dialog().getByText("Note déjà enregistrée, puis supprimée"),
    ).toBeTruthy();
    expect(screen.queryByText("Note ajoutée à l’historique.")).toBeNull();
    expect(textarea().value).toBe("Allergie latex.");
    await flush();
    expect(actions.createClientNoteAction).toHaveBeenCalledTimes(1);
    // The history is read again (the note is gone there too).
    expect(actions.listClientTimelineAction).toHaveBeenCalledTimes(2);

    const written = note({ content: "Allergie latex." });
    actions.createClientNoteAction.mockResolvedValueOnce(
      ok({ note: written, created: true }),
    );
    fireEvent.click(
      dialog().getByRole("button", {
        name: "L’enregistrer comme nouvelle note",
      }),
    );
    await flush();
    expect(sentIds()[1]).not.toBe(sentIds()[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an idempotency conflict: explained, and the request is only replaced by an explicit choice", async () => {
    await openComposer();
    actions.createClientNoteAction.mockResolvedValueOnce(
      fail("idempotency_conflict"),
    );
    fireEvent.change(textarea(), { target: { value: "Allergie latex." } });
    save();
    await flush();
    expect(dialog().getByText("Rien n’a été enregistré")).toBeTruthy();
    await flush();
    expect(actions.createClientNoteAction).toHaveBeenCalledTimes(1);
    fireEvent.click(
      dialog().getByRole("button", { name: "Abandonner ce texte" }),
    );
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.createClientNoteAction).toHaveBeenCalledTimes(1);
  });

  it("closing keeps the draft for later", async () => {
    await openComposer();
    fireEvent.change(textarea(), { target: { value: "À rappeler." } });
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    fireEvent.click(
      notesSection().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    expect(textarea().value).toBe("À rappeler.");
  });
});

// ---------------------------------------------------------------------------

describe("editing a note", () => {
  const written = note({ content: "Courbure C.", version: 2, edited: true });
  async function openEditor() {
    await renderProfile({
      events: [
        appointmentEvent({ start: "2026-10-04T10:00" }),
        noteEvent(written),
        emailEvent(),
      ],
    });
    fireEvent.click(
      history().getByRole("button", { name: /^Modifier la note du/ }),
    );
    await flush();
    expect(
      screen.getByRole("dialog", { name: "Modifier la note" }),
    ).toBeTruthy();
  }
  const save = () =>
    fireEvent.click(dialog().getByRole("button", { name: /^Enregistrer$/ }));

  it("acts on the note's own id and version, keeps its place, and the history is read again", async () => {
    await openEditor();
    const updated = { ...written, content: "Courbure D.", version: 3 };
    actions.updateClientNoteAction.mockResolvedValueOnce(
      ok({ note: updated, changed: true }),
    );
    let reread!: (value: unknown) => void;
    actions.listClientTimelineAction.mockReturnValueOnce(
      new Promise((resolve) => (reread = resolve)),
    );
    fireEvent.change(textarea(), { target: { value: "Courbure D." } });
    save();
    await flush();
    expect(lastInput("updateClientNoteAction")).toEqual({
      clientId: CLIENT_ID,
      noteId: written.id, // never "note:<id>"
      expectedVersion: 2,
      content: "Courbure D.",
    });
    // Confirmed content at the same position, before the re-read answers.
    const articles = history().getAllByRole("article");
    expect(within(articles[1]!).getByText("Courbure D.")).toBeTruthy();
    expect(timelineReads().at(-1)).toEqual({ clientId: CLIENT_ID, limit: 20 });
    reread(
      ok(
        timelinePage([
          appointmentEvent({ start: "2026-10-04T10:00" }),
          noteEvent(updated),
          emailEvent(),
        ]),
      ),
    );
    await flush();
    expect(
      within(history().getAllByRole("article")[1]!).getByText("Courbure D."),
    ).toBeTruthy();
    expect(screen.getByText("Note modifiée.")).toBeTruthy();
  });

  it("changed elsewhere: the text is kept, compared with the current version, and saved only by choice", async () => {
    await openEditor();
    actions.updateClientNoteAction.mockResolvedValueOnce(fail("stale_note"));
    fireEvent.change(textarea(), { target: { value: "Ma version." } });
    save();
    await flush();
    expect(dialog().getByText("Note modifiée ailleurs")).toBeTruthy();
    expect(textarea().value).toBe("Ma version.");
    expect(
      (
        dialog().getByRole("button", {
          name: /^Enregistrer$/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    const theirs = { ...written, content: "Leur version.", version: 4 };
    actions.listClientNotesAction.mockResolvedValueOnce(
      ok(notesPage([note(), theirs])),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Voir la version actuelle" }),
    );
    await flush();
    expect(lastInput("listClientNotesAction")).toEqual({
      clientId: CLIENT_ID,
      limit: 100,
      cursor: null,
    });
    expect(dialog().getByText("Leur version.")).toBeTruthy();
    expect(actions.updateClientNoteAction).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog().getByRole("button", { name: "Garder mon texte" }));
    actions.updateClientNoteAction.mockResolvedValueOnce(
      ok({
        note: { ...theirs, content: "Ma version.", version: 5 },
        changed: true,
      }),
    );
    save();
    await flush();
    expect(lastInput("updateClientNoteAction")).toMatchObject({
      noteId: written.id,
      expectedVersion: 4,
      content: "Ma version.",
    });
  });

  it("taking the current version replaces the draft with it", async () => {
    await openEditor();
    actions.updateClientNoteAction.mockResolvedValueOnce(fail("stale_note"));
    fireEvent.change(textarea(), { target: { value: "Ma version." } });
    save();
    await flush();
    const theirs = { ...written, content: "Leur version.", version: 4 };
    actions.listClientNotesAction.mockResolvedValueOnce(
      ok(notesPage([theirs])),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Voir la version actuelle" }),
    );
    await flush();
    fireEvent.click(
      dialog().getByRole("button", { name: "Reprendre la version actuelle" }),
    );
    expect(textarea().value).toBe("Leur version.");
  });

  it("deleted elsewhere: the text is kept and can become a new note", async () => {
    await openEditor();
    actions.updateClientNoteAction.mockResolvedValueOnce(
      fail("note_not_found"),
    );
    // The backend no longer returns it.
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([appointmentEvent({ start: "2026-10-04T10:00" })])),
    );
    fireEvent.change(textarea(), { target: { value: "Ma version." } });
    save();
    await flush();
    expect(dialog().getByText("Note supprimée entre-temps")).toBeTruthy();
    // Gone from the history at once.
    expect(history().queryByText("Courbure C.")).toBeNull();
    fireEvent.click(
      dialog().getByRole("button", {
        name: "L’enregistrer comme nouvelle note",
      }),
    );
    await flush();
    expect(
      screen.getByRole("dialog", { name: "Ajouter une note" }),
    ).toBeTruthy();
    expect(textarea().value).toBe("Ma version.");
    expect(actions.createClientNoteAction).not.toHaveBeenCalled();
  });

  it("closing keeps the draft; a background refresh never erases it", async () => {
    await openEditor();
    fireEvent.change(textarea(), { target: { value: "Brouillon." } });
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    // The history is read again meanwhile (same note, same version).
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    fireEvent.click(dialog().getByRole("button", { name: "Fermer" }));
    await flush();
    fireEvent.click(
      history().getByRole("button", { name: /^Modifier la note du/ }),
    );
    await flush();
    expect(textarea().value).toBe("Brouillon.");
  });

  it("a draft kept on an older version is compared before anything is saved", async () => {
    await openEditor();
    fireEvent.change(textarea(), { target: { value: "Brouillon." } });
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    // Edited elsewhere, then the history is read again.
    const theirs = { ...written, content: "Leur version.", version: 3 };
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([noteEvent(theirs)])),
    );
    actions.createClientNoteAction.mockResolvedValueOnce(
      ok({ note: note(), created: true }),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    fireEvent.change(textarea(), { target: { value: "Autre." } });
    fireEvent.click(
      dialog().getByRole("button", { name: /^Enregistrer la note/ }),
    );
    await flush();
    await flush();
    fireEvent.click(
      history().getByRole("button", { name: /^Modifier la note du/ }),
    );
    await flush();
    expect(textarea().value).toBe("Brouillon.");
    expect(dialog().getByText("Leur version.")).toBeTruthy();
    expect(actions.updateClientNoteAction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("deleting a note", () => {
  const written = note({ content: "À supprimer.", version: 2 });
  async function askDelete() {
    await renderProfile({
      events: [noteEvent(written), appointmentEvent()],
      notes: [written],
    });
    fireEvent.click(
      history().getByRole("button", { name: /^Supprimer la note du/ }),
    );
    await flush();
  }

  it("asks first; going back deletes nothing", async () => {
    await askDelete();
    expect(
      screen.getByRole("dialog", { name: "Supprimer cette note ?" }),
    ).toBeTruthy();
    expect(dialog().getByText("À supprimer.")).toBeTruthy();
    fireEvent.click(dialog().getByRole("button", { name: "Retour" }));
    await flush();
    expect(actions.deleteClientNoteAction).not.toHaveBeenCalled();
    expect(history().getByText("À supprimer.")).toBeTruthy();
  });

  it("once confirmed: gone from the history and the dossier at once, both read again, no event invented", async () => {
    await askDelete();
    actions.deleteClientNoteAction.mockResolvedValueOnce(
      ok({ noteId: written.id, deleted: true }),
    );
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([appointmentEvent()])),
    );
    actions.listClientNotesAction.mockResolvedValue(ok(notesPage([])));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    expect(lastInput("deleteClientNoteAction")).toEqual({
      clientId: CLIENT_ID,
      noteId: written.id,
      expectedVersion: 2,
    });
    expect(screen.queryByText("À supprimer.")).toBeNull();
    expect(history().getAllByRole("article")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(
      /supprimée le|Note supprimée ·/,
    );
    expect(screen.getByText("Note supprimée.")).toBeTruthy();
    expect(timelineReads().at(-1)).toEqual({ clientId: CLIENT_ID, limit: 20 });
  });

  it("already deleted (deleted: false) is the same outcome; nothing is restored", async () => {
    await askDelete();
    actions.deleteClientNoteAction.mockResolvedValueOnce(
      ok({ noteId: written.id, deleted: false }),
    );
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([appointmentEvent()])),
    );
    actions.listClientNotesAction.mockResolvedValue(ok(notesPage([])));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    expect(screen.queryByText("À supprimer.")).toBeNull();
  });

  it("changed since it was read: nothing deleted, said plainly", async () => {
    await askDelete();
    actions.deleteClientNoteAction.mockResolvedValueOnce(fail("stale_note"));
    fireEvent.click(dialog().getByRole("button", { name: "Supprimer" }));
    await flush();
    expect(
      screen.getByRole("dialog", { name: "Note modifiée entre-temps" }),
    ).toBeTruthy();
    expect(dialog().getByText(/rien n’a été supprimé/)).toBeTruthy();
    expect(history().getByText("À supprimer.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("notes in the dossier", () => {
  it("the latest notes, a way to the full history, and the former notes read only", async () => {
    setViewport(false);
    const latest = note({ content: "La plus récente." });
    actions.getClientProfileAction.mockResolvedValue(ok(profile()));
    actions.listClientTimelineAction.mockResolvedValue(
      ok(timelinePage([noteEvent(latest)])),
    );
    actions.listClientNotesAction.mockResolvedValue(
      ok(
        notesPage([latest], {
          legacyNotes: "Ancienne fiche :\nallergie latex",
          nextCursor: "n1",
        }),
      ),
    );
    render(<ClientProfile clientId={CLIENT_ID} />);
    await flush();
    expect(lastInput("listClientNotesAction")).toEqual({
      clientId: CLIENT_ID,
      limit: 3,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Dossier" }));
    expect(notesSection().getByText("La plus récente.")).toBeTruthy();
    const legacy = notesSection().getByRole("heading", {
      name: "Notes précédentes",
    });
    expect(legacy).toBeTruthy();
    expect(notesSection().getByText(/Ancienne fiche/).textContent).toBe(
      "Ancienne fiche :\nallergie latex",
    );
    expect(within(legacy.parentElement!).queryByRole("button")).toBeNull();

    fireEvent.click(
      notesSection().getByRole("button", {
        name: "Toutes les notes sont dans l’historique, à leur date",
      }),
    );
    await flush();
    expect(
      screen
        .getByRole("tab", { name: "Historique" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("no former notes: no such section", async () => {
    await renderProfile();
    expect(
      notesSection().queryByRole("heading", { name: "Notes précédentes" }),
    ).toBeNull();
    expect(notesSection().getByText(/Aucune note pour l’instant/)).toBeTruthy();
  });

  it("notes read in another time zone than the profile say so", async () => {
    actions.getClientProfileAction.mockResolvedValue(ok(profile()));
    actions.listClientTimelineAction.mockResolvedValue(ok(timelinePage([])));
    actions.listClientNotesAction.mockResolvedValue(
      ok(notesPage([note()], { timezone: "America/Vancouver" })),
    );
    render(<ClientProfile clientId={CLIENT_ID} />);
    await flush();
    expect(
      notesSection().getByText("Heures de America/Vancouver."),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("editing the record", () => {
  const record = clientRecord();
  const field = (name: RegExp) =>
    dialog().getByLabelText(name) as HTMLInputElement;
  const type = (name: RegExp, value: string) =>
    fireEvent.change(field(name), { target: { value } });
  const save = () =>
    fireEvent.click(dialog().getByRole("button", { name: /^Enregistrer$/ }));
  const saved = (
    overrides: Record<string, unknown> = {},
    retained = {
      upcomingAppointmentsWithOtherEmail: 0,
      queuedEmailsToOtherAddress: 0,
    },
  ) =>
    ok({
      client: { ...record, version: 4, ...overrides },
      changed: true,
      retained,
    });

  async function openEditor() {
    await renderProfile();
    actions.getClientRecordAction.mockResolvedValueOnce(ok(record));
    fireEvent.click(screen.getByRole("button", { name: "Modifier la fiche" }));
    await flush();
    expect(actions.getClientRecordAction).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
    });
    expect(field(/^Prénom/).value).toBe("Emma");
  }

  it("saves on the version read; the page shows the new values and what keeps the former contact", async () => {
    await openEditor();
    type(/^Prénom/, "Emmy");
    type(/^Email/, "emmy@exemple.fr");
    actions.getClientProfileAction.mockResolvedValue(
      ok(
        profile({
          client: {
            displayName: "Emmy Laurent",
            firstName: "Emmy",
            email: "emmy@exemple.fr",
          },
        }),
      ),
    );
    actions.updateClientAction.mockResolvedValueOnce(
      saved(
        {
          displayName: "Emmy Laurent",
          firstName: "Emmy",
          email: "emmy@exemple.fr",
        },
        {
          upcomingAppointmentsWithOtherEmail: 2,
          queuedEmailsToOtherAddress: 1,
        },
      ),
    );
    save();
    await flush();
    expect(lastInput("updateClientAction")).toEqual({
      clientId: CLIENT_ID,
      expectedVersion: 3,
      firstName: "Emmy",
      lastName: "Laurent",
      email: "emmy@exemple.fr",
      phone: "06 12 34 56 78",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Emmy Laurent" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /2 rendez-vous à venir gardent l’email indiqué à la réservation ; 1 email déjà programmé reste adressé à l’ancienne adresse/,
      ),
    ).toBeTruthy();
    // The profile is read again (the server decides).
    expect(actions.getClientProfileAction).toHaveBeenCalledTimes(2);
  });

  it("changed elsewhere: the draft is kept, compared field by field, and resent only by choice on the new version", async () => {
    await openEditor();
    type(/^Téléphone/, "07 00 00 00 00");
    actions.updateClientAction.mockResolvedValueOnce(fail("stale_client"));
    save();
    await flush();
    expect(dialog().getByText("Fiche modifiée ailleurs")).toBeTruthy();
    expect(field(/^Téléphone/).value).toBe("07 00 00 00 00");

    actions.getClientRecordAction.mockResolvedValueOnce(
      ok(clientRecord({ phone: "06 99 99 99 99", version: 5 })),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Voir la version actuelle" }),
    );
    await flush();
    expect(dialog().getByText("Maintenant : 06 99 99 99 99")).toBeTruthy();
    expect(dialog().getByText("Ta saisie : 07 00 00 00 00")).toBeTruthy();
    expect(actions.updateClientAction).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog().getByRole("button", { name: "Garder ma saisie" }));
    actions.updateClientAction.mockResolvedValueOnce(
      saved({ phone: "07 00 00 00 00", version: 6 }),
    );
    save();
    await flush();
    expect(lastInput("updateClientAction")).toMatchObject({
      expectedVersion: 5,
      phone: "07 00 00 00 00",
    });
  });

  it("a field changed elsewhere but not by the professional is never reverted by her save", async () => {
    await openEditor();
    type(/^Email/, "emma@nouveau.fr"); // only the email is hers
    actions.updateClientAction.mockResolvedValueOnce(fail("stale_client"));
    save();
    await flush();
    actions.getClientRecordAction.mockResolvedValueOnce(
      ok(clientRecord({ phone: "06 99 99 99 99", version: 5 })),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Voir la version actuelle" }),
    );
    await flush();
    expect(dialog().getByText("Maintenant : 06 99 99 99 99")).toBeTruthy();
    expect(
      dialog().getByText(
        "Tu ne l’avais pas modifié : la valeur actuelle sera gardée.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder mes modifications" }),
    );
    expect(field(/^Téléphone/).value).toBe("06 99 99 99 99");
    expect(field(/^Email/).value).toBe("emma@nouveau.fr");
    actions.updateClientAction.mockResolvedValueOnce(
      saved({ email: "emma@nouveau.fr", phone: "06 99 99 99 99", version: 6 }),
    );
    save();
    await flush();
    expect(lastInput("updateClientAction")).toMatchObject({
      expectedVersion: 5,
      email: "emma@nouveau.fr",
      phone: "06 99 99 99 99",
    });
  });

  it("taking the current version replaces the draft with it", async () => {
    await openEditor();
    type(/^Téléphone/, "07 00 00 00 00");
    actions.updateClientAction.mockResolvedValueOnce(fail("stale_client"));
    save();
    await flush();
    actions.getClientRecordAction.mockResolvedValueOnce(
      ok(clientRecord({ phone: "06 99 99 99 99", version: 5 })),
    );
    fireEvent.click(
      dialog().getByRole("button", { name: "Voir la version actuelle" }),
    );
    await flush();
    fireEvent.click(
      dialog().getByRole("button", { name: "Reprendre la version actuelle" }),
    );
    expect(field(/^Téléphone/).value).toBe("06 99 99 99 99");
  });

  it("an email used by another customer: opens her record, never merges", async () => {
    await openEditor();
    type(/^Email/, "ines@exemple.fr");
    actions.updateClientAction.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "client_email_conflict",
        message: "backend text never shown",
        fieldErrors: { email: ["x"] },
        conflict: {
          clientId: "30000000-0000-4000-8000-00000000bbbb",
          displayName: "Inès Benali",
        },
      },
    });
    save();
    await flush();
    expect(
      dialog()
        .getByRole("link", { name: "Ouvrir la fiche existante" })
        .getAttribute("href"),
    ).toBe("/app/clients/30000000-0000-4000-8000-00000000bbbb");
    expect(dialog().getByText(/les deux fiches restent séparées/)).toBeTruthy();
    expect(field(/^Email/).value).toBe("ines@exemple.fr");
  });

  it("closing keeps the draft (said on the button); reopening shows it without losing it to a re-read", async () => {
    await openEditor();
    type(/^Nom/, "Laurent-Petit");
    fireEvent.click(
      dialog().getByRole("button", { name: "Garder pour plus tard" }),
    );
    await flush();
    expect(
      screen.getByRole("button", {
        name: "Reprendre la modification de la fiche",
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reprendre la modification de la fiche",
      }),
    );
    await flush();
    expect(field(/^Nom/).value).toBe("Laurent-Petit");
    expect(actions.getClientRecordAction).toHaveBeenCalledTimes(1);
  });

  it("a background refresh of the profile never erases what is being typed", async () => {
    // Profile in Paris, history in Vancouver: an automatic profile re-read.
    const automatic = deferred();
    actions.getClientProfileAction
      .mockResolvedValueOnce(ok(profile()))
      .mockReturnValueOnce(automatic.promise);
    actions.listClientTimelineAction.mockResolvedValue(
      ok({ ...timelinePage([]), timezone: "America/Vancouver" }),
    );
    actions.listClientNotesAction.mockResolvedValue(ok(notesPage()));
    render(<ClientProfile clientId={CLIENT_ID} />);
    await flush();
    await flush();
    actions.getClientRecordAction.mockResolvedValueOnce(ok(record));
    fireEvent.click(screen.getByRole("button", { name: "Modifier la fiche" }));
    await flush();
    type(/^Téléphone/, "07 00 00 00 00");

    automatic.resolve(
      ok({
        ...profile({ client: { phone: "06 99 99 99 99" } }),
        timezone: "America/Vancouver",
      }),
    );
    await flush();
    expect(field(/^Téléphone/).value).toBe("07 00 00 00 00");
  });
});

// ---------------------------------------------------------------------------

describe("races: only the newest answer of each read is shown", () => {
  it("a late answer of an older notes read never replaces a newer one", async () => {
    const first = deferred();
    actions.getClientProfileAction.mockResolvedValue(ok(profile()));
    actions.listClientTimelineAction.mockResolvedValue(ok(timelinePage([])));
    actions.listClientNotesAction.mockReturnValueOnce(first.promise);
    render(<ClientProfile clientId={CLIENT_ID} />);
    await flush();

    // A note is written: the dossier's notes are read again, and answer.
    const written = note({ content: "La nouvelle." });
    actions.createClientNoteAction.mockResolvedValueOnce(
      ok({ note: written, created: true }),
    );
    actions.listClientNotesAction.mockResolvedValueOnce(
      ok(notesPage([written])),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    fireEvent.change(textarea(), { target: { value: "La nouvelle." } });
    fireEvent.click(
      dialog().getByRole("button", { name: /^Enregistrer la note/ }),
    );
    await flush();
    expect(notesSection().getByText("La nouvelle.")).toBeTruthy();

    first.resolve(ok(notesPage([]))); // the first read, too late
    await flush();
    expect(notesSection().getByText("La nouvelle.")).toBeTruthy();
  });

  it("a late failure of an older read never covers a newer success with an error", async () => {
    const first = deferred();
    actions.getClientProfileAction.mockResolvedValue(ok(profile()));
    actions.listClientTimelineAction.mockResolvedValue(ok(timelinePage([])));
    actions.listClientNotesAction.mockReturnValueOnce(first.promise);
    render(<ClientProfile clientId={CLIENT_ID} />);
    await flush();
    actions.createClientNoteAction.mockResolvedValueOnce(
      ok({ note: note(), created: true }),
    );
    actions.listClientNotesAction.mockResolvedValueOnce(
      ok(notesPage([note()])),
    );
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    fireEvent.change(textarea(), { target: { value: "Texte." } });
    fireEvent.click(
      dialog().getByRole("button", { name: /^Enregistrer la note/ }),
    );
    await flush();
    first.resolve(fail("internal"));
    await flush();
    expect(notesSection().queryByRole("alert")).toBeNull();
  });

  it("two writes in a row: the history shows the second re-read, never the first one answering late", async () => {
    await renderProfile({ events: [] });
    const firstRead = deferred();
    const one = note({ content: "Une." });
    const two = note({ content: "Deux." });
    actions.createClientNoteAction
      .mockResolvedValueOnce(ok({ note: one, created: true }))
      .mockResolvedValueOnce(ok({ note: two, created: true }));
    actions.listClientTimelineAction
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValueOnce(
        ok(timelinePage([noteEvent(two), noteEvent(one)])),
      );
    for (const text of ["Une.", "Deux."]) {
      fireEvent.click(
        history().getByRole("button", { name: "Ajouter une note" }),
      );
      await flush();
      fireEvent.change(textarea(), { target: { value: text } });
      fireEvent.click(
        dialog().getByRole("button", { name: /^Enregistrer la note/ }),
      );
      await flush();
    }
    expect(history().getByText("Deux.")).toBeTruthy();
    firstRead.resolve(ok(timelinePage([noteEvent(one)])));
    await flush();
    expect(history().getByText("Deux.")).toBeTruthy();
    expect(history().getAllByRole("article")).toHaveLength(2);
  });

  it("an answer arriving after the page is left triggers nothing", async () => {
    const pending = deferred();
    const view = await renderProfile();
    fireEvent.click(
      history().getByRole("button", { name: "Ajouter une note" }),
    );
    await flush();
    actions.createClientNoteAction.mockReturnValueOnce(pending.promise);
    fireEvent.change(textarea(), { target: { value: "Texte." } });
    fireEvent.click(
      dialog().getByRole("button", { name: /^Enregistrer la note/ }),
    );
    await flush();
    const reads = {
      timeline: actions.listClientTimelineAction.mock.calls.length,
      notes: actions.listClientNotesAction.mock.calls.length,
    };
    view.unmount(); // another customer mounts a new instance
    pending.resolve(ok({ note: note(), created: true }));
    await flush();
    expect(actions.listClientTimelineAction.mock.calls.length).toBe(
      reads.timeline,
    );
    expect(actions.listClientNotesAction.mock.calls.length).toBe(reads.notes);
  });
});
