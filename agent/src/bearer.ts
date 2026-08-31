/**
 * Constant-time compare, so a wrong bearer cannot be discovered a byte at a time.
 *
 * `crypto.subtle.timingSafeEqual` needs equal lengths, and comparing lengths first leaks only
 * the length — which a token's own format already tells an attacker.
 *
 * Its own module because two entry points need it: the `/mcp` header check and the OAuth
 * consent screen, which gates on the same secret. One implementation, so a fix to either
 * reaches both.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
