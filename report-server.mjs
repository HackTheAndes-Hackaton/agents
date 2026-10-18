import http from 'node:http';
import { generateGrokReport } from './grok-report.mjs';
import { generateLinkExplanation } from './link-explanation.mjs';
import { resolveReportProvider } from './report-provider.mjs';

// Private Maritime /chat endpoint: model access stays inside this agent.
export function createReportServer(config = {}) {
  const providerOptions = config.reportOptions ?? {};
  const model = resolveReportProvider(providerOptions);
  const generate = config.generateReport ?? (text => generateGrokReport(text, { ...providerOptions, timeoutMs: 11000 }));
  const explain = config.generateLinkExplanation ?? (context => generateLinkExplanation(context, { ...providerOptions, timeoutMs: 11000 }));
  let running = 0;
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, {
      ok: true, role: 'reportes', provider: model.provider, model: model.model, configured: model.configured, history: false,
    });
    if (req.method !== 'POST' || req.url !== '/chat') return send(404, { error: 'Ruta no encontrada' });
    let admitted = false;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) return send(413, { error: 'La solicitud es demasiado grande' });
        chunks.push(chunk);
      }
      let input;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body?.message !== 'string' || body.message.length > 16000) throw Error();
        input = JSON.parse(body.message);
      } catch {
        return send(400, { error: 'message debe ser un incidente JSON serializado' });
      }
      if (input?.consentimiento_analisis !== true || input?.consentimiento_reporte !== true) {
        return send(403, { error: 'El reporte requiere autorización explícita de análisis y reporte' });
      }
      if (input.task === 'explain_link') {
        if (running >= 2) return send(429, {error:'reports_busy'});
        running++; admitted = true;
        const result = await explain({case_a:input.case_a,case_b:input.case_b,reasons:input.reasons});
        input.case_a.summary = ''; input.case_b.summary = '';
        return send(200, {response:JSON.stringify(result)});
      }
      if (input.task != null) return send(400, {error:'task desconocida'});
      if (typeof input.transcripcion !== 'string' || !input.transcripcion.trim() || input.transcripcion.length > 12000) {
        return send(400, { error: 'transcripcion debe contener de 1 a 12000 caracteres' });
      }
      if (running >= 2) return send(429, { error: 'reports_busy' });
      running++; admitted = true;
      const report = await generate(input.transcripcion);
      input.transcripcion = '';
      return send(200, { response: JSON.stringify(report) });
    } catch (error) {
      const code = /^(grok_|report_|link_)[a-zA-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'report_generation_failed';
      return send(502, { error: code });
    } finally { if (admitted) running--; }
  });
}
