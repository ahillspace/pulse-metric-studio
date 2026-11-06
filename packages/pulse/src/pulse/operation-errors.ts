import { TableauError, TableauMutationStoppedError, sanitizeProviderMessage, tableauProviderErrorInfo } from '@pulse-metric-studio/core';
import type { DatasourceCatalog, PulseDiagnostic } from '@pulse-metric-studio/shared';
import { boundedProviderDiagnostic } from './provider-diagnostics.js';

export type PulseOperation = 'publish' | 'delete' | 'follow' | 'unfollow' | 'fork' | 'group' | 'membership' | 'group-delete' | 'visibility' | 'dimension-fields';
const labels: Record<PulseOperation, string> = {
  publish: 'Publish this metric', delete: 'Delete this resource', follow: 'Follow this metric', unfollow: 'Unfollow this metric',
  fork: 'Create this variant', group: 'Set up the digest group', membership: 'Add the publishing account to the digest group',
  'group-delete': 'Delete this digest group', visibility: 'Confirm this metric in Tableau',
  'dimension-fields': 'Load fields for this variant',
};

/** Explicit user operations opt in; background catalog and inventory reads keep their existing behavior. */
export function pulseOperationDiagnostic(error: unknown, operation: PulseOperation, secrets: readonly string[] = []): PulseDiagnostic {
  if (!(error instanceof TableauError)) return { message: boundedProviderDiagnostic(error).message };
  if (error instanceof TableauMutationStoppedError) return { message: error.message };
  const provider = tableauProviderErrorInfo(error, secrets);
  let explanation: string;
  if (operation === 'publish' && error.status === 409 && provider.providerCode === '409902') {
    explanation = 'This metric conflicts with an existing metric definition in Tableau. Review existing definitions or change its settings before trying again.';
  } else if (error.status === 429) {
    explanation = 'Tableau is limiting requests. Wait for its retry interval before trying again.';
  } else if (error.kind === 'auth') {
    explanation = 'The Tableau connection used for this operation ended. Reconnect to the owning account to continue.';
  } else if (error.status === 403) {
    explanation = 'Tableau denied access. Check the account permissions for this resource.';
  } else if (error.status === 409) {
    explanation = 'Tableau reported a conflict. Review the current resource and its settings before trying again.';
  } else if (error.status === 404) {
    explanation = 'The resource is no longer available. Refresh metrics and review the selection.';
  } else if (error.status === 400 || error.status === 422) {
    explanation = 'Tableau rejected the settings. Review the metric configuration.';
  } else if (error.kind === 'network' || error.status >= 500) {
    explanation = 'The request could not be confirmed. Check Tableau before retrying this operation.';
  } else {
    explanation = 'Tableau could not complete the request. Review its explanation and try again when the issue is resolved.';
  }
  const detail = [...new Set([provider.summary, provider.detail].filter((value): value is string => Boolean(value)))].join(' ');
  const message = sanitizeProviderMessage(`${labels[operation]}: ${explanation}${detail ? ` ${detail}` : ''}`);
  return { message, status: error.status, ...(provider.providerCode ? { providerCode: provider.providerCode } : {}), ...(detail ? { detail } : {}) };
}

export function pulseOperationErrorMessage(error: unknown, operation: PulseOperation, secrets: readonly string[] = []): string {
  const diagnostic = pulseOperationDiagnostic(error, operation, secrets);
  const reference = [diagnostic.providerCode ? `Tableau ${diagnostic.providerCode}` : '', diagnostic.status ? `HTTP ${diagnostic.status}` : ''].filter(Boolean).join(', ');
  const limit = reference ? Math.max(80, 300 - reference.length - 3) : 300;
  const message = diagnostic.message.length > limit ? `${diagnostic.message.slice(0, limit - 1)}\u2026` : diagnostic.message;
  return reference ? `${message} (${reference})` : message;
}

export function vdsCatalogFailureMessage(catalog: DatasourceCatalog): string {
  const failure = catalog.vdsFailures?.find((entry) => entry.operation === 'read-metadata') ?? catalog.vdsFailures?.[0];
  if (!failure) return 'Tableau did not provide the VDS field metadata required for variants. Check datasource API Access or ask its owner to confirm VDS availability.';
  if (failure.kind === 'invalid-response') return `Tableau returned unusable VDS field metadata. ${failure.message}`;
  const summary = /(?:GET|POST|DELETE)\s+\//i.test(failure.message) ? undefined : failure.message;
  const error = new TableauError(failure.message, failure.status ?? 0, '', failure.kind ?? 'network', failure.providerCode, { summary, detail: failure.detail });
  const explanation = pulseOperationErrorMessage(error, 'dimension-fields');
  return failure.status === 403 ? `${explanation} Check the datasource's API Access permission.` : explanation;
}
