import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export function pulseSiteUrl(serverUrl: string, siteContentUrl: string) {
  const url = new URL(serverUrl);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("Unsupported Tableau URL.");
  url.pathname = `/pulse/site/${encodeURIComponent(siteContentUrl)}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function pulseMetricUrl(
  serverUrl: string,
  siteContentUrl: string,
  metricId: string,
) {
  return `${pulseSiteUrl(serverUrl, siteContentUrl)}/metrics/${encodeURIComponent(metricId)}`;
}

export async function openTableauUrl(url: string) {
  if (!["https:", "http:"].includes(new URL(url).protocol))
    throw new Error("Unsupported Tableau URL.");
  if (isTauri()) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
