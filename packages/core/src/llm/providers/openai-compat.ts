import { config } from '../../config.js';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmMessage, LlmProviderHealth } from '../types.js';
import { LLM_REQUEST_TIMEOUT_MS, LlmProviderError, timeoutDescription } from '../types.js';
import { assertSafeLlmEndpoint, UnsafeLlmEndpointError } from './network-policy.js';
import { guardedFetch } from './guarded-fetch.js';
import { resolveProfileSecret } from './credential.js';
import { readProviderErrorDetail, withProviderDetail } from './error-detail.js';

type Fetch = typeof fetch;
type EndpointPolicy = (endpoint: string, allowPrivateNetwork: boolean) => Promise<void>;

function envOpenAiProfile(): StoredLlmProfile {
  return {
    id: 'openai-compat',
    label: 'OpenAI-compatible Chat Completions',
    protocol: 'openai-chat',
    baseUrl: config.llm.openaiCompat.baseUrl,
    model: config.llm.openaiCompat.model,
    authMode: 'bearer',
    secret: config.llm.openaiCompat.apiKey,
    headers: {},
    region: '',
    awsProfile: '',
    command: '',
    allowPrivateNetwork: config.llm.openaiCompat.allowPrivateNetwork,
    source: 'environment',
  };
}

function envAnthropicProfile(): StoredLlmProfile {
  return {
    id: 'anthropic',
    label: 'Anthropic Messages',
    protocol: 'anthropic-messages',
    baseUrl: config.llm.anthropic.baseUrl,
    model: config.llm.anthropic.model,
    authMode: 'x-api-key',
    secret: config.llm.anthropic.apiKey,
    headers: {},
    region: '',
    awsProfile: '',
    command: '',
    allowPrivateNetwork: config.llm.anthropic.allowPrivateNetwork,
    source: 'environment',
  };
}

export class HttpLlmProvider {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly profile: StoredLlmProfile,
    private readonly fetchImpl?: Fetch,
    private readonly endpointPolicy: EndpointPolicy = assertSafeLlmEndpoint,
  ) {
    this.id = profile.id;
    this.label = profile.label;
  }

  async isConfigured(): Promise<boolean> {
    const requiresSecret = this.profile.authMode === 'bearer' || this.profile.authMode === 'x-api-key';
    return Boolean(this.profile.baseUrl && this.profile.model && (!requiresSecret || Boolean(this.profile.secret) || Boolean(this.profile.credentialCommand)));
  }

  async getHealth(): Promise<LlmProviderHealth> {
    const configured = await this.isConfigured();
    return {
      installed: true,
      configured,
      healthy: configured ? null : false,
      reasonCode: configured ? 'not_tested' : 'not_configured',
      reason: configured ? 'Run a connection test to verify authentication and model access.' : 'Endpoint, model, or authentication is missing.',
      resolvedModel: this.profile.model || null,
    };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    if (!(await this.isConfigured())) {
      throw new LlmProviderError({
        code: 'provider_not_configured',
        message: `${this.label} is not configured.`,
        provider: this.id,
        model: this.profile.model,
      });
    }
    const protocol = this.profile.protocol;
    const suffix = protocol === 'openai-chat' ? '/chat/completions' : protocol === 'openai-responses' ? '/responses' : '/messages';
    const url = endpointUrl(this.profile.baseUrl, suffix);
    try {
      await this.endpointPolicy(url, this.profile.allowPrivateNetwork ?? false);
    } catch (error) {
      if (error instanceof UnsafeLlmEndpointError) {
        throw new LlmProviderError({ code: 'provider_execution', message: error.message, provider: this.id, model: this.profile.model });
      }
      throw error;
    }
    const token = await resolveProfileSecret(this.profile, this.id, this.profile.model);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.profile.headers };
    if (this.profile.authMode === 'bearer') headers.Authorization = `Bearer ${token}`;
    if (this.profile.authMode === 'x-api-key') headers['x-api-key'] = token;
    if (protocol === 'anthropic-messages') headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';

    let response: Response;
    try {
      // The default client re-checks every resolved address when it connects.
      const send = this.fetchImpl ?? guardedFetch(this.profile.allowPrivateNetwork ?? false);
      response = await send(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody(protocol, this.profile.model, opts)),
        signal: AbortSignal.timeout(opts.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof UnsafeLlmEndpointError) {
        throw new LlmProviderError({ code: 'provider_execution', message: error.message, provider: this.id, model: this.profile.model });
      }
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LlmProviderError({
        code: timeout ? 'provider_timeout' : 'provider_unavailable',
        message: timeout ? `${this.label} did not respond within ${timeoutDescription(opts.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS)}.` : `${this.label} could not be reached.`,
        provider: this.id,
        model: this.profile.model,
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) throw httpProviderError(response, await readProviderErrorDetail(response, [token, this.profile.secret, ...Object.values(this.profile.headers ?? {})]), this.id, this.profile.model, this.label);
    const data = await readJsonResponse(response, this.id, this.profile.model);
    const text = responseText(protocol, data);
    if (!text) {
      throw new LlmProviderError({
        code: 'invalid_provider_response',
        message: `${this.label} returned no text content.`,
        provider: this.id,
        model: this.profile.model,
      });
    }
    return { text, provider: this.id, model: this.profile.model, truncated: responseTruncated(protocol, data) };
  }
}

export class OpenAiCompatProvider extends HttpLlmProvider {
  constructor(profile: StoredLlmProfile = envOpenAiProfile(), fetchImpl?: Fetch, endpointPolicy: EndpointPolicy = assertSafeLlmEndpoint) {
    super(profile, fetchImpl, endpointPolicy);
  }
}

export class AnthropicProvider extends HttpLlmProvider {
  constructor(profile: StoredLlmProfile = envAnthropicProfile(), fetchImpl?: Fetch, endpointPolicy: EndpointPolicy = assertSafeLlmEndpoint) {
    super(profile, fetchImpl, endpointPolicy);
  }
}

function requestBody(protocol: StoredLlmProfile['protocol'], model: string, opts: CompleteOptions): Record<string, unknown> {
  if (protocol === 'anthropic-messages') {
    return {
      model,
      system: opts.system,
      max_tokens: opts.maxTokens ?? 4096,
      messages: opts.messages.filter((message) => message.role !== 'system').map(messageShape),
    };
  }
  if (protocol === 'openai-responses') {
    return {
      model,
      instructions: opts.system,
      input: opts.messages.map(messageShape),
      max_output_tokens: opts.maxTokens ?? 4096,
    };
  }
  return {
    model,
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...opts.messages.map(messageShape),
    ],
    max_tokens: opts.maxTokens ?? 4096,
  };
}

function messageShape(message: LlmMessage) {
  return { role: message.role, content: message.content };
}

function responseText(protocol: StoredLlmProfile['protocol'], data: any): string {
  if (protocol === 'anthropic-messages') {
    return (data?.content ?? []).map((block: { text?: string }) => block?.text ?? '').join('').trim();
  }
  if (protocol === 'openai-responses') {
    if (typeof data?.output_text === 'string') return data.output_text.trim();
    return (data?.output ?? []).flatMap((item: any) => item?.content ?? []).map((part: any) => part?.text ?? '').join('').trim();
  }
  return String(data?.choices?.[0]?.message?.content ?? '').trim();
}

function responseTruncated(protocol: StoredLlmProfile['protocol'], data: any): boolean {
  if (protocol === 'anthropic-messages') return data?.stop_reason === 'max_tokens';
  if (protocol === 'openai-responses') return data?.status === 'incomplete' && data?.incomplete_details?.reason === 'max_output_tokens';
  return data?.choices?.[0]?.finish_reason === 'length';
}

function endpointUrl(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.toLowerCase().endsWith(suffix) ? base : `${base}${suffix}`;
}

function httpProviderError(response: Response, detail: string | undefined, provider: string, model: string, label: string): LlmProviderError {
  const status = response.status;
  const requestId = response.headers.get('request-id') || response.headers.get('x-request-id') || response.headers.get('x-amzn-requestid');
  const safeReference = requestId && /^[a-z0-9._:-]{1,160}$/i.test(requestId) ? requestId : undefined;
  if (status === 401 || status === 403) {
    return new LlmProviderError({ code: 'provider_authentication', message: withProviderDetail(`${label} rejected authentication.`, detail), provider, model, reference: safeReference });
  }
  if (status === 429) {
    return new LlmProviderError({ code: 'provider_quota', message: withProviderDetail(`${label} rejected the request because of rate or quota limits.`, detail), provider, model, retryable: true, reference: safeReference });
  }
  return new LlmProviderError({
    code: status >= 500 ? 'provider_unavailable' : 'provider_execution',
    message: withProviderDetail(`${label} request failed with HTTP ${status}.`, detail),
    provider,
    model,
    retryable: status >= 500,
    reference: safeReference,
  });
}

async function readJsonResponse(response: Response, provider: string, model: string): Promise<any> {
  const maxBytes = 2_000_000;
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new LlmProviderError({ code: 'invalid_provider_response', message: 'Provider response exceeded the 2 MB limit.', provider, model });
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new LlmProviderError({ code: 'invalid_provider_response', message: 'Provider returned invalid JSON.', provider, model, cause: error });
  }
}
