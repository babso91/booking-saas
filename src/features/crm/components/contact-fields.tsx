"use client";

import type { Ref } from "react";

import { TextField } from "@/components/ui/field";

import {
  contactLabels,
  type ContactDraft,
  type ContactField,
} from "../client/contact-form";

/**
 * A customer's identity and contact, as the creation and edit forms ask
 * for them: only the first name is required. `readOnly` while a save is
 * pending: what is being sent stays visible and focusable, but unchanged.
 */
export function ContactFields({
  value,
  onChange,
  errors,
  disabled,
  readOnly,
  firstRef,
}: {
  value: ContactDraft;
  onChange: (field: ContactField, value: string) => void;
  errors: Partial<Record<ContactField, string>>;
  disabled?: boolean;
  readOnly?: boolean;
  firstRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          ref={firstRef}
          label={contactLabels.firstName}
          value={value.firstName}
          onChange={(event) => onChange("firstName", event.target.value)}
          error={errors.firstName}
          autoComplete="off"
          autoCapitalize="words"
          maxLength={120}
          disabled={disabled}
          readOnly={readOnly}
          data-autofocus=""
        />
        <TextField
          label={contactLabels.lastName}
          optional
          value={value.lastName}
          onChange={(event) => onChange("lastName", event.target.value)}
          error={errors.lastName}
          autoComplete="off"
          autoCapitalize="words"
          maxLength={120}
          disabled={disabled}
          readOnly={readOnly}
        />
      </div>
      <TextField
        label={contactLabels.email}
        optional
        type="email"
        inputMode="email"
        value={value.email}
        onChange={(event) => onChange("email", event.target.value)}
        error={errors.email}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
        disabled={disabled}
        readOnly={readOnly}
      />
      <TextField
        label={contactLabels.phone}
        optional
        type="tel"
        inputMode="tel"
        value={value.phone}
        onChange={(event) => onChange("phone", event.target.value)}
        error={errors.phone}
        autoComplete="off"
        maxLength={30}
        disabled={disabled}
        readOnly={readOnly}
      />
    </div>
  );
}
