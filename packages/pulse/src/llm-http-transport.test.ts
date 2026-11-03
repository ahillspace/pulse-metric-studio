import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { ProviderRegistry, LlmProviderError } from '@pulse-metric-studio/core';
import { authorOps } from './llm-authoring.js';

for (const failure of ['timeout', 'disconnect'] as const) {
  test(`HTTP body ${failure} never causes a model-format repair request`, async t => {
    let requests = 0;
    const server = http.createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{"choices":[');
      if (failure === 'disconnect') setTimeout(() => res.destroy(), 20);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const registry = new ProviderRegistry({
      environment: { OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, OPENAI_COMPAT_MODEL: 'fixture-model', OPENAI_COMPAT_API_KEY: 'fixture-key', OPENAI_COMPAT_ALLOW_PRIVATE_NETWORK: 'true' },
      store: { list: () => [], save: async profile => profile, delete: async () => {} },
      stateStore: { getActive: () => 'openai-compat', setActive: () => {}, getReadiness: () => null, setReadiness: () => {}, deleteReadiness: () => {} },
    });
    try {
      const provider = await registry.pick('openai-compat');
      await assert.rejects(authorOps(provider, { catalog: { datasourceLuid: 'fixture', datasourceName: 'Fixture', measures: [], dimensions: [], timeDimensions: [], parameters: [], excluded: [], source: 'vds', warnings: [] }, chat: [], userMessage: 'Build metrics' }, failure === 'timeout' ? 500 : 35_000), (error: unknown) => {
        assert.ok(error instanceof LlmProviderError);
        assert.equal(error.code, failure === 'timeout' ? 'provider_timeout' : 'provider_unavailable');
        assert.equal(error.provider, 'openai-compat'); assert.equal(error.model, 'fixture-model'); assert.equal(error.retryable, true);
        return true;
      });
      assert.equal(requests, 1, 'no second paid inference after a transport failure');
    } finally { await registry.close(); }
  });
}
