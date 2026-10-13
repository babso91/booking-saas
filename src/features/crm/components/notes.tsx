"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button, type ButtonState } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextAreaField } from "@/components/ui/field";
import { LockIcon } from "@/components/ui/icons";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import {
  fingerprintOf,
  requestKeyFor,
  type RequestKey,
} from "@/features/agenda/client/request-id";
import { callAction, type UiError } from "@/features/auth/client/call-action";
import {
  createClientNoteAction,
  deleteClientNoteAction,
  listClientNotesAction,
  updateClientNoteAction,
} from "@/features/crm/actions/client-notes";
import type { ClientNoteDto } from "@/features/crm/types";
import { cn } from "@/lib/cn";

import { dayMonthYear, timeLabel } from "../client/format";
import {
  checkNote,
  isLongNote,
  MAX_NOTE_LENGTH,
  noteContent,
} from "../client/notes";
import { CrmError } from "./crm-error";

// Private notes: what the professional writes about a customer, dated by
// when it was written. Shown in the relationship timeline (at its date) and
// the dossier (the latest few), from the same server DTO; every write is
// followed by a fresh read of both. Content is plain text, never HTML, and
// never logged or put in a URL.

const linkAction =
  "cursor-pointer text-[14px] font-semibold text-ink underline decoration-line-strong underline-offset-4";

/** What a write changed, for the views showing notes. */
export type NoteChange =
  | { type: "created"; note: ClientNoteDto }
  | { type: "updated"; note: ClientNoteDto }
  | { type: "deleted"; noteId: string }
  /** Something changed elsewhere (stale, already deleted): re-read. */
  | { type: "stale" };

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** The note's text, as typed (line breaks kept), folded when long. */
export function NoteText({ content }: { content: string }) {
  const long = isLongNote(content);
  const [unfolded, setUnfolded] = useState(false);
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <p
        id={id}
        className={cn(
          "max-w-full text-[14.5px] leading-relaxed whitespace-pre-wrap text-ink wrap-anywhere",
          long && !unfolded && "line-clamp-6",
        )}
      >
        {content}
      </p>
      {long ? (
        <button
          type="button"
          aria-expanded={unfolded}
          aria-controls={id}
          onClick={() => setUnfolded((value) => !value)}
          className="cursor-pointer text-[13px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          {unfolded ? "Afficher moins" : "Afficher plus"}
        </button>
      ) : null}
    </div>
  );
}

/** "Modifiée le 3 oct. 2026 à 10:12": only what the backend says. */
export function editedLabel(note: ClientNoteDto) {
  return note.edited
    ? `Modifiée le ${dayMonthYear(note.updatedAt)} à ${timeLabel(note.updatedAt)}`
    : null;
}

/** Edit and delete, for one note (its id and version as read). */
export function NoteActions({
  note,
  onEdit,
  onDelete,
}: {
  note: ClientNoteDto;
  onEdit: (note: ClientNoteDto) => void;
  onDelete: (note: ClientNoteDto) => void;
}) {
  // Which note, for screen readers: its date (never its content).
  const label = `${dayMonthYear(note.createdAt)} à ${timeLabel(note.createdAt)}`;
  const action =
    "flex h-9 cursor-pointer items-center rounded-lg px-2 text-[13px] font-medium text-ink-soft hover:bg-sand hover:text-ink";
  return (
    <div className="-mr-2 flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => onEdit(note)}
        aria-label={`Modifier la note du ${label}`}
        className={action}
      >
        Modifier
      </button>
      <button
        type="button"
        onClick={() => onDelete(note)}
        aria-label={`Supprimer la note du ${label}`}
        className={action}
      >
        Supprimer
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dossier: the latest notes and the former free-text notes
// ---------------------------------------------------------------------------

/** Notes shown in the dossier (the timeline has all of them). */
export const DOSSIER_NOTES = 3;

export type NotesListState = {
  status: "loading" | "ready" | "error";
  notes: ClientNoteDto[];
  legacyNotes: string | null;
  /** Time zone of `notes`, as returned with them. */
  timezone: string | null;
  more: boolean;
  error: UiError | null;
};

/**
 * The dossier's latest notes and legacy notes (one small read). Only the
 * newest read is applied; a re-read keeps what is shown until it answers.
 */
export function useNotesList(clientId: string) {
  const [state, setState] = useState<NotesListState>({
    status: "loading",
    notes: [],
    legacyNotes: null,
    timezone: null,
    more: false,
    error: null,
  });
  const [run, setRun] = useState(0);
  const reads = useRef(0);

  useEffect(() => {
    const read = (reads.current += 1);
    void callAction(() =>
      listClientNotesAction({ clientId, limit: DOSSIER_NOTES }),
    ).then((result) => {
      if (read !== reads.current) return;
      setState((value) =>
        result.ok
          ? {
              status: "ready",
              notes: result.data.notes,
              legacyNotes: result.data.legacyNotes,
              timezone: result.data.timezone,
              more: result.data.nextCursor !== null,
              error: null,
            }
          : { ...value, status: "error", error: result.error },
      );
    });
    return () => {
      reads.current += 1;
    };
  }, [clientId, run]);

  return {
    state,
    reload() {
      setState((value) => ({ ...value, status: "loading", error: null }));
      setRun((value) => value + 1);
    },
    /** A confirmed write, shown at once (the re-read that follows decides). */
    apply(change: NoteChange) {
      setState((value) => {
        if (change.type === "updated") {
          return {
            ...value,
            notes: value.notes.map((note) =>
              note.id === change.note.id ? change.note : note,
            ),
          };
        }
        if (change.type === "deleted") {
          return {
            ...value,
            notes: value.notes.filter((note) => note.id !== change.noteId),
          };
        }
        return value;
      });
    },
  };
}

export function DossierNotes({
  list,
  profileTimezone,
  onAdd,
  onEdit,
  onDelete,
  onRetry,
  onShowHistory,
}: {
  list: NotesListState;
  profileTimezone: string;
  onAdd: () => void;
  onEdit: (note: ClientNoteDto) => void;
  onDelete: (note: ClientNoteDto) => void;
  onRetry: () => void;
  onShowHistory: () => void;
}) {
  const headingId = useId();
  const shown = list.notes.length > 0;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-3xl border border-line bg-paper-raised px-5 py-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2
          id={headingId}
          data-notes-heading=""
          tabIndex={-1}
          className="font-display text-[22px] leading-tight text-ink focus:outline-none"
        >
          Notes privées
        </h2>
        <button
          type="button"
          onClick={onAdd}
          className="flex h-10 shrink-0 cursor-pointer items-center rounded-xl border border-line px-3 text-[13.5px] font-medium text-ink hover:border-line-strong"
        >
          Ajouter une note
        </button>
      </div>
      <p className="flex items-center gap-1.5 text-[12.5px] text-ink-muted">
        <LockIcon size={14} className="shrink-0" />
        Visibles seulement dans ton espace, jamais par la cliente.
      </p>

      {list.status === "error" && list.error ? (
        <CrmError error={list.error} onRetry={onRetry}>
          {list.error.code === "unauthenticated"
            ? undefined
            : shown
              ? "Les notes n’ont pas pu être actualisées. Celles affichées viennent du dernier chargement réussi."
              : "Les notes n’ont pas pu être chargées."}
        </CrmError>
      ) : null}

      {list.status === "loading" && !shown ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only" role="status">
            Chargement des notes…
          </span>
          <span className="h-12 animate-pulse rounded-2xl bg-sand/60" />
        </div>
      ) : shown ? (
        <ul
          aria-busy={list.status === "loading"}
          className="flex flex-col gap-2.5"
        >
          {list.notes.map((note) => (
            <li
              key={note.id}
              className="flex min-w-0 flex-col gap-1.5 rounded-2xl bg-paper px-3.5 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12.5px] text-ink-muted">
                  {dayMonthYear(note.createdAt)} à {timeLabel(note.createdAt)}
                </p>
                <NoteActions note={note} onEdit={onEdit} onDelete={onDelete} />
              </div>
              <NoteText content={note.content} />
              {note.edited ? (
                <p className="text-[12px] text-ink-muted">
                  {editedLabel(note)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : list.status === "ready" ? (
        <p className="text-[14px] text-ink-muted">
          Aucune note pour l’instant. Une préférence, une remarque : note-la
          ici, elle restera à sa date dans l’historique.
        </p>
      ) : null}

      {shown ? (
        <button
          type="button"
          onClick={onShowHistory}
          className="w-fit cursor-pointer text-[13px] text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          {list.more
            ? "Toutes les notes sont dans l’historique, à leur date"
            : "Voir les notes dans l’historique"}
        </button>
      ) : null}

      {list.timezone && list.timezone !== profileTimezone ? (
        <p className="text-[12.5px] text-ink-muted">
          Heures de {list.timezone}.
        </p>
      ) : null}

      {list.legacyNotes ? (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-line pt-3">
          <h3 className="text-[14px] font-semibold text-ink">
            Notes précédentes
          </h3>
          <p className="text-[12.5px] text-ink-muted">
            Saisies avant les notes datées, sans date connue. Lecture seule.
          </p>
          <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink-soft wrap-anywhere">
            {list.legacyNotes}
          </p>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Writing a note
// ---------------------------------------------------------------------------

/**
 * Adds a note. One idempotency key per content: a retry of the same text
 * (lost answer, double tap) reuses it and never writes the note twice;
 * another text is another note. The text stays until the backend confirmed
 * the note. A key is never replaced to get past a refusal: sending the
 * text as a new note is the professional's explicit choice.
 */
export function NoteComposerSheet({
  clientId,
  open,
  text,
  onTextChange,
  onClose,
  onChanged,
}: {
  clientId: string;
  open: boolean;
  /** The draft, kept by the page while the sheet is closed. */
  text: string;
  onTextChange: (text: string) => void;
  onClose: () => void;
  onChanged: (change: NoteChange) => void;
}) {
  const [state, setState] = useState<ButtonState>("idle");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [failure, setFailure] = useState<UiError | null>(null);
  const key = useRef<RequestKey | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function submit(fresh = false) {
    if (state !== "idle") return;
    const problem = checkNote(text);
    setFieldError(problem ?? undefined);
    if (problem) return;
    const content = noteContent(text);
    const fingerprint = fingerprintOf({ clientId, content });
    key.current = fresh
      ? { fingerprint, id: crypto.randomUUID() }
      : requestKeyFor(key.current, fingerprint);
    const requestId = key.current.id;
    setFailure(null);
    setState("loading");
    const result = await callAction(() =>
      createClientNoteAction({ clientId, content, requestId }),
    );
    if (!alive.current) return;
    setState("idle");
    if (result.ok) {
      key.current = null;
      onTextChange("");
      onChanged({ type: "created", note: result.data.note });
      onClose();
      return;
    }
    const error = result.error;
    if (error.code === "validation_error" && error.fieldErrors?.content) {
      setFieldError("Cette note ne peut pas être enregistrée telle quelle.");
      return;
    }
    if (error.code === "note_deleted") onChanged({ type: "stale" });
    setFailure(error);
  }

  return (
    <Sheet
      open={open}
      onClose={() => (state === "idle" ? onClose() : undefined)}
      title="Ajouter une note"
      description="Privée : visible seulement dans ton espace, à sa date dans l’historique."
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
            disabled={state !== "idle"}
          >
            {noteContent(text) ? "Garder pour plus tard" : "Annuler"}
          </Button>
          <Button
            type="submit"
            form="note-composer"
            size="md"
            state={state}
            loadingLabel="Enregistrement…"
          >
            Enregistrer la note
          </Button>
        </div>
      }
    >
      <form
        id="note-composer"
        aria-busy={state === "loading"}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4 pt-1"
      >
        <TextAreaField
          label="Note"
          value={text}
          // Locked while sent: what is sent is what is saved, and the
          // confirmation never drops text typed meanwhile.
          readOnly={state !== "idle"}
          onChange={(event) => {
            if (state !== "idle") return;
            onTextChange(event.target.value);
            setFieldError(undefined);
          }}
          error={fieldError}
          counterMax={MAX_NOTE_LENGTH}
          placeholder="Par exemple : souhaite essayer une courbure D au prochain rendez-vous."
          data-autofocus=""
          rows={5}
        />
        {failure ? (
          <WriteFailure
            error={failure}
            subject="create"
            onRetry={() => void submit()}
            onSendAsNew={() => void submit(true)}
            onDiscard={() => {
              key.current = null;
              setFailure(null);
              onTextChange("");
              onClose();
            }}
          />
        ) : null}
      </form>
    </Sheet>
  );
}

/** The current version of a note, read from the latest notes (bounded). */
async function findNote(
  clientId: string,
  noteId: string,
): Promise<
  | { status: "found"; note: ClientNoteDto }
  | { status: "gone" }
  | { status: "unknown" }
  | { status: "error"; error: UiError }
> {
  let cursor: string | null = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await callAction(() =>
      listClientNotesAction({ clientId, limit: 100, cursor }),
    );
    if (!result.ok) return { status: "error", error: result.error };
    const note = result.data.notes.find((item) => item.id === noteId);
    if (note) return { status: "found", note };
    if (!result.data.nextCursor) return { status: "gone" };
    cursor = result.data.nextCursor;
  }
  return { status: "unknown" };
}

type Draft = { text: string; base: ClientNoteDto };

/**
 * Edits a note on the version it was read at. Drafts are kept per note
 * while the page is open (closing the sheet or a refresh never loses
 * them); a note changed or deleted elsewhere is compared, never overwritten
 * silently.
 */
export function NoteEditorSheet({
  clientId,
  note,
  onClose,
  onChanged,
  onSaveAsNew,
}: {
  clientId: string;
  /** The note opened (as its view read it); null when closed. */
  note: ClientNoteDto | null;
  onClose: () => void;
  onChanged: (change: NoteChange) => void;
  /** The note is gone: offer the text as a new note. */
  onSaveAsNew: (text: string) => void;
}) {
  // One store for the page's lifetime (the sheet's content remounts per
  // note); written only from event handlers.
  const [drafts] = useState(() => new Map<string, Draft>());
  // While a save is pending the sheet stays open (X, Escape, backdrop):
  // its answer must reach the page, which re-reads the notes.
  const [saving, setSaving] = useState(false);
  return (
    <Sheet
      open={note !== null}
      onClose={() => (saving ? undefined : onClose())}
      title="Modifier la note"
      description={
        note
          ? `Écrite le ${dayMonthYear(note.createdAt)} à ${timeLabel(note.createdAt)}. Elle reste à cette date dans l’historique.`
          : undefined
      }
    >
      {note ? (
        <NoteEditor
          key={note.id}
          clientId={clientId}
          note={note}
          drafts={drafts}
          onClose={onClose}
          onChanged={onChanged}
          onSaveAsNew={onSaveAsNew}
          onSavingChange={setSaving}
        />
      ) : null}
    </Sheet>
  );
}

type Lookup =
  | { status: "loading" }
  | { status: "found"; note: ClientNoteDto }
  | { status: "gone" }
  | { status: "unknown" }
  | { status: "error"; error: UiError };

function NoteEditor({
  clientId,
  note,
  drafts,
  onClose,
  onChanged,
  onSaveAsNew,
  onSavingChange,
}: {
  clientId: string;
  note: ClientNoteDto;
  drafts: Map<string, Draft>;
  onClose: () => void;
  onChanged: (change: NoteChange) => void;
  onSaveAsNew: (text: string) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const kept = drafts.get(note.id);
  // A kept draft started from another version: compare before saving.
  const changedSinceDraft =
    kept !== undefined && kept.base.version !== note.version;
  const [text, setText] = useState(kept?.text ?? note.content);
  const [base, setBase] = useState<ClientNoteDto>(kept?.base ?? note);
  const [state, setState] = useState<ButtonState>("idle");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [failure, setFailure] = useState<UiError | null>(
    changedSinceDraft ? { code: "stale_note" } : null,
  );
  const [lookup, setLookup] = useState<Lookup | null>(
    changedSinceDraft ? { status: "found", note } : null,
  );
  const alive = useRef(true);
  const lookups = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Never leave the sheet locked once this editor is gone.
  useEffect(() => () => onSavingChange(false), [onSavingChange]);

  function edit(value: string) {
    // Locked while saving: a late event never changes what was sent.
    if (state !== "idle") return;
    setText(value);
    setFieldError(undefined);
    // Only a real change is kept as a draft.
    if (noteContent(value) === base.content) drafts.delete(note.id);
    else drafts.set(note.id, { text: value, base });
  }

  function forget() {
    drafts.delete(note.id);
  }

  async function save() {
    if (state !== "idle") return;
    const problem = checkNote(text);
    setFieldError(problem ?? undefined);
    if (problem) return;
    setFailure(null);
    setLookup(null);
    setState("loading");
    onSavingChange(true);
    const result = await callAction(() =>
      updateClientNoteAction({
        clientId,
        noteId: base.id,
        expectedVersion: base.version,
        content: noteContent(text),
      }),
    );
    if (!alive.current) return;
    setState("idle");
    onSavingChange(false);
    if (result.ok) {
      forget();
      onChanged({ type: "updated", note: result.data.note });
      onClose();
      return;
    }
    const error = result.error;
    if (error.code === "validation_error" && error.fieldErrors?.content) {
      setFieldError("Cette note ne peut pas être enregistrée telle quelle.");
      return;
    }
    if (error.code === "note_not_found") {
      onChanged({ type: "deleted", noteId: base.id });
      setFailure(error);
      setLookup({ status: "gone" });
      return;
    }
    if (error.code === "stale_note") onChanged({ type: "stale" });
    setFailure(error);
  }

  function compare() {
    setLookup({ status: "loading" });
    const read = (lookups.current += 1);
    void findNote(clientId, base.id).then((found) => {
      if (!alive.current || read !== lookups.current) return;
      setLookup(found);
      if (found.status === "gone") {
        onChanged({ type: "deleted", noteId: base.id });
      }
    });
  }

  function keepMine(latest: ClientNoteDto) {
    setBase(latest);
    drafts.set(note.id, { text, base: latest });
    setFailure(null);
    setLookup(null);
  }

  function takeTheirs(latest: ClientNoteDto) {
    setBase(latest);
    setText(latest.content);
    forget();
    setFailure(null);
    setLookup(null);
  }

  const gone = lookup?.status === "gone";
  const unchanged = noteContent(text) === base.content;

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4 pt-1"
    >
      <TextAreaField
        label="Note"
        value={text}
        readOnly={state !== "idle"}
        onChange={(event) => edit(event.target.value)}
        error={fieldError}
        counterMax={MAX_NOTE_LENGTH}
        data-autofocus=""
        rows={6}
      />

      {gone ? (
        <Notice
          tone="warning"
          title="Note supprimée entre-temps"
          action={
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <button
                type="button"
                onClick={() => {
                  forget();
                  onSaveAsNew(text);
                }}
                className={linkAction}
              >
                L’enregistrer comme nouvelle note
              </button>
              <button
                type="button"
                onClick={() => {
                  forget();
                  onClose();
                }}
                className={linkAction}
              >
                Abandonner ce texte
              </button>
            </div>
          }
        >
          Cette note n’existe plus. Ton texte est conservé : rien n’a été
          enregistré.
        </Notice>
      ) : failure?.code === "stale_note" ? (
        <StaleNote
          lookup={lookup}
          onCompare={compare}
          onKeepMine={keepMine}
          onTakeTheirs={takeTheirs}
        />
      ) : failure ? (
        <WriteFailure
          error={failure}
          subject="update"
          onRetry={() => void save()}
        />
      ) : null}

      {gone ? null : (
        <div className="sticky -bottom-6 -mx-5 -mb-6 flex flex-col-reverse gap-2 border-t border-line bg-paper-raised px-5 pt-3 pb-[max(env(safe-area-inset-bottom),1.25rem)] sm:-mx-6 sm:flex-row sm:justify-end sm:px-6">
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
            disabled={state !== "idle"}
          >
            {unchanged ? "Annuler" : "Garder pour plus tard"}
          </Button>
          <Button
            type="submit"
            size="md"
            state={state}
            loadingLabel="Enregistrement…"
            // Wide enough for "Enregistrement…" while saving.
            className="sm:min-w-36"
            disabled={failure?.code === "stale_note"}
          >
            Enregistrer
          </Button>
        </div>
      )}
    </form>
  );
}

function StaleNote({
  lookup,
  onCompare,
  onKeepMine,
  onTakeTheirs,
}: {
  lookup: Lookup | null;
  onCompare: () => void;
  onKeepMine: (latest: ClientNoteDto) => void;
  onTakeTheirs: (latest: ClientNoteDto) => void;
}) {
  if (lookup?.status === "found") {
    const latest = lookup.note;
    return (
      <Notice tone="warning" title="Version actuelle de la note">
        {latest.edited ? (
          <p className="text-[13px]">{editedLabel(latest)}</p>
        ) : null}
        <div className="mt-1.5 rounded-xl bg-paper-raised/70 px-3 py-2">
          <NoteText content={latest.content} />
        </div>
        <p className="mt-2">
          Ton texte, au-dessus, n’a pas été enregistré. Choisis lequel garder.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <button
            type="button"
            onClick={() => onKeepMine(latest)}
            className={linkAction}
          >
            Garder mon texte
          </button>
          <button
            type="button"
            onClick={() => onTakeTheirs(latest)}
            className={linkAction}
          >
            Reprendre la version actuelle
          </button>
        </div>
      </Notice>
    );
  }
  return (
    <Notice
      tone="warning"
      title="Note modifiée ailleurs"
      action={
        lookup?.status === "loading" ? (
          <span className="text-[14px]">
            Chargement de la version actuelle…
          </span>
        ) : (
          <button type="button" onClick={onCompare} className={linkAction}>
            Voir la version actuelle
          </button>
        )
      }
    >
      {lookup?.status === "error"
        ? "La version actuelle n’a pas pu être chargée. Ton texte est conservé : réessaie."
        : lookup?.status === "unknown"
          ? "La version actuelle n’a pas été retrouvée parmi les dernières notes. Ton texte est conservé."
          : "Cette note a changé depuis que tu l’as ouverte. Rien n’a été enregistré et ton texte est conservé : compare-le à la version actuelle avant de choisir."}
    </Notice>
  );
}

function WriteFailure({
  error,
  subject,
  onRetry,
  onSendAsNew,
  onDiscard,
}: {
  error: UiError;
  subject: "create" | "update" | "delete";
  onRetry: () => void;
  onSendAsNew?: () => void;
  onDiscard?: () => void;
}) {
  const choices =
    onSendAsNew && onDiscard ? (
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <button type="button" onClick={onSendAsNew} className={linkAction}>
          L’enregistrer comme nouvelle note
        </button>
        <button type="button" onClick={onDiscard} className={linkAction}>
          Abandonner ce texte
        </button>
      </div>
    ) : undefined;
  switch (error.code) {
    case "network":
      return (
        <Notice
          tone="offline"
          title="Connexion interrompue"
          action={
            <button type="button" onClick={onRetry} className={linkAction}>
              Réessayer
            </button>
          }
        >
          {subject === "create"
            ? "La note a peut-être été enregistrée. Réessaie sans changer le texte : elle ne sera pas ajoutée deux fois."
            : subject === "update"
              ? "La modification a peut-être été enregistrée. Réessaie : le même texte n’est jamais enregistré deux fois."
              : "La note a peut-être été supprimée. Réessaie : supprimer deux fois ne change rien."}
        </Notice>
      );
    case "note_deleted":
      return (
        <Notice
          tone="warning"
          title="Note déjà enregistrée, puis supprimée"
          action={choices}
        >
          Ce texte avait déjà été enregistré par ce formulaire, et la note a été
          supprimée depuis. Elle n’a pas été recréée.
        </Notice>
      );
    case "idempotency_conflict":
      return (
        <Notice tone="warning" title="Rien n’a été enregistré" action={choices}>
          Ce formulaire a déjà servi à enregistrer une autre note. Vérifie
          l’historique avant d’enregistrer ce texte.
        </Notice>
      );
    case "client_not_found":
      return (
        <CrmError error={error}>
          Cette fiche n’existe plus : la note n’a pas été enregistrée.
        </CrmError>
      );
    default:
      return (
        <CrmError error={error} onRetry={onRetry}>
          {error.code === "unauthenticated"
            ? undefined
            : subject === "delete"
              ? "La note n’a pas pu être supprimée."
              : "La note n’a pas pu être enregistrée. Ton texte est conservé."}
        </CrmError>
      );
  }
}

// ---------------------------------------------------------------------------
// Deleting a note
// ---------------------------------------------------------------------------

/**
 * Deletes a note after confirmation, on the version it was read at. A note
 * already deleted is a success (nothing left to delete); a note changed
 * since it was read is not deleted.
 */
export function DeleteNoteDialog({
  clientId,
  note,
  onClose,
  onChanged,
}: {
  clientId: string;
  note: ClientNoteDto | null;
  onClose: () => void;
  onChanged: (change: NoteChange) => void;
}) {
  const [state, setState] = useState<ButtonState>("idle");
  const [failure, setFailure] = useState<UiError | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function close() {
    setFailure(null);
    onClose();
  }

  async function confirm() {
    if (!note || state !== "idle") return;
    if (failure?.code === "stale_note") {
      close();
      return;
    }
    setFailure(null);
    setState("loading");
    const result = await callAction(() =>
      deleteClientNoteAction({
        clientId,
        noteId: note.id,
        expectedVersion: note.version,
      }),
    );
    if (!alive.current) return;
    setState("idle");
    if (result.ok || result.error.code === "note_not_found") {
      onChanged({ type: "deleted", noteId: note.id });
      close();
      return;
    }
    if (result.error.code === "stale_note") onChanged({ type: "stale" });
    setFailure(result.error);
  }

  const stale = failure?.code === "stale_note";
  return (
    <ConfirmDialog
      open={note !== null}
      title={stale ? "Note modifiée entre-temps" : "Supprimer cette note ?"}
      description={
        stale
          ? undefined
          : "Elle disparaîtra de la fiche et de l’historique. C’est définitif."
      }
      confirmLabel={stale ? "Compris" : "Supprimer"}
      cancelLabel="Retour"
      tone={stale ? "default" : "danger"}
      state={state}
      onConfirm={() => void confirm()}
      onCancel={close}
    >
      {stale ? (
        <p className="text-[14.5px] text-ink-soft">
          Cette note a changé depuis que tu l’as lue : rien n’a été supprimé.
          Relis-la avant de décider.
        </p>
      ) : failure ? (
        <WriteFailure
          error={failure}
          subject="delete"
          onRetry={() => void confirm()}
        />
      ) : note ? (
        <div className="rounded-2xl bg-sand/50 px-4 py-3">
          <NoteText content={note.content} />
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
