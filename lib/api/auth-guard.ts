import { currentUserId } from "@/lib/auth";

import { apiError } from "./response";

export type GuardResult = { userId: string } | { response: ReturnType<typeof apiError> };

/**
 * Gate for user-scoped routes. Returns the caller's id, or a 401 response.
 *
 * Ownership is checked separately in each handler that reads a specific row —
 * being signed in is not the same as owning the thing you asked for.
 */
export async function requireUser(): Promise<GuardResult> {
  const userId = await currentUserId();
  if (!userId) {
    return { response: apiError("UNAUTHENTICATED", "You must be signed in to do that.", 401) };
  }
  return { userId };
}

export function isDenied(result: GuardResult): result is { response: ReturnType<typeof apiError> } {
  return "response" in result;
}
