import { currentUserId } from "@/lib/auth";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";

import { apiError } from "./response";

export type GuardResult = { userId: string } | { response: ReturnType<typeof apiError> };

/**
 * Gate for user-scoped routes. Returns the caller's id, or a 401 response.
 *
 * Ownership is checked separately in each handler that reads a specific row —
 * being signed in is not the same as owning the thing you asked for.
 *
 * ## Why the session is checked against the database
 *
 * Sessions are JWTs, not database rows — Auth.js v5's Credentials provider
 * cannot use the database strategy, so nothing invalidates a cookie when the
 * account behind it disappears. A correctly signed token therefore outlives
 * the row it names, and `currentUserId()` happily returns an id for a user
 * that no longer exists.
 *
 * Every write with a foreign key to `User` then failed on the constraint
 * rather than on the session: `P2003` surfaced as a 500 and "Something went
 * wrong. Please try again." — advice that could never work, since retrying
 * cannot bring the user back. It was found when a rebuilt database left a
 * browser holding a valid token for a deleted account, and it was never
 * specific to one feature: Telegram's connect and the notification
 * preferences both failed the same way, and so would anything else that
 * writes a row owned by a user.
 *
 * So the check belongs here, once, rather than in each handler. A session
 * naming a user that is not there is not a database error; it is an expired
 * session, and 401 is what says so — the client redirects to sign in, and the
 * user recovers by signing in again.
 *
 * One indexed primary-key lookup per authenticated request, which is the
 * price of the guarantee. It is deliberately not cached: a cache would mean a
 * window in which a deleted account still passes, which is the exact
 * condition this exists to close.
 */
export async function requireUser(): Promise<GuardResult> {
  const userId = await currentUserId();
  if (!userId) {
    return { response: apiError("UNAUTHENTICATED", "You must be signed in to do that.", 401) };
  }

  // Nothing to check against. Routes that need a database answer 503 on their
  // own, and refusing here would turn "no database configured" into "signed
  // out", which is a different and wrong answer.
  if (!isDatabaseConfigured) return { userId };

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });

  if (!user) {
    return {
      response: apiError(
        "SESSION_INVALID",
        "Your session is no longer valid. Please sign in again.",
        401,
      ),
    };
  }

  return { userId };
}

export function isDenied(result: GuardResult): result is { response: ReturnType<typeof apiError> } {
  return "response" in result;
}
