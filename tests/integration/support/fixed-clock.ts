import { db } from "./fixtures";

// Public availability and public booking at an explicit "now". The public
// RPCs (get_available_slots, create_public_booking) pass pg_catalog.now() to
// these very functions (asserted in public-booking-dst.test.ts): calling
// them with a fixed instant tests the same transaction, whatever the date
// of the run. A test that reads the real clock to offer a fixed past date
// breaks the day that date is reached.

/** Slots of `date` as private.available_slots offers them at `now`. */
export async function availableSlotsAt(
  businessId: string,
  serviceId: string,
  date: string,
  now: string,
) {
  const { rows } = await db.query<{ starts_at: Date }>(
    `select starts_at
     from private.available_slots($1, $2, $3::date, $4::timestamptz)`,
    [businessId, serviceId, date, now],
  );
  return rows.map((row) => row.starts_at.toISOString());
}

/** The public booking transaction at `now`; the booked appointment. */
export async function publicBookingAt(
  now: string,
  booking: {
    slug: string;
    serviceId: string;
    startsAt: string;
    firstName: string;
    email: string;
  },
) {
  const { rows } = await db.query<{ appointment_id: string; starts_at: Date }>(
    `select appointment_id, starts_at
     from private.create_public_booking_at($1::timestamptz, $2, $3::uuid,
       $4::timestamptz, $5, $6)`,
    [
      now,
      booking.slug,
      booking.serviceId,
      booking.startsAt,
      booking.firstName,
      booking.email,
    ],
  );
  return {
    appointmentId: rows[0]!.appointment_id,
    startsAt: rows[0]!.starts_at.toISOString(),
  };
}
