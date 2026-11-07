import "server-only";

import type {
  OptionSnapshot,
  PublicCatalog,
  ServiceOption,
} from "@/features/catalog/model";
import type {
  CreateCategoryInput,
  SetServiceOptionsInput,
  UpdateCategoryInput,
} from "@/features/catalog/schemas";
import type { ServiceDto } from "@/features/services/data/services";
import { AppException, appErrorMessages } from "@/lib/errors";
import { databaseException } from "@/lib/supabase/errors";
import type { AppSupabaseClient } from "@/lib/supabase/types";

// Her catalogue, for the dashboard and the studio. Read under RLS (members
// of the business only); every write goes through a database function that
// checks membership, takes the business schedule lock (bookings see the
// catalogue before or after a change, never half of it) and handles
// retries and concurrent edits.

export type CategoryDto = {
  id: string;
  name: string;
  /** On her public pages; services of a hidden category are not bookable online. */
  visible: boolean;
  displayOrder: number;
  /** Pass it back as `expectedVersion` to edit this category. */
  version: number;
};

export type CatalogServiceDto = ServiceDto & { options: ServiceOption[] };

export type CatalogDto = {
  /** In her order. */
  categories: CategoryDto[];
  /** In her order (displayOrder); `categoryId` null: without a category. */
  services: CatalogServiceDto[];
};

const CATEGORY_COLUMNS = "id, name, visible, display_order, version";

type CategoryRow = {
  id: string;
  name: string;
  visible: boolean;
  display_order: number;
  version: number;
};

function toCategoryDto(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    name: row.name,
    visible: row.visible,
    displayOrder: row.display_order,
    version: row.version,
  };
}

type CatalogDocument = {
  categories: CategoryDto[];
  services: (Omit<CatalogServiceDto, "options"> & {
    options: ServiceOption[];
  })[];
};

/**
 * Her catalogue, or one service of it, as one document read in one
 * snapshot (public.get_catalog). One row whatever its size: the API's row
 * cap (PostgREST max_rows) can never truncate it. An editor still never
 * deletes by omission (setServiceOptions): what it did not receive is
 * refused, not removed.
 */
async function readCatalog(
  client: AppSupabaseClient,
  businessId: string,
  serviceId?: string,
): Promise<CatalogDocument> {
  const { data, error } = await client.rpc("get_catalog", {
    p_business_id: businessId,
    p_service_id: serviceId,
  });
  if (error) throw databaseException(error);
  return data as CatalogDocument;
}

/** Her categories, in her order. */
export async function listCategories(
  client: AppSupabaseClient,
  businessId: string,
): Promise<CategoryDto[]> {
  return (await readCatalog(client, businessId)).categories;
}

/**
 * Her whole catalogue: categories, services (active or not) and options,
 * complete and from one snapshot. Each service's `version` (which changes
 * with its options) is what an edit is checked against.
 */
export async function getCatalog(
  client: AppSupabaseClient,
  businessId: string,
): Promise<CatalogDto> {
  return readCatalog(client, businessId);
}

export async function getCatalogService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
): Promise<CatalogServiceDto> {
  const [service] = (await readCatalog(client, businessId, serviceId)).services;
  if (!service) throw new AppException("not_found");
  return service;
}

async function getCategory(
  client: AppSupabaseClient,
  businessId: string,
  categoryId: string,
): Promise<CategoryDto> {
  const { data, error } = await client
    .from("service_categories")
    .select(CATEGORY_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", categoryId)
    .maybeSingle();
  if (error) throw databaseException(error);
  if (!data) throw new AppException("category_not_found");
  return toCategoryDto(data);
}

/**
 * Creates a category at the end of her list, once per `requestId`: a retry
 * answers the category it created, `category_deleted` once it was deleted,
 * `idempotency_conflict` for another command.
 */
export async function createCategory(
  client: AppSupabaseClient,
  businessId: string,
  input: CreateCategoryInput,
): Promise<CategoryDto> {
  const { data, error } = await client
    .rpc("create_service_category", {
      p_business_id: businessId,
      p_request_id: input.requestId,
      p_name: input.name,
      p_visible: input.visible,
    })
    .single();
  if (error) throw databaseException(error);
  if (data.status === "deleted" || !data.category_id) {
    throw new AppException("category_deleted", {
      fieldErrors: { requestId: [appErrorMessages.category_deleted] },
    });
  }
  return getCategory(client, businessId, data.category_id);
}

/**
 * Renames and/or shows or hides, if the category is still at
 * `expectedVersion` (`stale_category` otherwise; a retry finding these
 * values already answers the category as it is).
 */
export async function updateCategory(
  client: AppSupabaseClient,
  businessId: string,
  input: UpdateCategoryInput,
): Promise<CategoryDto> {
  const { data, error } = await client
    .rpc("update_service_category", {
      p_business_id: businessId,
      p_category_id: input.categoryId,
      p_expected_version: input.expectedVersion,
      p_name: input.name,
      p_visible: input.visible,
    })
    .single();
  if (error) throw databaseException(error);
  return toCategoryDto(data);
}

/** Exactly all her categories, in the new order. */
export async function reorderCategories(
  client: AppSupabaseClient,
  businessId: string,
  categoryIds: string[],
): Promise<CategoryDto[]> {
  const { error } = await client.rpc("reorder_service_categories", {
    p_business_id: businessId,
    p_category_ids: categoryIds,
  });
  if (error) throw databaseException(error);
  return listCategories(client, businessId);
}

/**
 * Moves one category a step up or down from where it is now (applied to
 * the current order, under the schedule lock): a move made in another tab
 * meanwhile is kept, never replaced. Answers her categories as they are.
 */
export async function moveCategory(
  client: AppSupabaseClient,
  businessId: string,
  input: { categoryId: string; offset: -1 | 1 },
): Promise<CategoryDto[]> {
  const { error } = await client.rpc("move_service_category", {
    p_business_id: businessId,
    p_category_id: input.categoryId,
    p_offset: input.offset,
  });
  if (error) throw databaseException(error);
  return listCategories(client, businessId);
}

/** Deletes a category; its services stay, without a category. */
export async function deleteCategory(
  client: AppSupabaseClient,
  businessId: string,
  categoryId: string,
): Promise<void> {
  const { error } = await client.rpc("delete_service_category", {
    p_business_id: businessId,
    p_category_id: categoryId,
  });
  if (error) throw databaseException(error);
}

/**
 * Replaces the options of a service, as a whole, if it is still at
 * `expectedVersion` (`stale_service` otherwise). Nothing is deleted by
 * omission: a group or answer left out must be in `deletedOptionIds` /
 * `deletedChoiceIds`, or the save is refused (`options_incomplete`).
 * Answers the service with its new options and version.
 */
export async function setServiceOptions(
  client: AppSupabaseClient,
  businessId: string,
  input: SetServiceOptionsInput,
): Promise<CatalogServiceDto> {
  const { error } = await client.rpc("set_service_options", {
    p_business_id: businessId,
    p_service_id: input.serviceId,
    p_expected_version: input.expectedVersion,
    p_options: input.options.map((option) => ({
      id: option.id ?? null,
      question: option.question,
      required: option.required,
      choices: option.choices.map((choice) => ({
        id: choice.id ?? null,
        label: choice.label,
        priceDeltaCents: choice.priceDeltaCents,
        durationDeltaMinutes: choice.durationDeltaMinutes,
      })),
    })),
    p_deleted_option_ids: input.deletedOptionIds ?? [],
    p_deleted_choice_ids: input.deletedChoiceIds ?? [],
  });
  if (error) throw databaseException(error);
  return getCatalogService(client, businessId, input.serviceId);
}

// --- Public ------------------------------------------------------------------

/** The catalogue bookable online, as the mini-site shows it; null: no business. */
export async function getPublicCatalog(
  client: AppSupabaseClient,
  slug: string,
): Promise<PublicCatalog | null> {
  const { data, error } = await client.rpc("get_public_catalog", {
    p_slug: slug,
  });
  if (error) throw databaseException(error);
  return (data as PublicCatalog | null) ?? null;
}

export type PublicQuote = {
  serviceName: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  options: OptionSnapshot[];
};

/** What the server books for these answers (price and duration). */
export async function quotePublicService(
  client: AppSupabaseClient,
  slug: string,
  serviceId: string,
  optionChoiceIds: string[],
): Promise<PublicQuote> {
  const { data, error } = await client
    .rpc("quote_public_service", {
      p_slug: slug,
      p_service_id: serviceId,
      p_option_choice_ids: optionChoiceIds,
    })
    .single();
  if (error) throw databaseException(error);
  return {
    serviceName: data.service_name,
    durationMinutes: data.duration_minutes,
    priceCents: data.price_cents,
    currency: data.currency,
    options: data.options as OptionSnapshot[],
  };
}

export type PublicAvailability = {
  quote: PublicQuote;
  /** For exactly `quote.durationMinutes`: same read of the catalogue. */
  slots: {
    startsAt: string;
    endsAt: string;
    localStartsAt: string;
    localEndsAt: string;
  }[];
};

/**
 * Slots and the quote they are for, from one read of the catalogue
 * (public.get_public_availability): they always agree. The booking
 * re-validates both under the schedule lock.
 */
export async function getPublicAvailability(
  client: AppSupabaseClient,
  query: {
    slug: string;
    serviceId: string;
    date: string;
    optionChoiceIds?: string[];
  },
): Promise<PublicAvailability> {
  const { data, error } = await client.rpc("get_public_availability", {
    p_slug: query.slug,
    p_service_id: query.serviceId,
    p_date: query.date,
    p_option_choice_ids: query.optionChoiceIds ?? [],
  });
  if (error) throw databaseException(error);
  const answer = data as PublicAvailability;
  return {
    quote: answer.quote,
    slots: answer.slots.map((slot) => ({
      startsAt: new Date(slot.startsAt).toISOString(),
      endsAt: new Date(slot.endsAt).toISOString(),
      localStartsAt: slot.localStartsAt,
      localEndsAt: slot.localEndsAt,
    })),
  };
}
