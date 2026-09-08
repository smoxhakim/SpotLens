import { auth } from "./config";

export { handlers, auth, signIn, signOut } from "./config";
export { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from "./password";

/** The signed-in user's id, or null. Every user-scoped query starts here. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
