const failure = code => Object.assign(new Error(code), { code });

// Maritime supplies a token AND a base URL. Never send its token to a default provider.
export function resolveReportProvider(options = {}, env = process.env) {
  const provider = options.provider ?? env.TISKZ_REPORT_PROVIDER ?? 'xai';
  if (!['xai', 'maritime'].includes(provider)) throw failure('report_invalid_provider');
  const transport = provider === 'maritime' ? options.transport ?? env.TISKZ_REPORT_TRANSPORT ?? 'proxy' : 'proxy';
  if (!['proxy','agent'].includes(transport)) throw failure('report_invalid_transport');
  const apiKey = options.apiKey ?? (transport === 'agent' ? env.MARITIME_REPORT_API_KEY : provider === 'maritime' ? env.OPENAI_API_KEY : env.XAI_API_KEY);
  const model = options.model ?? (provider === 'maritime'
    ? env.TISKZ_REPORT_MODEL ?? 'gpt-4.1-mini'
    : env.XAI_MODEL ?? 'grok-4.7');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)) throw failure('report_invalid_model');
  if (transport === 'agent') {
    const agentId=options.agentId??env.MARITIME_REPORT_AGENT_ID;
    if (agentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) throw failure('report_invalid_agent_id');
    const endpoint=agentId?`https://api.maritime.sh/api/agents/${agentId}/chat`:undefined;
    return {provider,transport,apiKey,model,endpoint,configured:Boolean(apiKey&&endpoint)};
  }
  const configuredBase = provider === 'maritime' ? options.baseUrl ?? env.OPENAI_BASE_URL : 'https://api.x.ai/v1';
  let endpoint;
  if (configuredBase) {
    let base;
    try { base = new URL(configuredBase); } catch { throw failure('report_invalid_base_url'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw failure('report_invalid_base_url');
    endpoint = `${base.href.replace(/\/$/, '')}/chat/completions`;
  }
  return { provider, transport, apiKey, model, endpoint, configured: Boolean(apiKey && endpoint) };
}
