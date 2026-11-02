import type { PulseDiagnostic } from "@pulse-metric-studio/shared";

/** Provider details are normalized and sanitized by the backend. */
export function TableauDiagnosticDetails({ diagnostic }: { diagnostic?: PulseDiagnostic | null }) {
  if (!diagnostic?.detail && !diagnostic?.providerCode) return null;
  return <details className="pulse-command-diagnostic">
    <summary>Tableau details</summary>
    {diagnostic.providerCode && <p>Provider code: {diagnostic.providerCode}</p>}
    {diagnostic.detail && <pre>{diagnostic.detail}</pre>}
  </details>;
}
