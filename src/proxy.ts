import { type NextRequest, NextResponse } from "next/server";
import { authorizeHostRequest } from "@/lib/security/host-guard";

/**
 * DNS-rebinding guard for the API surface (issue #382). Applies
 * {@link authorizeHostRequest} to every `/api/*` request before it reaches a
 * route handler, so a new GET route is covered the moment it's added under
 * `/api` — no per-route opt-in to forget. Only GET/HEAD are gated: every
 * mutating route already authenticates itself (webhook signature, control
 * token, CSRF guard header — see `src/lib/orchestrator/control.ts` and
 * `src/app/api/webhooks/[repoId]/route.ts`), and some of those (the webhook
 * receiver) are deliberately called from outside the operator's browser, so a
 * same-origin Host/Origin check would break them.
 *
 * Named `proxy` (not `middleware`) per Next.js's file-convention rename —
 * `middleware.ts` still works but is deprecated as of Next 16.
 */
export function proxy(request: NextRequest): NextResponse {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return NextResponse.next();
  }

  const decision = authorizeHostRequest(request);
  if (!decision.authorized) {
    return new NextResponse("Forbidden: untrusted Host/Origin (issue #382 DNS-rebinding guard)", {
      status: decision.status,
      headers: { "cache-control": "no-store" },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
