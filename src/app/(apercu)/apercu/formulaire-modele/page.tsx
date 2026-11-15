import { EditorPreview } from "@/features/forms/editor/editor-preview";

export const metadata = { title: "Modèle de formulaire · Aperçu" };

// Her form template editor on fictional data, against an in-memory server
// of the PROPOSED contract (docs/CLIENT_FORMS_PROPOSAL.md, "Éditeur").
// Like every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function FormEditorPreviewPage() {
  return <EditorPreview />;
}
