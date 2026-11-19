/** Vite's proxy and the server's dev 404 handler must share prefixes to avoid index.html responses or redirect loops. */
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/mcp",
  "/ide",
] as const;

/** Preserve origins for OAuth metadata validation and /ws cookie-session Origin/Host checks. */
export const DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES: ReadonlySet<string> = new Set([
  "/oauth",
  "/.well-known",
  "/mcp",
  "/ws",
  // The editor connects its WebSocket back to the host it was served from.
  "/ide",
]);

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
