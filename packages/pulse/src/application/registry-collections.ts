import type {
  FollowTargetOperation,
  FollowTargetOperationResult,
  FollowTargetOperationStatus,
} from './subscriptions.js';
import { boundedProviderDiagnostic } from '../pulse/provider-diagnostics.js';
export function canonicalIds(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => String(value ?? '').trim()).filter(Boolean),
    ),
  ].sort();
}

export function canonicalFollowOperations(
  operations: FollowTargetOperation[],
): FollowTargetOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (!operation.metricId || !operation.target.id) return false;
    const key = followOperationKey(operation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function followOperationKey(operation: FollowTargetOperation): string {
  return followOperationKeyParts(
    operation.metricId,
    operation.target.kind,
    operation.target.id,
  );
}

export function followOperationKeyParts(
  metricId: string,
  targetKind: 'GROUP' | 'USER',
  targetId: string,
): string {
  return `${metricId}\u0000${targetKind}\u0000${targetId}`;
}

export function operationResult(
  operation: FollowTargetOperation,
  status: FollowTargetOperationStatus,
  ok: boolean,
  error?: string,
): FollowTargetOperationResult {
  return {
    metricId: operation.metricId,
    targetId: operation.target.id,
    targetKind: operation.target.kind,
    status,
    ok,
    ...(error ? { error: boundedProviderDiagnostic(error).message } : {}),
  };
}

export function deduplicateFollowers<T extends { id: string; type: string }>(
  followers: T[],
): T[] {
  const seen = new Set<string>();
  return followers.filter((follower) => {
    const key = `${follower.type}\u0000${follower.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

export function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function recordCollection(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (isRecord(value)) return [value];
  if (Array.isArray(value) && value.every(isRecord)) return value;
  throw new Error(`Unsupported ${label} response shape.`);
}
