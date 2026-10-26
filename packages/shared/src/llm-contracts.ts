import { z } from 'zod';
import { parseLaunchCommand } from './local-launch-command.js';

export const LLM_PROTOCOLS = [
  'opencode',
  'codex-cli',
  'claude-code',
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'bedrock-converse',
] as const;

export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];
export type LlmAuthMode = 'none' | 'local-account' | 'bearer' | 'x-api-key' | 'aws';
export type LlmHealthReasonCode =
  | 'ready'
  | 'not_installed'
  | 'not_configured'
  | 'not_tested'
  | 'authentication_failed'
  | 'model_unavailable'
  | 'transport_failed'
  | 'provider_unavailable'
  | 'invalid_response';

export const BLOCKED_LLM_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'forwarded',
  'via',
  'te',
  'trailer',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-http-method-override',
  'x-original-url',
  'x-rewrite-url',
]);

const SAFE_VENDOR_HEADERS = new Set(['anthropic-beta', 'openai-organization', 'openai-project']);

/**
 * Every saved secret (API key, header value, credential command, Tableau PAT)
 * is one OS credential store entry, and this is the size both stores accept:
 * Windows Credential Manager holds 1,280 UTF-16 characters, and the macOS
 * security tool reads at most a 4 KB command line. Mirrors MAX_STORED_SECRET
 * in the native credential broker.
 */
export const SAVED_SECRET_MAX_BYTES = 1200;
/** Shown in place of any saved secret; it never reflects the secret's length or content. */
export const SAVED_SECRET_PLACEHOLDER = '***************';

const savedSecret = <T extends z.ZodString>(schema: T) => schema.refine(
  (value) => new TextEncoder().encode(value).length <= SAVED_SECRET_MAX_BYTES,
  { message: `Saved secrets can be at most ${SAVED_SECRET_MAX_BYTES} bytes.` },
);

const HeaderNameSchema = z.string().trim().min(1).max(80).regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i);
const HeaderValueSchema = savedSecret(z.string()).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
  message: 'Header values cannot contain control characters.',
}).refine((value) => value !== '[configured]', {
  message: 'Masked header placeholders cannot be saved.',
});
const HeadersSchema = z.record(HeaderNameSchema, HeaderValueSchema).superRefine((headers, ctx) => {
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (BLOCKED_LLM_HEADER_NAMES.has(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'This security-sensitive header is managed by the app.' });
    } else if (!normalized.startsWith('x-') && !SAFE_VENDOR_HEADERS.has(normalized)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'Only approved vendor headers and non-reserved x-* headers are supported.' });
    }
  }
});

export const LlmProfileWriteSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  label: z.string().trim().min(1).max(120),
  protocol: z.enum(LLM_PROTOCOLS),
  baseUrl: z.string().trim().url().max(2000).optional().or(z.literal('')),
  model: z.string().trim().max(240).optional().default(''),
  authMode: z.enum(['none', 'local-account', 'bearer', 'x-api-key', 'aws']).default('none'),
  secret: savedSecret(z.string()).optional(),
  clearSecret: z.boolean().optional().default(false),
  headers: HeadersSchema.optional(),
  clearHeaders: z.boolean().optional().default(false),
  allowPrivateNetwork: z.boolean().optional().default(false),
  region: z.string().trim().max(80).optional().default(''),
  awsProfile: z.string().trim().max(120).optional().default(''),
  command: z.string().trim().max(1000).optional().default(''),
  /** Omit to keep the saved command; the API never returns a saved command. */
  credentialCommand: savedSecret(z.string().trim()).optional(),
  clearCredentialCommand: z.boolean().optional().default(false),
}).superRefine((profile, ctx) => {
  const localAccount = profile.protocol === 'codex-cli' || profile.protocol === 'claude-code';
  if (localAccount) {
    if (profile.authMode !== 'local-account') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authMode'], message: 'This provider uses authentication managed by the local CLI.' });
    if (profile.baseUrl || profile.secret || Object.keys(profile.headers ?? {}).length || profile.credentialCommand || profile.region || profile.awsProfile || profile.allowPrivateNetwork) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['protocol'], message: 'Local account profiles use only the command and model fields.' });
    }
  } else if (profile.authMode === 'local-account') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authMode'], message: 'This protocol does not use a local account.' });
  }
  if (['openai-chat', 'openai-responses', 'anthropic-messages'].includes(profile.protocol) && !profile.baseUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Base URL is required for this protocol.' });
  }
  if (!profile.model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'Model is required for this protocol.' });
  }
  if (profile.protocol === 'bedrock-converse' && !['aws', 'bearer'].includes(profile.authMode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authMode'], message: 'Bedrock Converse requires AWS or Bedrock bearer-token authentication.' });
  }
  if (profile.protocol === 'bedrock-converse' && profile.authMode === 'aws' && Object.keys(profile.headers ?? {}).length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers'], message: 'Custom headers require Bedrock bearer-token authentication.' });
  }
  if (['openai-chat', 'openai-responses', 'anthropic-messages'].includes(profile.protocol) && profile.authMode === 'aws') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authMode'], message: 'This HTTP protocol does not support AWS request signing.' });
  }
  if (profile.protocol === 'opencode' && (profile.baseUrl || Object.keys(profile.headers ?? {}).length || profile.authMode !== 'none')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['protocol'], message: 'OpenCode profiles use only the command and model fields.' });
  }
  if (profile.baseUrl) {
    let url: URL;
    try {
      url = new URL(profile.baseUrl);
    } catch {
      return;
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Endpoints require HTTPS, except loopback development endpoints.' });
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Endpoint URLs cannot contain credentials.' });
    }
    if (url.search || url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baseUrl'], message: 'Endpoint URLs cannot contain query strings or fragments.' });
    }
  }
  if ((localAccount || profile.protocol === 'opencode') && profile.command) {
    try { parseLaunchCommand(profile.command); }
    catch (error) {
      if (!isLegacyAbsoluteExecutablePath(profile.command)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: error instanceof Error ? error.message : 'Enter a valid local launch command.' });
    }
  }
  if (profile.protocol === 'opencode' && profile.credentialCommand) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialCommand'], message: 'OpenCode profiles authenticate through the OpenCode CLI, not a credential command.' });
  }
  if (profile.protocol === 'bedrock-converse' && profile.authMode === 'aws' && profile.credentialCommand) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['credentialCommand'], message: 'AWS credential mode does not use a credential command; use Bedrock bearer-token authentication.' });
  }
});

export type LlmProfileWrite = z.input<typeof LlmProfileWriteSchema>;

/** Legacy saved paths are resolved as whole files before launch-command tokenization. */
function isLegacyAbsoluteExecutablePath(command: string): boolean {
  if (/["\u0000-\u001f\u007f]/.test(command) || /\.exe\s|\s-{1,2}\S|\s'/i.test(command)) return false;
  const absolute = /^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(command);
  return absolute && /[\\/][a-z0-9_.-]+$/i.test(command);
}

export interface LlmProfilePublic {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  authMode: LlmAuthMode;
  hasSecret: boolean;
  headers: Record<string, string>;
  region: string;
  awsProfile: string;
  command: string;
  /** Saved credential commands can embed secrets, so only their presence and executable are returned. */
  hasCredentialCommand: boolean;
  credentialCommandHint: string | null;
  allowPrivateNetwork: boolean;
  source: 'environment' | 'saved';
}

export interface LlmProviderStatus extends LlmProfilePublic {
  installed: boolean;
  configured: boolean;
  available: boolean;
  healthy: boolean | null;
  reasonCode: LlmHealthReasonCode;
  reason: string | null;
  resolvedModel: string | null;
}

export interface LlmStatusResponse {
  active: string;
  resolvedProvider: string | null;
  providers: Record<string, LlmProviderStatus>;
  models: Record<string, string | null>;
  readiness: LlmReadinessStatus;
}

export type LlmReadinessState = 'red' | 'yellow' | 'green';

export interface LlmReadinessStatus {
  state: LlmReadinessState;
  providerId: string | null;
  message: string;
  lastSuccessfulAt: string | null;
}

export interface LlmModelOption {
  id: string;
  label: string;
}

export interface LlmModelCatalogResponse {
  provider: LlmProtocol;
  source: 'provider' | 'manual';
  selection: 'catalog' | 'manual';
  models: LlmModelOption[];
}

export interface LlmErrorResponse {
  message: string;
  error: {
    code: string;
    message: string;
    provider: string | null;
    model: string | null;
    retryable: boolean;
    reference: string;
  };
}
