import { TicketPreview } from "@/features/public-booking/components/ticket-preview";

export const metadata = { title: "Confirmation en ticket · Aperçu" };

// Every state of the booking confirmation (confirmed, replayed, changed,
// time no longer known) on fictional data: ?cas=confirme|rejoue|change|deplace.
// Like every preview, a 404 in production unless DASHBOARD_PREVIEW=1.
export default function TicketPreviewPage() {
  return <TicketPreview />;
}
