import { createHash, timingSafeEqual } from "node:crypto";

export function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function secureEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
