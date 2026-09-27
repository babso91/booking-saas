import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.generated";

export type AppSupabaseClient = SupabaseClient<Database>;
