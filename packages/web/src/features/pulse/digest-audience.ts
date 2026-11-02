export type DigestAudienceActor = 'human' | 'llm';

export function applyDigestAudienceUpdate(
  currentValue: string,
  nextValue: string,
  locked: boolean,
  actor: DigestAudienceActor,
): string {
  if (actor === 'llm' && locked) return currentValue;
  return nextValue;
}
