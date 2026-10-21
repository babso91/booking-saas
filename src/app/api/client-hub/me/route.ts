import { getProfile } from "@/features/client-hub/data/client-hub";
import { withClientHubSession } from "@/features/client-hub/data/route";

// GET /api/client-hub/me → the signed-in customer and their businesses.
export async function GET(request: Request) {
  return withClientHubSession(request, (admin, token) =>
    getProfile(admin, token),
  );
}
