import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { config } from '../../config.js';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmMessage, LlmProviderHealth } from '../types.js';
import { LlmProviderError } from '../types.js';
import { assertSafeLlmEndpoint, UnsafeLlmEndpointError } from './network-policy.js';
import { resolveProfileSecret } from './credential.js';
import { readProviderErrorDetail, withProviderDetail } from './error-detail.js';

type EndpointPolicy = (endpoint: string, allowPrivateNetwork: boolean) => Promise<void>;

function envBedrockProfile(): StoredLlmProfile {
  return {
    id: 'bedrock',
    label: 'Amazon Bedrock Converse',
    protocol: 'bedrock-converse',
    baseUrl: config.llm.bedrock.endpointOverride,
    model: config.llm.bedrock.modelId,
    authMode: 'aws',
    secret: '',
    headers: {},
    region: config.llm.bedrock.region,
    awsProfile: config.llm.bedrock.awsProfile,
    command: '',
    allowPrivateNetwork: config.llm.bedrock.allowPrivateNetwork,
    source: 'environment',
  };
}

export class BedrockProvider {
  readonly id: string;
  readonly label: string;

  constructor(
    private readonly profile: StoredLlmProfile = envBedrockProfile(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly endpointPolicy: EndpointPolicy = assertSafeLlmEndpoint,
  ) {
    this.id = profile.id;
    this.label = profile.label;
  }

  async isConfigured(): Promise<boolean> {
    const health = await this.getHealth();
    return health.configured;
  }

  async getHealth(): Promise<LlmProviderHealth> {
    if (!this.profile.region || !this.profile.model) {
      return { installed: true, configured: false, healthy: false, reasonCode: 'not_configured', reason: 'AWS region and model are required.', resolvedModel: this.profile.model || null };
    }
    if (this.profile.authMode === 'bearer') {
      const configured = Boolean(this.profile.secret) || Boolean(this.profile.credentialCommand);
      return {
        installed: true,
        configured,
        healthy: configured ? null : false,
        reasonCode: configured ? 'not_tested' : 'not_configured',
        reason: configured ? 'Run a connection test to verify Bedrock model access.' : 'A Bedrock bearer token or credential command is required.',
        resolvedModel: this.profile.model,
      };
    }
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      return { installed: true, configured: true, healthy: null, reasonCode: 'not_tested', reason: 'Run a connection test to verify model access.', resolvedModel: this.profile.model };
    }
    try {
      await this.client().config.credentials();
      return { installed: true, configured: true, healthy: null, reasonCode: 'not_tested', reason: 'AWS credentials resolved. Run a connection test to verify model access.', resolvedModel: this.profile.model };
    } catch {
      return { installed: true, configured: false, healthy: false, reasonCode: 'authentication_failed', reason: 'AWS credentials could not be resolved.', resolvedModel: this.profile.model };
    }
  }

  client(): BedrockRuntimeClient {
    return new BedrockRuntimeClient({
      region: this.profile.region,
      ...(this.profile.baseUrl ? { endpoint: this.profile.baseUrl } : {}),
      ...(this.profile.awsProfile ? { credentials: fromIni({ profile: this.profile.awsProfile }) } : {}),
    });
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const health = await this.getHealth();
    if (!health.configured) {
      throw new LlmProviderError({ code: 'provider_not_configured', message: health.reason ?? 'Amazon Bedrock is not configured.', provider: this.id, model: this.profile.model });
    }
    try {
      if (this.profile.authMode === 'bearer') return await this.completeWithBearer(opts);
      if (this.profile.baseUrl) await this.endpointPolicy(this.profile.baseUrl, this.profile.allowPrivateNetwork ?? false);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      let response;
      try {
        response = await this.client().send(new ConverseCommand({
          modelId: this.profile.model,
          system: opts.system ? [{ text: opts.system }] : undefined,
          messages: opts.messages.map((message: LlmMessage) => ({
            role: (message.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
            content: [{ text: message.content }],
          })),
          inferenceConfig: { maxTokens: opts.maxTokens ?? 4096 },
        }), { abortSignal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const text = (response.output?.message?.content ?? []).map((content) => content.text ?? '').join('').trim();
      if (!text) throw new LlmProviderError({ code: 'invalid_provider_response', message: 'Amazon Bedrock returned no text content.', provider: this.id, model: this.profile.model });
      return { text, provider: this.id, model: this.profile.model, truncated: response.stopReason === 'max_tokens' };
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      const failure = classifyBedrockError(error);
      throw new LlmProviderError({
        code: failure.code,
        message: withProviderDetail(failure.message, error instanceof Error ? error.message : undefined),
        provider: this.id,
        model: this.profile.model,
        retryable: failure.retryable,
        cause: error,
      });
    }
  }

  private async completeWithBearer(opts: CompleteOptions): Promise<CompleteResult> {
    const baseUrl = this.profile.baseUrl || `https://bedrock-runtime.${this.profile.region}.amazonaws.com`;
    const url = `${baseUrl.replace(/\/+$/, '')}/model/${encodeURIComponent(this.profile.model)}/converse`;
    try {
      await this.endpointPolicy(url, this.profile.allowPrivateNetwork ?? false);
    } catch (error) {
      if (error instanceof UnsafeLlmEndpointError) {
        throw new LlmProviderError({ code: 'provider_execution', message: error.message, provider: this.id, model: this.profile.model });
      }
      throw error;
    }
    const token = await resolveProfileSecret(this.profile, this.id, this.profile.model);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.profile.headers, Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          system: opts.system ? [{ text: opts.system }] : undefined,
          messages: opts.messages.map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: [{ text: message.content }],
          })),
          inferenceConfig: { maxTokens: opts.maxTokens ?? 4096 },
        }),
        signal: AbortSignal.timeout(180_000),
        redirect: 'error',
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new LlmProviderError({
        code: timeout ? 'provider_timeout' : 'provider_unavailable',
        message: timeout ? 'Amazon Bedrock timed out.' : 'Amazon Bedrock could not be reached.',
        provider: this.id,
        model: this.profile.model,
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      const requestId = response.headers.get('x-amzn-requestid');
      const reference = requestId && /^[a-z0-9._:-]{1,160}$/i.test(requestId) ? requestId : undefined;
      const detail = await readProviderErrorDetail(response, [token]);
      throw new LlmProviderError({
        code: response.status === 401 || response.status === 403 ? 'provider_authentication' : response.status === 429 ? 'provider_quota' : response.status >= 500 ? 'provider_unavailable' : 'provider_execution',
        message: withProviderDetail(`Amazon Bedrock request failed with HTTP ${response.status}.`, detail),
        provider: this.id,
        model: this.profile.model,
        retryable: response.status === 429 || response.status >= 500,
        reference,
      });
    }
    const data = await readBoundedJson(response, this.id, this.profile.model);
    const text = (data?.output?.message?.content ?? []).map((content: { text?: string }) => content.text ?? '').join('').trim();
    if (!text) throw new LlmProviderError({ code: 'invalid_provider_response', message: 'Amazon Bedrock returned no text content.', provider: this.id, model: this.profile.model });
    return { text, provider: this.id, model: this.profile.model, truncated: data?.stopReason === 'max_tokens' };
  }
}

export function classifyBedrockError(error: unknown): {
  code: 'provider_authentication' | 'provider_quota' | 'provider_timeout' | 'provider_unavailable' | 'provider_execution';
  message: string;
  retryable: boolean;
} {
  const record = error && typeof error === 'object' ? error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } : {};
  const name = typeof record.name === 'string' ? record.name : error instanceof Error ? error.name : '';
  const status = typeof record.$metadata?.httpStatusCode === 'number' ? record.$metadata.httpStatusCode : 0;
  if (/credential|accessdenied|unauthorized|signature|unrecognizedclient/i.test(name) || status === 401 || status === 403) {
    return { code: 'provider_authentication', message: 'Amazon Bedrock rejected authentication.', retryable: false };
  }
  if (/throttl|quota|toomanyrequests/i.test(name) || status === 429) {
    return { code: 'provider_quota', message: 'Amazon Bedrock rejected the request because of rate or quota limits.', retryable: true };
  }
  if (/timeout|abort/i.test(name)) {
    return { code: 'provider_timeout', message: 'Amazon Bedrock timed out.', retryable: true };
  }
  if (/validation|resourcenotfound|modelnotready/i.test(name) || (status >= 400 && status < 500)) {
    return { code: 'provider_execution', message: 'Amazon Bedrock rejected the request.', retryable: false };
  }
  return { code: 'provider_unavailable', message: 'Amazon Bedrock request failed.', retryable: status === 0 || status >= 500 };
}

async function readBoundedJson(response: Response, provider: string, model: string): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 2_000_000) {
      await reader.cancel();
      throw new LlmProviderError({ code: 'invalid_provider_response', message: 'Amazon Bedrock response exceeded the 2 MB limit.', provider, model });
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new LlmProviderError({ code: 'invalid_provider_response', message: 'Amazon Bedrock returned invalid JSON.', provider, model, cause: error });
  }
}
