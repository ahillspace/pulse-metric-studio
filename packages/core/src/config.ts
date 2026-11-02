import { config as loadDotenv, type DotenvConfigOutput } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export interface LoadRepoEnvOptions {
  moduleUrl?: string | URL;
  processEnv?: Record<string, string>;
}

export function resolveRepoEnvPath(moduleUrl: string | URL = import.meta.url): string {
  return fileURLToPath(new URL('../../../.env', moduleUrl));
}

export function loadRepoEnv(options: LoadRepoEnvOptions = {}): DotenvConfigOutput {
  return loadDotenv({
    path: resolveRepoEnvPath(options.moduleUrl),
    processEnv: options.processEnv,
  });
}

loadRepoEnv();

function envStr(name: string, fallback = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function envBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

const repoRoot = path.dirname(resolveRepoEnvPath());
const configuredDataDir = envStr('PULSE_METRIC_STUDIO_DATA_DIR', 'data');
const dataDir = path.resolve(repoRoot, configuredDataDir);

export const config = {
  port: Number(envStr('PORT', '4620')),
  host: envStr('HOST', '127.0.0.1'),
  dataDir,
  dbPath: path.join(dataDir, 'pulse-metric-studio.db'),
  machineKeyPath: path.join(dataDir, 'machine.key'),
  logLevel: envStr('LOG_LEVEL', 'info'),
  corsAllowedOrigins: envStr(
    'PULSE_METRIC_STUDIO_CORS_ALLOWED_ORIGINS',
    'http://127.0.0.1:4621,http://localhost:4621,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:1420,http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost',
  ).split(',').map((origin) => origin.trim()).filter(Boolean),
  llm: {
    providerPreference: envStr('PULSE_METRIC_STUDIO_LLM_PROVIDER', 'opencode') as
      | 'auto'
      | 'opencode'
      | 'bedrock'
      | 'openai-compat'
      | 'anthropic',
    bedrock: {
      region: envStr('AWS_REGION', 'us-east-1'),
      modelId: envStr('BEDROCK_MODEL_ID', 'anthropic.claude-sonnet-4-20250514-v1:0'),
      endpointOverride: envStr('AWS_ENDPOINT_URL_BEDROCK', ''),
      awsProfile: envStr('AWS_PROFILE', ''),
      allowPrivateNetwork: envBool('BEDROCK_ALLOW_PRIVATE_NETWORK'),
    },
    openaiCompat: {
      baseUrl: envStr('OPENAI_COMPAT_BASE_URL', ''),
      apiKey: envStr('OPENAI_COMPAT_API_KEY', ''),
      model: envStr('OPENAI_COMPAT_MODEL', ''),
      allowPrivateNetwork: envBool('OPENAI_COMPAT_ALLOW_PRIVATE_NETWORK'),
    },
    anthropic: {
      baseUrl: envStr('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
      apiKey: envStr('ANTHROPIC_API_KEY', ''),
      model: envStr('ANTHROPIC_MODEL', 'claude-sonnet-4-20250514'),
      allowPrivateNetwork: envBool('ANTHROPIC_ALLOW_PRIVATE_NETWORK'),
    },
    opencode: {
      bin: envStr('OPENCODE_BIN', 'opencode'),
      model: envStr('OPENCODE_MODEL', ''),
    },
  },
};

export type AppConfig = typeof config;
