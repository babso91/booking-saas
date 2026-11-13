import type {
  FieldDefinitionDto,
  ProductDto,
  SaveDraftInput,
  TechnicalNoteDto,
} from "./contract";

// A visit's sheet while she writes it: text as typed, by field id. Nothing
// is decided here: what a sheet may hold (`allowedFields`) and what is
// saved are the server's.

export type SheetDraft = {
  /** By field id; a field left empty is not part of the sheet. */
  values: Record<string, string>;
  products: ProductDto[];
};

export const emptyProduct = (): ProductDto => ({
  name: "",
  quantity: "",
  unit: "",
});

/** The draft of a saved sheet, limited to the fields still allowed. */
export function draftOf(
  note: TechnicalNoteDto | null,
  allowed: FieldDefinitionDto[],
): SheetDraft {
  const ids = new Set(allowed.map((field) => field.id));
  return {
    values: Object.fromEntries(
      (note?.fieldValues ?? [])
        .filter((value) => ids.has(value.fieldId))
        .map((value) => [value.fieldId, value.value]),
    ),
    products: (note?.products ?? []).map((product) => ({ ...product })),
  };
}

/**
 * Starts a sheet from an earlier one: its values for the fields still
 * allowed, and the labels of those that are not (said to her, never
 * copied). Taking them over is her decision, visit by visit.
 */
export function copyFrom(
  earlier: TechnicalNoteDto,
  allowed: FieldDefinitionDto[],
): { draft: SheetDraft; removed: string[] } {
  const ids = new Set(allowed.map((field) => field.id));
  return {
    draft: draftOf(earlier, allowed),
    removed: earlier.fieldValues
      .filter((value) => !ids.has(value.fieldId))
      .map((value) => value.label),
  };
}

const cleanProducts = (products: ProductDto[]) =>
  products
    .map((product) => ({
      name: product.name.trim(),
      quantity: product.quantity.trim(),
      unit: product.unit.trim(),
    }))
    .filter((product) => product.name !== "");

/** What a draft says, without what is empty (to compare and to send). */
export function contentOf(draft: SheetDraft, allowed: FieldDefinitionDto[]) {
  return {
    fieldValues: allowed
      .map((field) => ({
        fieldId: field.id,
        value: (draft.values[field.id] ?? "").trim(),
      }))
      .filter((value) => value.value !== ""),
    products: cleanProducts(draft.products),
  };
}

export const sameContent = (
  a: SheetDraft,
  b: SheetDraft,
  allowed: FieldDefinitionDto[],
) =>
  JSON.stringify(contentOf(a, allowed)) ===
  JSON.stringify(contentOf(b, allowed));

export const isEmpty = (draft: SheetDraft, allowed: FieldDefinitionDto[]) => {
  const content = contentOf(draft, allowed);
  return content.fieldValues.length === 0 && content.products.length === 0;
};

/** Problems that stop a save, by field id (`product:<index>` for a product). */
export function checkSheet(
  draft: SheetDraft,
  allowed: FieldDefinitionDto[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of allowed) {
    const value = (draft.values[field.id] ?? "").trim();
    if (!value) continue;
    if (field.kind === "number" && !/^\d{1,6}([.,]\d{1,3})?$/.test(value))
      errors[field.id] = "Un nombre, par exemple 12 ou 0,15.";
    if (field.kind === "choice" && !field.choices.includes(value))
      errors[field.id] = "Cette réponse n’est plus proposée : choisis-en une.";
    if (value.length > 200) errors[field.id] = "200 caractères au plus.";
  }
  draft.products.forEach((product, index) => {
    const typed = product.quantity.trim() !== "" || product.unit.trim() !== "";
    if (typed && product.name.trim() === "")
      errors[`product:${index}`] = "Nomme ce produit, ou retire la ligne.";
  });
  return errors;
}

export function saveCommand(
  draft: SheetDraft,
  allowed: FieldDefinitionDto[],
  base: {
    requestId: string;
    appointmentId: string;
    expectedVersion: number;
    supersedesId?: string | null;
  },
): SaveDraftInput {
  return { ...base, ...contentOf(draft, allowed) };
}

export type Difference = {
  fieldId: string;
  label: string;
  mine: string;
  theirs: string;
};

/**
 * After a conflict: the fields where her text and the saved sheet differ.
 * Her text stays on screen; she takes the saved value field by field.
 */
export function differences(
  mine: SheetDraft,
  theirs: SheetDraft,
  allowed: FieldDefinitionDto[],
): Difference[] {
  return allowed
    .map((field) => ({
      fieldId: field.id,
      label: field.label,
      mine: (mine.values[field.id] ?? "").trim(),
      theirs: (theirs.values[field.id] ?? "").trim(),
    }))
    .filter((item) => item.mine !== item.theirs);
}
