import { MAX_NOTE_LENGTH } from "@/features/crm/schemas/client-management";

// Private notes as the screens type and show them. The backend stays the
// authority on content (NFC, trimmed, 1 to 5,000 characters): checking here
// only spares a round trip and words the message.

export { MAX_NOTE_LENGTH };

/** The content the backend will store for this text. */
export function noteContent(text: string) {
  return text.normalize("NFC").trim();
}

/** Message before sending; null when the backend may accept it. */
export function checkNote(text: string): string | null {
  const content = noteContent(text);
  if (!content) return "Écris quelques mots avant d’enregistrer.";
  if (content.length > MAX_NOTE_LENGTH) {
    return `Note limitée à ${MAX_NOTE_LENGTH.toLocaleString("fr-FR")} caractères : retire-en ${(content.length - MAX_NOTE_LENGTH).toLocaleString("fr-FR")}.`;
  }
  return null;
}

/** Long enough to be folded (the whole text stays in the page). */
export function isLongNote(content: string) {
  return content.length > 420 || content.split("\n").length > 6;
}
