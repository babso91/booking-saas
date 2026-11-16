import { domainRoutingEnabled } from "@/features/domains-server/config";
import { routeForHost } from "@/features/domains-server/route-cache";

// GET /api/domains/probe — on a custom name, which domain it is (the
// verifier's proof that certificate and routing work). 404 elsewhere, and
// while routing by name is off.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!domainRoutingEnabled()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const host = request.headers.get("host") ?? "";
  const route = await routeForHost(host);
  if (!route) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ domainId: route.domainId });
}
