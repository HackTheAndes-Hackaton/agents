// Clasifica conductas seleccionadas y ancladas; nunca busca jergas por regex.
// No decide alertas, no autoriza cortes y no identifica a personas.
import { fraudCategories } from './fraud-taxonomy.mjs';
export function segmentRisk(evidence = [], alerted = false) {
  const byType = new Map();
  for (const e of evidence) {
    if (!byType.has(e.tipo)) byType.set(e.tipo, []);
    byType.get(e.tipo).push({ tipo: e.tipo, cita: e.cita });
  }
  const has = (...types) => types.some(t => byType.has(t));
  const out = [];
  const add = (category, types, hypothesis = false) => {
    const quotes = types.flatMap(t => byType.get(t) ?? []);
    const [etiqueta, fuentes, criterio] = fraudCategories[category];
    if (quotes.length) out.push({ categoria: category, etiqueta, fuentes, criterio,
      interpretacion: hypothesis ? 'hipotesis_preventiva' : 'conducta_por_revisar', evidencias: quotes });
  };
  if (has('amenaza')) {
    const coercion = alerted && has('peticion_pago', 'condicion');
    add(coercion ? 'posible_extorsion' : 'amenaza_por_verificar', ['amenaza', 'peticion_pago', 'condicion'], coercion);
  }
  if (has('peticion_credenciales')) add(alerted ? 'posible_fraude_credenciales' : 'credenciales_por_verificar', ['peticion_credenciales', 'autoridad_alegada', 'aislamiento'], alerted);
  if (has('acceso_remoto')) add(alerted ? 'posible_fraude_acceso_remoto' : 'acceso_remoto_por_verificar', ['acceso_remoto', 'autoridad_alegada'], alerted);
  if (has('peticion_pago') && !has('amenaza')) {
    const combined = alerted && has('presion', 'aislamiento', 'autoridad_alegada');
    add(combined ? 'posible_fraude_pago' : 'peticion_economica_por_verificar', ['peticion_pago', 'presion', 'aislamiento', 'autoridad_alegada'], combined);
  }
  if (has('relato_amenaza')) add('relato_o_denuncia', ['relato_amenaza']);
  if (has('solicitud_cotidiana')) add('solicitud_cotidiana', ['solicitud_cotidiana']);
  return out;
}
