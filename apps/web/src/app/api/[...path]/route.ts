import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
const SESSION_COOKIE_NAME = "optio_session";

/**
 * BFF (Backend for Frontend) proxy route.
 *
 * All client-side `/api/*` requests are routed here. The handler:
 * 1. Reads the HttpOnly session cookie (invisible to client-side JS)
 * 2. Forwards the request to the real API with an Authorization header
 * 3. Returns the API response transparently
 *
 * This keeps the session token out of client-side JavaScript entirely,
 * eliminating XSS-based session hijacking.
 */
async function proxyRequest(request: NextRequest) {
  const url = new URL(request.url);
  const targetUrl = `${INTERNAL_API_URL}${url.pathname}${url.search}`;

  const headers = new Headers();

  // Forward safe request headers
  const forwardHeaders = ["content-type", "accept", "x-workspace-id"];
  for (const name of forwardHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Inject session token as Bearer header (from HttpOnly cookie)
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (sessionToken) {
    headers.set("Authorization", `Bearer ${sessionToken}`);
  }

  try {
    const fetchInit: RequestInit = {
      method: request.method,
      headers,
    };

    // Forward request body for non-GET/HEAD methods
    if (request.method !== "GET" && request.method !== "HEAD") {
      fetchInit.body = request.body;
      // @ts-expect-error duplex is required for streaming request bodies in Node
      fetchInit.duplex = "half";
    }

    const apiRes = await fetch(targetUrl, fetchInit);

    // Build a clean response — don't forward Set-Cookie or other sensitive
    // headers from the API that could conflict with the web origin.
    const responseHeaders = new Headers();
    const safeResponseHeaders = ["content-type", "content-length", "cache-control", "etag"];
    for (const name of safeResponseHeaders) {
      const value = apiRes.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }

    return new NextResponse(apiRes.body, {
      status: apiRes.status,
      statusText: apiRes.statusText,
      headers: responseHeaders,
    });
  } catch {
    return NextResponse.json({ error: "API proxy error" }, { status: 502 });
  }
}

export const GET = proxyRequest;
export const POST = proxyRequest;
export const PUT = proxyRequest;
export const PATCH = proxyRequest;
export const DELETE = proxyRequest;
