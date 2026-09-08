import bcrypt from "bcryptjs";

/** Cost factor. 12 is the current sensible default for interactive logins. */
const ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Password rules, kept deliberately simple: length does more for strength than
 * character-class rules, which mostly push people toward "Password1!".
 */
export const MIN_PASSWORD_LENGTH = 10;
