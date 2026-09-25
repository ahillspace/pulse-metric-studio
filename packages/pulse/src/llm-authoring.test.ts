import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LlmProviderError, type LlmCompletionTracker, type LlmProvider } from '@pulse-metric-studio/core';
import type { LlmHealthReasonCode } from '@pulse-metric-studio/shared';
import { authorOps } from './llm-authoring.js';

test('Pulse does not send infrastructure failures through the JSON repair loop', async () => {
  let calls = 0;
  const provider: LlmProvider = {
    id: 'gateway',
    label: 'Gateway',
    isConfigured: async () => true,
    complete: async () => {
      calls += 1;
      throw new LlmProviderError({
        code: 'provider_unavailable',
        message: 'Gateway unavailable.',
        provider: 'gateway',
        retryable: true,
      });
    },
  };
  await assert.rejects(() => authorOps(provider, {
    catalog: {
      datasourceName: 'Sales',
      datasourceLuid: 'sales',
      measures: [],
      dimensions: [],
      timeDimensions: [],
      parameters: [],
    } as any,
    chat: [],
    userMessage: 'Build metrics',
  }), (error: any) => error?.code === 'provider_unavailable');
  assert.equal(calls, 1);
});

function trackingProvider(
  responses: string[],
): { provider: LlmProvider; commits: Array<{ kind: 'success' } | { kind: 'failure'; reason: string | null }>; calls: () => number } {
  let calls = 0;
  const commits: Array<{ kind: 'success' } | { kind: 'failure'; reason: string | null }> = [];
  const tracking: LlmCompletionTracker = {
    commitSuccess: () => commits.push({ kind: 'success' }),
    commitFailure: (_code: LlmHealthReasonCode, reason: string | null) => commits.push({ kind: 'failure', reason }),
  };
  return {
    commits,
    calls: () => calls,
    provider: {
      id: 'gateway',
      label: 'Gateway',
      isConfigured: async () => true,
      tracking,
      complete: async () => {
        const text = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        return { text, provider: 'gateway', model: 'gateway-model' };
      },
    },
  };
}

function capturingProvider(): { provider: LlmProvider; userPrompt: () => string; systemPrompt: () => string } {
  let user = '';
  let system = '';
  return {
    userPrompt: () => user,
    systemPrompt: () => system,
    provider: {
      id: 'gateway',
      label: 'Gateway',
      isConfigured: async () => true,
      complete: async ({ system: sys, messages }) => {
        system = sys ?? '';
        user = String(messages[0]?.content ?? '');
        return { text: JSON.stringify({ assistantMessage: 'ok', ops: [] }), provider: 'gateway', model: 'gateway-model' };
      },
    },
  };
}

function calcCatalog(overrides: Partial<any> = {}): any {
  return {
    datasourceName: 'Sales',
    datasourceLuid: 'sales',
    measures: [
      {
        id: 'Calculation_123456789',
        name: 'Calculation_123456789',
        label: 'Average Deal Cycle',
        caption: 'Average Deal Cycle',
        role: 'MEASURE',
        dataType: 'REAL',
        formula: "AVG(DATEDIFF('day',[Order Date],[Ship Date]))",
        requiresUserAgg: false,
        table: 'Orders',
      },
    ],
    dimensions: [],
    timeDimensions: [],
    parameters: [],
    ...overrides,
  };
}

test('Pulse prompt exposes friendly field names so the model can reason about and name calc fields', async () => {
  const { provider, userPrompt } = capturingProvider();
  await authorOps(provider, { catalog: calcCatalog(), chat: [], userMessage: 'Build metrics' });
  const prompt = userPrompt();
  // Human caption reaches the model for reasoning/naming...
  assert.match(prompt, /Average Deal Cycle/);
  // ...while the raw id is still present for verbatim fieldId copying.
  assert.match(prompt, /Calculation_123456789/);
});

test('Pulse prompt falls back to the formula when a calc field has no author caption', async () => {
  const { provider, userPrompt } = capturingProvider();
  const catalog = calcCatalog({
    measures: [
      {
        id: 'Calculation_987654321',
        name: 'Calculation_987654321',
        // No author caption: label and caption collapse to the raw internal name.
        label: 'Calculation_987654321',
        caption: 'Calculation_987654321',
        role: 'MEASURE',
        dataType: 'REAL',
        formula: 'SUM([Profit])/SUM([Sales])',
        requiresUserAgg: true,
        table: null,
      },
    ],
  });
  await authorOps(provider, { catalog, chat: [], userMessage: 'Build metrics' });
  const prompt = userPrompt();
  assert.match(prompt, /SUM\(\[Profit\]\)\/SUM\(\[Sales\]\)/);
});

test('Pulse commits readiness success only after validation completes', async () => {
  const { provider, commits, calls } = trackingProvider([JSON.stringify({ assistantMessage: 'ok', ops: [] })]);
  await authorOps(provider, {
    catalog: {
      datasourceName: 'Sales',
      datasourceLuid: 'sales',
      measures: [],
      dimensions: [],
      timeDimensions: [],
      parameters: [],
    } as any,
    chat: [],
    userMessage: 'Build metrics',
  });
  assert.equal(calls(), 1);
  assert.deepEqual(commits, [{ kind: 'success' }]);
});

test('Pulse terminates a repair failure with a failure commit, never a success', async () => {
  const { provider, commits, calls } = trackingProvider(['no json at all', 'still not json']);
  await assert.rejects(() => authorOps(provider, {
    catalog: {
      datasourceName: 'Sales',
      datasourceLuid: 'sales',
      measures: [],
      dimensions: [],
      timeDimensions: [],
      parameters: [],
    } as any,
    chat: [],
    userMessage: 'Build metrics',
  }), /could not produce valid ops after repair/);
  assert.equal(calls(), 2);
  assert.deepEqual(commits, [{ kind: 'failure', reason: 'Model could not produce valid ops after repair: Model response contained no parsable JSON object.' }]);
});

test('Pulse commits a single success after a successful repair round-trip', async () => {
  const { provider, commits, calls } = trackingProvider([
    'broken output',
    JSON.stringify({ assistantMessage: 'repaired', ops: [] }),
  ]);
  await authorOps(provider, {
    catalog: {
      datasourceName: 'Sales',
      datasourceLuid: 'sales',
      measures: [],
      dimensions: [],
      timeDimensions: [],
      parameters: [],
    } as any,
    chat: [],
    userMessage: 'Build metrics',
  });
  assert.equal(calls(), 2);
  assert.deepEqual(commits, [{ kind: 'success' }]);
});
