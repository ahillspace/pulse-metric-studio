import { LlmProviderError,type LlmCompletionTracker,type LlmProvider } from '@pulse-metric-studio/core';
import type { LlmHealthReasonCode } from '@pulse-metric-studio/shared';
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  truncated = false,
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
        return { text, provider: 'gateway', model: 'gateway-model', truncated };
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

test('Pulse authoring instructions select business value without arbitrary metric or slicer limits', async () => {
  const { provider, systemPrompt } = capturingProvider();
  await authorOps(provider, { catalog: calcCatalog(), chat: [], userMessage: 'Build metrics' });
  assert.match(systemPrompt(), /Include all metrics and slicers that provide business value/i);
  assert.match(systemPrompt(), /distinct counts.*significant business value/i);
  assert.doesNotMatch(systemPrompt(), /Prefer 3-8|3-6 meaningful slicers/);
});

test('Pulse authoring separates month-to-date metrics from minimum granularity', async () => {
  const { provider, systemPrompt } = capturingProvider();
  await authorOps(provider, { catalog: calcCatalog(), chat: [], userMessage: 'Build metrics' });
  assert.match(systemPrompt(), /Preserve the current minimum time granularity/i);
  assert.match(systemPrompt(), /explicitly requests.*name or description explicitly states that daily data is unavailable/i);
  assert.match(systemPrompt(), /month-to-date.*does not change.*minimum/i);
  assert.doesNotMatch(systemPrompt(), /coarsest sensible display grain|coarser grain for slow-moving data/);
});

test('Pulse sends transcript-sized requests and prior proposal context without silent truncation', async () => {
  const { provider, userPrompt } = capturingProvider();
  const transcript = `Meeting start ${'public synthetic meeting note '.repeat(20000)} final-decision`;
  await authorOps(provider, {
    catalog: calcCatalog(), userMessage: transcript,
    chat: [{ role: 'user', content: transcript }, { role: 'assistant', content: 'Suggested', proposalContext: '[{"op":"ADD_METRIC","fieldId":"Sales"}]' }],
    selection: { instructions: 'context '.repeat(1000), lastValue: 'kept-at-end' },
  });
  const prompt = userPrompt();
  assert.ok(prompt.includes(`REQUEST: ${transcript}`));
  assert.ok(prompt.includes(`user: ${transcript}`));
  assert.match(prompt, /Previous proposed changes.*ADD_METRIC/);
  assert.match(prompt, /kept-at-end/);
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
  }), (error: unknown) => error instanceof LlmProviderError && error.code === 'invalid_model_output' && /could not produce a valid draft after one repair attempt/.test(error.message));
  assert.equal(calls(), 2);
  assert.deepEqual(commits, [{ kind: 'failure', reason: 'The assistant could not produce a valid draft after one repair attempt: Model response contained no parsable JSON object.' }]);
});

test('Pulse reports a truncated draft without a futile repair round-trip', async () => {
  const { provider, commits, calls } = trackingProvider(['{"assistantMessage":"partial","ops":[{"op":'], true);
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
  }), (error: unknown) => error instanceof LlmProviderError && /output token limit/.test(error.message));
  assert.equal(calls(), 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.kind, 'failure');
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


test('assistant operation parsing strips data mode and timeframe decisions', async () => {
  const { provider } = trackingProvider([JSON.stringify({ assistantMessage: 'Metrics prepared', ops: [
    { op: 'ADD_METRIC', fieldId: 'Calculation_123456789', temporality: 'LATEST', measurement_period: { range: 'RANGE_LAST_COMPLETE', granularity: 'GRANULARITY_BY_YEAR' } },
  ] })]);
  const result = await authorOps(provider, { catalog: calcCatalog(), chat: [], userMessage: 'Build metrics' });
  assert.equal('temporality' in result.ops[0], false);
  assert.equal('measurement_period' in result.ops[0], false);
});

test('assistant prompt reserves timeframe and data mode to the app', async () => {
  const { provider, systemPrompt } = capturingProvider();
  await authorOps(provider, { catalog: calcCatalog(), chat: [], userMessage: 'Build metrics' });
  assert.match(systemPrompt(), /Timeframe and data mode are app-owned/);
  assert.match(systemPrompt(), /month-to-date and OVER_TIME/);
  assert.match(systemPrompt(), /minimum time granularity DAY by default/);
  assert.doesNotMatch(systemPrompt(), /LATEST only for snapshot/);
});
