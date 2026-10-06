import { desktopFetch } from '../desktop-transport';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LlmAuthMode,
  LlmModelCatalogResponse,
  LlmProfilePublic,
  LlmProtocol,
  LlmProviderStatus,
  LlmStatusResponse,
} from '@pulse-metric-studio/shared';
import { WorkbenchModal } from './workbench';
import { buildOpenCodeModelOptions, isCurrentOpenCodeModel, openCodeCatalogProfileId } from './llm-model-options';
import { ProviderSetupChoices, newProviderId, providerAccess, providerChoice, providerDescription, straightenQuotes, type ProviderChoice } from './llm-provider-choices';
import './llm-settings.css';
import { LLM_HEALTH_EVENT } from '../llm-health-events';

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await desktopFetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? data?.message ?? (typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`));
  return data as T;
}

const llmApi = {
  status: () => request<LlmStatusResponse>('/api/llm/status'),
  profiles: () => request<{ profiles: LlmProfilePublic[] }>('/api/llm/profiles'),
  models: (id: string) => request<LlmModelCatalogResponse>(`/api/llm/profiles/${encodeURIComponent(id)}/models`),
  setupModels: (command: string) => request<LlmModelCatalogResponse>(`/api/llm/setup/opencode/models?command=${encodeURIComponent(command)}`),
  save: (id: string, profile: Record<string, unknown>) => request<LlmProfilePublic>(`/api/llm/profiles/${encodeURIComponent(id)}`, 'PUT', profile),
  remove: (id: string) => request<{ ok: true }>(`/api/llm/profiles/${encodeURIComponent(id)}`, 'DELETE'),
  test: (id: string) => request<LlmProviderStatus>(`/api/llm/profiles/${encodeURIComponent(id)}/test`, 'POST', {}),
  select: (provider: string) => request<{ ok: true; active: string }>('/api/llm/provider', 'POST', { provider }),
};

interface ProfileForm {
  id: string; label: string; protocol: LlmProtocol; baseUrl: string; model: string; authMode: LlmAuthMode;
  secret: string; hasSecret: boolean; clearSecret: boolean; headersText: string; headersDirty: boolean; clearHeaders: boolean; region: string; awsProfile: string; command: string; credentialCommand: string; hasCredentialCommand: boolean; credentialCommandHint: string | null; clearCredentialCommand: boolean; secretHint: string | null; allowPrivateNetwork: boolean; source: 'environment' | 'saved' | 'new';
  persistedProtocol?: LlmProtocol;
}

const emptyForm: ProfileForm = { id: '', label: '', protocol: 'opencode', baseUrl: '', model: '', authMode: 'none', secret: '', hasSecret: false, clearSecret: false, headersText: '{}', headersDirty: false, clearHeaders: false, region: '', awsProfile: '', command: 'opencode', credentialCommand: '', hasCredentialCommand: false, credentialCommandHint: null, clearCredentialCommand: false, secretHint: null, allowPrivateNetwork: false, source: 'new' };

function formFromProfile(profile: LlmProfilePublic): ProfileForm {
  return { id: profile.id, label: profile.label, protocol: profile.protocol, baseUrl: profile.baseUrl, model: profile.model, authMode: profile.authMode, secret: '', hasSecret: profile.hasSecret, clearSecret: false, headersText: JSON.stringify(profile.headers, null, 2), headersDirty: false, clearHeaders: false, region: profile.region, awsProfile: profile.awsProfile, command: profile.command, credentialCommand: '', hasCredentialCommand: profile.hasCredentialCommand, credentialCommandHint: profile.credentialCommandHint, clearCredentialCommand: false, secretHint: profile.secretHint, allowPrivateNetwork: profile.allowPrivateNetwork, source: profile.source, persistedProtocol: profile.protocol };
}

/** Saved commands are never sent back to the UI: send one only when it is new or being cleared. */
function credentialCommandWrite(form: ProfileForm): { credentialCommand?: string; clearCredentialCommand?: boolean } {
  if (form.clearCredentialCommand) return { credentialCommand: '', clearCredentialCommand: true };
  const command = straightenQuotes(form.credentialCommand).trim();
  return command ? { credentialCommand: command } : {};
}

function usesCredentialCommand(form: ProfileForm): boolean {
  return Boolean(form.credentialCommand.trim()) || (form.hasCredentialCommand && !form.clearCredentialCommand);
}

function hasConfiguredHeaders(text: string): boolean {
  try {
    const value = JSON.parse(text || '{}');
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
  } catch {
    return false;
  }
}

export function LlmBadge() {
  const [status, setStatus] = useState<LlmStatusResponse | null>(null);
  const [profiles, setProfiles] = useState<LlmProfilePublic[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProfileForm>(emptyForm);
  const [formDirty, setFormDirty] = useState(false);
  const [editingExisting, setEditingExisting] = useState(false);
  const [choosing, setChoosing] = useState(true);
  const editorInitialized = useRef(false);
  const loadSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [nextStatus, nextProfiles] = await Promise.all([llmApi.status(), llmApi.profiles()]);
      if (sequence !== loadSequence.current) return;
      setStatus(nextStatus);
      setProfiles(nextProfiles.profiles);
    } catch { if (sequence === loadSequence.current) setStatus(null); }
  }, []);

  // Status is fetched once on mount, then only when there is a reason for it to
  // have changed: the settings modal opens, a provider is saved/tested/selected,
  // or an assistant send resolves. No interval polling.
  useEffect(() => { void load(); return () => { loadSequence.current++; }; }, [load]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('open-llm-settings', show);
    return () => window.removeEventListener('open-llm-settings', show);
  }, []);
  useEffect(() => {
    const onHealth = () => { void load(); };
    window.addEventListener(LLM_HEALTH_EVENT, onHealth);
    return () => window.removeEventListener(LLM_HEALTH_EVENT, onHealth);
  }, [load]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => {
    if (!open || editorInitialized.current) return;
    const profile = profiles.find((entry) => entry.id === status?.active) ?? profiles[0];
    if (!profile) return;
    editorInitialized.current = true;
    setForm(formFromProfile(profile));
    setFormDirty(false);
    setEditingExisting(true);
    setChoosing(false);
  }, [open, profiles, status]);

  const activeLabel = status?.providers[status?.active ?? '']?.label ?? 'Assistant settings';
  const readiness = status?.readiness ?? {
    state: 'red' as const,
    message: 'AI readiness is unavailable.',
    lastSuccessfulAt: null,
  };
  const readinessLabel = readiness.state === 'green'
    ? 'AI ready'
    : readiness.state === 'yellow'
      ? 'AI configured but not verified'
      : 'AI unavailable';
  const readinessTooltip = `${readinessLabel}. ${readiness.message}`;

  const edit = (profile?: LlmProfilePublic) => {
    editorInitialized.current = true;
    setForm(profile ? formFromProfile(profile) : emptyForm);
    setFormDirty(false);
    setEditingExisting(Boolean(profile));
    setChoosing(!profile);
    setFeedback(null);
  };

  const choose = (choice: ProviderChoice) => {
    editorInitialized.current = true;
    setForm({ ...emptyForm, id: newProviderId(choice.id, profiles), label: choice.label, protocol: choice.protocol, authMode: choice.authMode, baseUrl: choice.baseUrl, region: choice.id === 'bedrock' ? 'us-east-1' : '' });
    setChoosing(false); setEditingExisting(false); setFormDirty(true); setFeedback(null);
  };

  const save = async () => {
    setBusy(true); setFeedback(null);
    try {
      const headers = JSON.parse(straightenQuotes(form.headersText || '{}'));
      if (!headers || Array.isArray(headers) || typeof headers !== 'object') throw new Error('Custom headers must be a JSON object.');
      if (form.headersDirty && Object.values(headers).some((value) => value === '[configured]')) throw new Error('Replace every [configured] header placeholder with its value before saving header changes.');
      const saved = await llmApi.save(form.id, { label: form.label, protocol: form.protocol, baseUrl: form.baseUrl, model: form.model, authMode: form.authMode, secret: form.secret || undefined, clearSecret: form.clearSecret, ...(form.headersDirty ? { headers } : {}), clearHeaders: form.clearHeaders, region: form.region, awsProfile: form.awsProfile, command: form.command, ...credentialCommandWrite(form), allowPrivateNetwork: form.allowPrivateNetwork });
      setForm(formFromProfile(saved)); setFormDirty(false); setEditingExisting(true); setFeedback({ tone: 'success', message: 'Provider profile saved securely.' }); await load();
    } catch (error) { setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  const testProfile = async () => {
    setBusy(true); setFeedback(null);
    try { const result = await llmApi.test(form.id); setFeedback({ tone: result.healthy ? 'success' : 'error', message: result.healthy ? `Connection succeeded with ${result.resolvedModel || 'the configured model'}.` : result.reason || 'The provider is not healthy.' }); await load(); }
    catch (error) { setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  const selectProvider = async (id: string) => {
    setBusy(true); setFeedback(null);
    try { await llmApi.select(id); await load(); setFeedback({ tone: 'success', message: 'Provider selected.' }); }
    catch (error) { setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  const deleteProfile = async () => {
    setBusy(true); setFeedback(null);
    try { await llmApi.remove(form.id); edit(); await load(); setFeedback({ tone: 'success', message: 'Provider profile deleted.' }); }
    catch (error) { setFeedback({ tone: 'error', message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  return (
    <>
      <button
        className="linkish llm-settings-button"
        type="button"
        onClick={() => setOpen(true)}
        title={readinessTooltip}
        aria-label={`${activeLabel}. ${readinessTooltip} Open assistant provider settings.`}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h12M4 14h12M7 3v6m6 2v6" /></svg>
        <span className={`llm-readiness-dot ${readiness.state}`} aria-hidden="true" />
        <span>{activeLabel}</span>
        <span className="sr-only">{readinessLabel}</span>
      </button>
      {open && (
        <WorkbenchModal title="Assistant provider settings" onClose={() => setOpen(false)}>
          <p className="section-hint">Configure OpenCode or an API provider, test its connection, then select it for Pulse Metric Studio.</p>
          <div className="llm-settings-layout">
            <div className="llm-profile-list">
              {profiles.map(profile => { const provider = status?.providers[profile.id]; return <button key={profile.id} className={`llm-profile-card ${!choosing && form.id === profile.id ? 'active' : ''}`} type="button" onClick={() => edit(profile)}><strong>{profile.label}</strong><span>{providerAccess(profile.protocol, profile.authMode)}{status?.active === profile.id ? ' · In use' : ''}</span><span className={`llm-health ${provider?.healthy ? 'healthy' : provider?.healthy === false ? 'unhealthy' : ''}`}>{provider?.healthy ? 'Connected' : provider?.reason || 'Not tested'}</span></button>; })}
              <button className="btn" type="button" onClick={() => edit()}>Add provider</button>
            </div>
            {choosing ? <ProviderSetupChoices onChoose={choose} /> : <ProfileEditor key={editingExisting ? form.id : 'new'} form={form} setForm={(next) => { editorInitialized.current = true; setForm(next); setFormDirty(true); }} dirty={formDirty} existing={editingExisting} busy={busy} status={form.id ? status?.providers[form.id] : undefined} onSave={save} onTest={testProfile} onSelect={() => void selectProvider(form.id)} onDelete={() => void deleteProfile()} />}
          </div>
          {feedback && <div className={`llm-feedback ${feedback.tone}`} role="status">{feedback.message}</div>}
        </WorkbenchModal>
      )}
    </>
  );
}

function ProfileEditor({
  form,
  setForm,
  dirty,
  existing,
  busy,
  status,
  onSave,
  onTest,
  onSelect,
  onDelete,
}: {
  form: ProfileForm;
  setForm: (form: ProfileForm) => void;
  dirty: boolean;
  existing: boolean;
  busy: boolean;
  status?: LlmProviderStatus;
  onSave: () => Promise<void>;
  onTest: () => Promise<void>;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<LlmModelCatalogResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelRequestSequence = useRef(0);
  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => setForm({ ...form, [key]: value });
  const http = ['openai-chat', 'openai-responses', 'anthropic-messages'].includes(form.protocol);
  const opencode = form.protocol === 'opencode';
  const bedrock = form.protocol === 'bedrock-converse';
  const authUsesSecret = form.authMode === 'bearer' || form.authMode === 'x-api-key';
  const showHeaders = http || (bedrock && form.authMode === 'bearer');
  const selectedOpenCodeModelIsCurrent = isCurrentOpenCodeModel(modelCatalog?.models ?? [], form.model);
  const canSave = Boolean(
    /^[a-z0-9][a-z0-9._-]*$/i.test(form.id.trim())
    && form.label.trim()
    && (opencode ? selectedOpenCodeModelIsCurrent && !modelsLoading : form.model.trim())
    && (!http || form.baseUrl.trim()),
  );
  const modelOptions = buildOpenCodeModelOptions(modelCatalog?.models ?? [], form.model);

  const loadModels = useCallback(async () => {
    const requestSequence = ++modelRequestSequence.current;
    if (!opencode || (!existing && !form.id)) {
      setModelCatalog(null);
      setModelsError(null);
      setModelsLoading(false);
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const profileId = openCodeCatalogProfileId(existing, form.persistedProtocol, form.id);
      const catalog = await (profileId ? llmApi.models(profileId) : llmApi.setupModels(form.command));
      if (requestSequence === modelRequestSequence.current) setModelCatalog(catalog);
    } catch (error) {
      if (requestSequence === modelRequestSequence.current) setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestSequence === modelRequestSequence.current) setModelsLoading(false);
    }
  }, [existing, form.id, form.persistedProtocol, form.command, opencode]);

  useEffect(() => {
    void loadModels();
    return () => { modelRequestSequence.current += 1; };
  }, [loadModels]);

  const changeProtocol = (protocol: LlmProtocol) => {
    const clearsSensitive = protocol === 'opencode' || protocol === 'bedrock-converse';
    setForm({
      ...form,
      protocol,
      authMode: protocol === 'bedrock-converse' ? 'aws' : protocol === 'opencode' ? 'none' : 'bearer',
      baseUrl: protocol === 'opencode' ? '' : form.baseUrl,
      secret: clearsSensitive ? '' : form.secret,
      credentialCommand: clearsSensitive ? '' : form.credentialCommand,
      clearCredentialCommand: clearsSensitive ? existing && form.hasCredentialCommand : form.clearCredentialCommand,
      clearSecret: clearsSensitive && existing && form.hasSecret,
      headersText: clearsSensitive ? '{}' : form.headersText,
      headersDirty: false,
      clearHeaders: clearsSensitive && existing && hasConfiguredHeaders(form.headersText),
    });
  };
  const changeAuth = (authMode: LlmAuthMode) => setForm({
    ...form,
    authMode,
    ...((authMode === 'aws' || authMode === 'none') ? { secret: '', clearSecret: existing && form.hasSecret, credentialCommand: '', clearCredentialCommand: existing && form.hasCredentialCommand } : {}),
    ...(authMode === 'aws' ? { headersText: '{}', headersDirty: false, clearHeaders: existing && hasConfiguredHeaders(form.headersText) } : {}),
  });

  return (
    <div className="llm-profile-editor">
      <h2 className="llm-editor-heading">{providerChoice(form.protocol).label}</h2>
      <p className="section-hint">{providerDescription(form.protocol, form.authMode)}</p>
      <div className="llm-form-grid">
        <label>Display name<input value={form.label} onChange={(event) => set('label', event.target.value)} placeholder="Company gateway" /></label>
        {(http || bedrock) && <label className="full">Endpoint<input value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder="https://gateway.example.com/v1" /></label>}
        {opencode ? (
          <>
            <label>
              OpenCode model
              <select value={form.model} disabled={modelsLoading} onChange={(event) => set('model', event.target.value)}>
                <option value="" disabled>Select an OpenCode model</option>
                {modelOptions.map((option) => <option key={option.id} value={option.id} disabled={option.unavailable}>{option.label}</option>)}
              </select>
            </label>
            <div className="full llm-model-catalog-status" role="status">
              {modelsLoading ? 'Loading models from the local OpenCode catalog...' : modelsError ? `Models could not be loaded: ${modelsError}` : modelCatalog?.models.length ? `${modelCatalog.models.length} current model${modelCatalog.models.length === 1 ? '' : 's'} reported by OpenCode.` : 'OpenCode reported no current models.'}
              {!modelsLoading && <button className="btn small" type="button" onClick={() => void loadModels()}>Reload models</button>}
            </div>
          </>
        ) : <label>Model<input value={form.model} onChange={(event) => set('model', event.target.value)} placeholder="Provider model ID" /></label>}
        {(http || bedrock) && <>
            {authUsesSecret && <label>Key or token<input type="password" autoComplete="new-password" value={form.secret} disabled={form.clearSecret} onChange={(event) => setForm({ ...form, secret: event.target.value, clearSecret: false })} placeholder={usesCredentialCommand(form) ? 'Not needed - using the credential command' : existing ? 'Leave blank to keep saved secret' : 'Required by provider'} /></label>}
            {authUsesSecret && existing && form.hasSecret && !form.secret && !form.clearSecret && <p className="section-hint full">A key is saved{form.secretHint ? ` (ends ${form.secretHint})` : ''}. Leave the field blank to keep it, or type a new value to replace it.</p>}
        </>}
        {bedrock && <><label>AWS region<input value={form.region} onChange={(event) => set('region', event.target.value)} placeholder="us-east-1" /></label><label>AWS profile<input value={form.awsProfile} onChange={(event) => set('awsProfile', event.target.value)} placeholder="Optional profile" /></label></>}
        <details className="full llm-advanced"><summary>Advanced settings</summary><div className="llm-form-grid">
          <label>Profile ID<input value={form.id} disabled={existing} onChange={(event) => set('id', event.target.value)} placeholder="company-gateway" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" /></label>
          <label>Protocol<select value={form.protocol} onChange={(event) => changeProtocol(event.target.value as LlmProtocol)}><option value="opencode">OpenCode CLI</option><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="bedrock-converse">Amazon Bedrock Converse</option></select></label>
          {opencode && <label>Command<input value={form.command} onChange={(event) => set('command', event.target.value)} placeholder="opencode" /></label>}
          {(http || bedrock) && <>
            <label>Authentication<select value={form.authMode} onChange={(event) => changeAuth(event.target.value as LlmAuthMode)}>{bedrock && <option value="aws">AWS credentials</option>}<option value="bearer">Bearer token</option>{http && <option value="x-api-key">API key header</option>}{http && <option value="none">No authentication</option>}</select></label>
            {authUsesSecret && <label className="full">Credential command (optional)<input value={form.credentialCommand} disabled={form.clearCredentialCommand} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setForm({ ...form, credentialCommand: event.target.value, clearCredentialCommand: false })} placeholder={form.hasCredentialCommand && existing ? `Saved (${form.credentialCommandHint ?? 'command'}) - leave blank to keep it` : 'e.g. a CLI that prints a fresh token'} /><span className="section-hint">Run for each request; its output is used as the key or token. Use this for gateways that mint short-lived tokens. Leave blank to use a static key. The first run of a new command asks for your approval.</span></label>}
            {authUsesSecret && existing && form.hasCredentialCommand && <label className="full llm-clear-secret"><input type="checkbox" checked={form.clearCredentialCommand} onChange={(event) => setForm({ ...form, clearCredentialCommand: event.target.checked, credentialCommand: event.target.checked ? '' : form.credentialCommand })} /> Clear the saved credential command</label>}
            {showHeaders && <><label className="full">Safe custom headers<textarea rows={3} value={form.headersText} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setForm({ ...form, headersText: event.target.value, headersDirty: true, clearHeaders: false })} /></label><label className="full llm-clear-secret"><input type="checkbox" checked={form.clearHeaders} onChange={(event) => setForm({ ...form, clearHeaders: event.target.checked, headersDirty: false })} /> Clear all saved custom headers</label></>}
            <label className="full llm-clear-secret"><input type="checkbox" checked={form.allowPrivateNetwork} onChange={(event) => set('allowPrivateNetwork', event.target.checked)} /> Allow this profile to reach an approved private company gateway</label>
          </>}
        {existing && authUsesSecret && <label className="full llm-clear-secret"><input type="checkbox" checked={form.clearSecret} onChange={(event) => setForm({ ...form, clearSecret: event.target.checked, secret: event.target.checked ? '' : form.secret })} /> Clear the saved secret</label>}
        </div></details>
      </div>
      <div className="llm-editor-actions">
        <button className="btn primary" type="button" disabled={busy || !canSave} onClick={() => void onSave()}>Save profile</button>
        <button className="btn" type="button" disabled={busy || !existing || dirty} title={dirty ? 'Save profile changes before testing.' : undefined} onClick={() => void onTest()}>Test connection</button>
        <button className="btn" type="button" disabled={busy || !existing || dirty || status?.available !== true} title={dirty ? 'Save profile changes before selecting this provider.' : undefined} onClick={onSelect}>Use provider</button>
        {existing && !confirmDelete && <button className="btn danger" type="button" disabled={busy || form.source !== 'saved'} onClick={() => setConfirmDelete(true)}>Delete profile</button>}
        {confirmDelete && <><span className="section-hint warn" role="alert">Delete this saved provider profile?</span><button className="btn" type="button" onClick={() => setConfirmDelete(false)}>Cancel delete</button><button className="btn danger" type="button" disabled={busy} onClick={() => { setConfirmDelete(false); onDelete(); }}>Confirm delete</button></>}
      </div>
    </div>
  );
}
