import type { Metadata } from "next";

import { requireReadyBusiness } from "@/features/auth/data/guards";
import { areaIdentityOf } from "@/features/dashboard/area-identity";
import { AppShell } from "@/features/agenda/components/app-shell";
import { BookingHorizonEditor } from "@/features/availability/components/booking-horizon-editor";
import { BookingNoticeEditor } from "@/features/availability/components/booking-notice-editor";
import { BusinessHoursEditor } from "@/features/availability/components/business-hours-editor";
import { ClosuresEditor } from "@/features/availability/components/closures-editor";
import { DateHoursEditor } from "@/features/availability/components/date-hours-editor";
import { CancellationPolicyEditor } from "@/features/booking-policy/components/cancellation-policy-editor";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { databaseException } from "@/lib/supabase/errors";

export const metadata: Metadata = {
  title: "Horaires",
};

export default async function BusinessHoursPage() {
  // Also checked here: the layout guard does not stop the page from being
  // rendered into the payload of its redirect response.
  const { user, business } = await requireReadyBusiness();
  const canEditSettings =
    business.role === "owner" || business.role === "admin";
  const settings = canEditSettings
    ? await (
        await createServerSupabaseClient()
      )
        .from("business_settings")
        .select(
          "cancellation_lead_minutes, minimum_booking_notice_minutes, maximum_booking_advance_days",
        )
        .eq("business_id", business.id)
        .single()
    : null;
  if (settings?.error) throw databaseException(settings.error);

  return (
    <AppShell
      identity={areaIdentityOf({ user, business })}
      business={{ name: business.name, slug: business.slug }}
      current="hours"
    >
      {/* The business's zone (from the session), never the browser's. */}
      <BusinessHoursEditor
        timezone={business.timezone}
        scope={{ userId: user.id, businessId: business.id }}
        scheduleOptions={
          settings?.data ? (
            <>
              <CancellationPolicyEditor
                businessId={business.id}
                leadMinutes={settings.data.cancellation_lead_minutes}
              />
              <DateHoursEditor businessId={business.id} />
              <ClosuresEditor businessId={business.id} />
              <BookingNoticeEditor
                businessId={business.id}
                initialMinutes={settings.data.minimum_booking_notice_minutes}
              />
              <BookingHorizonEditor
                businessId={business.id}
                initialDays={settings.data.maximum_booking_advance_days}
              />
            </>
          ) : null
        }
      />
    </AppShell>
  );
}
