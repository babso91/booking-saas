"use client";

import type { ReactNode } from "react";

import { Button, type ButtonState } from "./button";
import { Sheet } from "./sheet";

/** Confirmation of a heavy or destructive action, on top of any panel. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Retour",
  tone = "default",
  state = "idle",
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  state?: ButtonState;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onClose={() => (state === "idle" ? onCancel() : undefined)}
      title={title}
      description={description}
      placement="center"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={onCancel}
            disabled={state !== "idle"}
            data-autofocus=""
          >
            {cancelLabel}
          </Button>
          <Button
            size="md"
            state={state}
            loadingLabel="Un instant…"
            onClick={onConfirm}
            variant={tone === "danger" ? "danger" : "primary"}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      {children}
    </Sheet>
  );
}
