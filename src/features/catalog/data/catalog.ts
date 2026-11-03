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
import {
  getService,
  listServices,
  type ServiceDto,
} from "@/features/services/data/services";
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

export async function listCategories(
  client: AppSupabaseClient,
  businessId: string,
): Promise<CategoryDto[]> {
  const { data, error } = await client
    .from("service_categories")
    .select(CATEGORY_COLUMNS)
    .eq("business_id", businessId)
    .order("display_order")
    .order("name")
    .order("id");
  if (error) throw databaseException(error);
  return data.map(toCategoryDto);
}

/** The options of these services, by service id, in her order. */
async function optionsOf(
  client: AppSupabaseClient,
  businessId: string,
  serviceIds: string[],
): Promise<Map<string, ServiceOption[]>> {
  const byService = new Map<string, ServiceOption[]>();
  if (serviceIds.length === 0) return byService;

  const { data: options, error } = await client
    .from("service_options")
    .select("id, service_id, question, required, display_order")
    .eq("business_id", businessId)
    .in("service_id", serviceIds)
    .order("display_order")
    .order("id");
  if (error) throw databaseException(error);

  const optionIds = options.map((option) => option.id);
  const { data: choices, error: choicesError } = optionIds.length
    ? await client
        .from("service_option_choices")
        .select(
          "id, option_id, label, price_delta_cents, duration_delta_minutes, display_order",
        )
        .eq("business_id", businessId)
        .in("option_id", optionIds)
        .order("display_order")
        .order("id")
    : { data: [], error: null };
  if (choicesError) throw databaseException(choicesError);

  const byOption = new Map<string, ServiceOption>();
  for (const option of options) {
    const entry: ServiceOption = {
      id: option.id,
      question: option.question,
      required: option.required,
      choices: [],
    };
    byOption.set(option.id, entry);
    const list = byService.get(option.service_id) ?? [];
    list.push(entry);
    byService.set(option.service_id, list);
  }
  for (const choice of choices) {
    byOption.get(choice.option_id)?.choices.push({
      id: choice.id,
      label: choice.label,
      priceDeltaCents: choice.price_delta_cents,
      durationDeltaMinutes: choice.duration_delta_minutes,
    });
  }
  return byService;
}

/**
 * Her whole catalogue: categories, services (active or not) and options.
 * Not one snapshot: a write between the reads is possible; each service's
 * `version` (which changes with its options) is what an edit is checked
 * against.
 */
export async function getCatalog(
  client: AppSupabaseClient,
  businessId: string,
): Promise<CatalogDto> {
  const [categories, services] = await Promise.all([
    listCategories(client, businessId),
    listServices(client, businessId),
  ]);
  const options = await optionsOf(
    client,
    businessId,
    services.map((service) => service.id),
  );
  return {
    categories,
    services: services.map((service) => ({
      ...service,
      options: options.get(service.id) ?? [],
    })),
  };
}

export async function getCatalogService(
  client: AppSupabaseClient,
  businessId: string,
  serviceId: string,
): Promise<CatalogServiceDto> {
  const service = await getService(client, businessId, serviceId);
  const options = await optionsOf(client, businessId, [serviceId]);
  return { ...service, options: options.get(serviceId) ?? [] };
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
 * `expectedVersion` (`stale_service` otherwise). Answers the service with
 * its new options and version.
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
