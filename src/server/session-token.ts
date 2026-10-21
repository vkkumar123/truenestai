import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Signed, stateless session token for the DEV-ONLY fixture admin login.
 * Format: "v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, 'v1.' + payload))>".
 */

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const VERSION = "v1";

const payloadSchema = z.object({
  sub: z.string().min(1).max(100),
  role: z.enum(["advisor", "admin"]),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type SessionPayload = z.infer<typeof payloadSchema>;

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signSessionToken(
  claims: { sub: string; role: SessionPayload["role"] },
  secret: string,
  now: Date = new Date(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): { token: string; payload: SessionPayload } {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: SessionPayload = { sub: claims.sub, role: claims.role, iat, exp: iat + ttlSeconds };
  const body = `${VERSION}.${b64url(JSON.stringify(payload))}`;
  return { token: `${body}.${b64url(hmac(secret, body))}`, payload };
}

/** Returns the payload only if the signature is valid and the token is unexpired. Never throws. */
export function verifySessionToken(token: string | undefined | null, secret: string, now: Date = new Date()): SessionPayload | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const body = `${parts[0]}.${parts[1]}`;
  // Require canonical base64url (Node's decoder ignores non-zero trailing bits).
  const given = Buffer.from(parts[2], "base64url");
  if (b64url(given) !== parts[2]) return null;
  const expected = hmac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const nowS = Math.floor(now.getTime() / 1000);
  const p = parsed.data;
  if (p.exp <= nowS) return null;
  if (p.iat > nowS + 60) return null; // issued in the future
  if (p.exp - p.iat > SESSION_TTL_SECONDS) return null;
  return p;
}

/** Constant-time string comparison (hashes first so lengths never leak through timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
