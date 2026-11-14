import { LocationsPreview } from "@/features/locations/locations-preview";

export const metadata = { title: "Lieux et praticiennes · Aperçu" };

// Booking across places and people on fictional data, against an in-memory
// server of the PROPOSED contract (docs/LOCATIONS_BOOKING_PROPOSAL.md). No
// booking is ever made. Like every preview, a 404 in production unless
// DASHBOARD_PREVIEW=1.
export default function LocationsPreviewPage() {
  return <LocationsPreview />;
}
