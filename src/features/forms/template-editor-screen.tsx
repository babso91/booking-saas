"use client";

import Link from "next/link";

import { FormEditor } from "./editor/form-editor";
import { realFormEditorActions } from "./real-pro-actions";

/** One of her templates in the editor, on the real actions. */
export function TemplateEditorScreen({
  templateId,
  businessName,
}: {
  templateId: string;
  businessName: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6 lg:px-8 lg:pt-10">
        <Link
          href="/app/forms"
          className="w-fit text-[14px] font-medium text-ink-soft underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          ← Formulaires
        </Link>
        <FormEditor
          templateId={templateId}
          businessName={businessName}
          actions={realFormEditorActions}
        />
      </div>
    </div>
  );
}
