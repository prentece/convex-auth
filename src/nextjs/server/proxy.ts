import "server-only";

import { fetchAction } from "convex/nextjs";
import { NextRequest } from "next/server";
import { SignInAction } from "../../server/implementation/index.js";
import { getRequestCookies, getResponseCookies } from "./cookies.js";
import {
  isCorsRequest,
  jsonResponse,
  logVerbose,
  setAuthCookies,
} from "./utils.js";

export async function proxyAuthActionToConvex(
  request: NextRequest,
  options: { convexUrl?: string; verbose?: boolean },
) {
  const verbose = options?.verbose ?? false;
  if (request.method !== "POST") {
    return new Response("Invalid method", { status: 405 });
  }
  if (isCorsRequest(request)) {
    return new Response("Invalid origin", { status: 403 });
  }
  const { action, args } = await request.json();
  if (action !== "auth:signIn" && action !== "auth:signOut") {
    logVerbose(`Invalid action ${action}, returning 400`, verbose);
    return new Response("Invalid action", { status: 400 });
  }
  let token: string | undefined;
  if (action === "auth:signIn" && args.refreshToken !== undefined) {
    // The client has a dummy refreshToken, the real one is only
    // stored in cookies.
    const refreshToken = getRequestCookies().refreshToken;
    if (refreshToken === null) {
      console.error(
        "Convex Auth: Unexpected missing refreshToken cookie during client refresh",
      );
      return new Response(JSON.stringify({ tokens: null }));
    }
    args.refreshToken = refreshToken;
  } else {
    // Make sure the proxy is authenticated if the client is,
    // important for signOut and any other logic working
    // with existing sessions.
    token = getRequestCookies().token ?? undefined;
  }
  logVerbose(
    `Fetching action ${action} with args ${JSON.stringify(args)}`,
    verbose,
  );
  const untypedResult = await fetchAction(action, args, {
    url: options?.convexUrl,
    token,
  });

  if (action === "auth:signIn") {
    const result = untypedResult as SignInAction["_returnType"];
    if (result.redirect !== undefined) {
      const { redirect } = result;
      const response = jsonResponse({ redirect });
      getResponseCookies(response).verifier = result.verifier;
      logVerbose(`Redirecting to ${redirect}`, verbose);
      return response;
    } else if (result.tokens !== undefined) {
      // The server doesn't share the refresh token with the client
      // for added security - the client has to use the server
      // to refresh the access token via cookies.
      logVerbose(
        result.tokens === null
          ? `No tokens returned, clearing auth cookies`
          : `Setting auth cookies with returned tokens`,
        verbose,
      );
      const response = jsonResponse({
        tokens:
          result.tokens !== null
            ? { token: result.tokens.token, refreshToken: "dummy" }
            : null,
      });
      setAuthCookies(response, result.tokens);
      return response;
    }
    return jsonResponse(result);
  } else {
    logVerbose(`Clearing auth cookies`, verbose);
    const response = jsonResponse(null);
    setAuthCookies(response, null);
    return response;
  }
}

export function shouldProxyAuthAction(request: NextRequest, apiRoute: string) {
  // Handle both with and without trailing slash since this could be configured either way.
  // https://nextjs.org/docs/app/api-reference/next-config-js/trailingSlash
  const requestUrl = new URL(request.url);
  if (apiRoute.endsWith("/")) {
    return (
      requestUrl.pathname === apiRoute ||
      requestUrl.pathname === apiRoute.slice(0, -1)
    );
  } else {
    return (
      requestUrl.pathname === apiRoute || requestUrl.pathname === apiRoute + "/"
    );
  }
}
