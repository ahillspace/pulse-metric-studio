export function isAllowedAppOrigin(
  origin: string | undefined,
  configuredOrigins: readonly string[],
  serverOrigin?: string,
): boolean {
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;
  if (serverOrigin && origin === serverOrigin) return true;
  return false;
}
