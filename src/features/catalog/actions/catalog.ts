"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runBusinessAction } from "@/features/businesses/actions/run-business-action";
import {
  createCategory,
  deleteCategory,
  getCatalog,
  moveCategory,
  reorderCategories,
  setServiceOptions,
  updateCategory,
} from "@/features/catalog/data/catalog";
import {
  createCategorySchema,
  deleteCategorySchema,
  moveCategorySchema,
  reorderCategoriesSchema,
  setServiceOptionsSchema,
  updateCategorySchema,
} from "@/features/catalog/schemas";

// Her catalogue (docs/CATALOG_CONTRACT.md). The business is always the
// session's; RLS and the database functions check it again. Services
// themselves (create, edit, category, order, activation, deletion) keep
// their actions in src/features/services/actions/services.ts.

function revalidateCatalogPages() {
  revalidatePath("/app/services");
  revalidatePath("/b/[slug]", "page");
}

/** Categories, services (active or not) and their options. */
export async function getCatalogAction() {
  return runBusinessAction(z.undefined(), undefined, ({ client, businessId }) =>
    getCatalog(client, businessId),
  );
}

/**
 * Creates a category (at the end). Idempotent by `requestId`: a retry
 * answers the category it created; `category_deleted` once deleted.
 */
export async function createCategoryAction(input: unknown) {
  const result = await runBusinessAction(
    createCategorySchema,
    input,
    ({ client, businessId }, data) => createCategory(client, businessId, data),
  );
  if (result.ok) revalidateCatalogPages();
  return result;
}

/** Renames, shows or hides, based on `expectedVersion` (`stale_category`). */
export async function updateCategoryAction(input: unknown) {
  const result = await runBusinessAction(
    updateCategorySchema,
    input,
    ({ client, businessId }, data) => updateCategory(client, businessId, data),
  );
  if (result.ok) revalidateCatalogPages();
  return result;
}

/**
 * One category a step up or down, applied to the order as it is now: what
 * her arrows do. Two tabs never erase each other's move.
 */
export async function moveCategoryAction(input: unknown) {
  const result = await runBusinessAction(
    moveCategorySchema,
    input,
    ({ client, businessId }, data) => moveCategory(client, businessId, data),
  );
  if (result.ok) revalidateCatalogPages();
  return result;
}

/** Exactly all her categories, in the new order. */
export async function reorderCategoriesAction(input: unknown) {
  const result = await runBusinessAction(
    reorderCategoriesSchema,
    input,
    ({ client, businessId }, data) =>
      reorderCategories(client, businessId, data.categoryIds),
  );
  if (result.ok) revalidateCatalogPages();
  return result;
}

/** Deletes a category; its services stay, without a category. */
export async function deleteCategoryAction(input: unknown) {
  const result = await runBusinessAction(
    deleteCategorySchema,
    input,
    ({ client, businessId }, data) =>
      deleteCategory(client, businessId, data.categoryId),
  );
  if (result.ok) revalidateCatalogPages();
  return result;
}

/** Replaces a service's options, based on `expectedVersion` (`stale_service`). */
export async function setServiceOptionsAction(input: unknown) {
  const result = await runBusinessAction(
    setServiceOptionsSchema,
    input,
    ({ client, businessId }, data) =>
      setServiceOptions(client, businessId, data),
  );
  if (result.ok) revalidateCatalogPages();
  return result;
}
