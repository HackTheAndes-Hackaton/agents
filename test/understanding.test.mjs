import test from 'node:test';
import assert from 'node:assert/strict';
import { groundUnderstanding, understandingSegments, groundSegmentSelection } from '../understanding.mjs';

const corrupt = 'Enrique mil soles ahora mismo o le haré daño a tu familia. No cortes la llamada.';
test('comprensión: una palabra mal transcrita nunca se convierte en identidad o hablante', () => {
  const result = groundUnderstanding({ rol: 'comprension', resumen: 'Enrique recibe la amenaza de Pedro.', participantes_mencionados: ['Enrique', 'Pedro'], datos_observados: ['Pedro llamó'], solicitudes: ['Pagar a Pedro'], incertidumbres: ['Enrique es real'], limitaciones: ['Identidad confirmada'], evidencias: [{ tipo: 'amenaza', cita: corrupt, observacion: 'Pedro amenaza a Enrique' }] }, corrupt);
  assert.equal(result.modo, 'extractivo_sin_identidades_v1');
  assert.deepEqual(result.participantes_mencionados, []);
  assert.deepEqual(result.solicitudes, []);
  assert.equal(result.evidencias[0].cita, corrupt);
  for (const text of [result.resumen, ...result.incertidumbres, ...result.limitaciones, result.evidencias[0].observacion]) assert.doesNotMatch(text, /Enrique|Pedro/);
});
test('comprensión: conserva negaciones y una presentación literal sin atribuir identidades', () => {
  const source = 'Hola, soy Ana. No necesito pagos ni datos personales.';
  const result = groundUnderstanding({ rol: 'comprension', resumen: 'Ana pide dinero', evidencias: [{ tipo: 'contexto', cita: 'Hola, soy Ana.' }, { tipo: 'negacion', cita: 'No necesito pagos ni datos personales.' }] }, source);
  assert.doesNotMatch(result.resumen, /Ana|pide dinero/);
  assert.deepEqual(result.participantes_mencionados, []);
  assert.equal(result.evidencias[1].cita, 'No necesito pagos ni datos personales.');
  assert.deepEqual(result.solicitudes, []);
});
test('comprensión: rechaza citas reconstruidas, tipos libres y respuestas sin evidencia estructurada', () => {
  for (const evidencias of [[{ tipo: 'amenaza', cita: 'Transfiere mil soles ahora mismo' }], [{ tipo: 'identidad_confirmada', cita: corrupt }], [null]]) {
    assert.throws(() => groundUnderstanding({ rol: 'comprension', evidencias }, corrupt));
  }
  assert.throws(() => groundUnderstanding({ rol: 'comprension', resumen: 'Inventado' }, corrupt));
  const result = groundUnderstanding({ rol: 'comprension', resumen: 'Pedro llamó', evidencias: [] }, corrupt);
  assert.equal(result.estado, 'informacion_insuficiente');
  assert.doesNotMatch(JSON.stringify(result), /Pedro/);
});

test('comprensión: rechaza extracción que elimina negación o contexto anterior', () => {
  for (const [source, quote] of [['No necesito pagos ni datos personales.', 'necesito pagos ni datos personales.'], ['La noticia cita una amenaza: Transfiere ahora.', 'Transfiere ahora.']]) {
    assert.throws(() => groundUnderstanding({ rol: 'comprension', evidencias: [{ tipo: 'solicitud', cita: quote }] }, source), /Evidencia sin respaldo/);
  }
});


test('comprensión Live: selecciona ids y copia negación completa aunque falte puntuación', () => {
  const text=' Hola, soy Ana. Confirmamos la reunión a las diez No necesito pagos ni datos personales. Gracias y hasta mañana';
  const segments=understandingSegments(text);
  const result=groundSegmentSelection({rol:'comprension',evidencias:[{tipo:'negacion',segmento:'s1',cita:'Necesito pagos.'}]},segments,text);
  assert.equal(result.evidencias[0].cita,'Confirmamos la reunión a las diez No necesito pagos ni datos personales.');
  assert.deepEqual(result.participantes_mencionados,[]);
  assert.doesNotMatch(result.resumen,/Ana/);
  assert.throws(()=>groundSegmentSelection({rol:'comprension',evidencias:[{tipo:'contexto',segmento:'inventado'}]},segments,text));
});

test('comprensión Live: exige ids con esquema cerrado y mantiene validación literal', async t => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const { understandIncident } = await import('../understanding.mjs');
  let request;
  const provider = http.createServer(async (req,res) => {
    let raw='';for await (const c of req) raw+=c;request=JSON.parse(raw);
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({rol:'comprension',evidencias:[{tipo:'negacion',segmento:'s0'}]})}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>new Promise(r=>provider.close(r)));
  const result=await understandIncident({transcripcion:'No necesito pagos ni datos personales',consentimiento_analisis:true},{baseUrl:`http://127.0.0.1:${provider.address().port}`,apiKey:'fake',selectSegments:true});
  assert.equal(request.response_format.type,'json_schema');assert.equal(request.response_format.json_schema.strict,true);
  assert.deepEqual(request.response_format.json_schema.schema.properties.evidencias.items.properties.segmento.enum,['s0']);
  assert.equal(request.response_format.json_schema.schema.properties.evidencias.items.properties.tipos.type, 'array');
  assert.equal(result.evidencias[0].cita,'No necesito pagos ni datos personales');
});

test('un segmento conserva amenaza, pago y condición como conductas distintas sin inventar texto', () => {
  const text = 'Transfiere quinientos soles o le haré daño a tu familia.';
  const segments = understandingSegments(text);
  const r = groundSegmentSelection({rol:'comprension',evidencias:[{segmento:'s0',tipos:['amenaza','peticion_pago','condicion']}]},segments,text);
  assert.deepEqual(r.evidencias.map(e=>e.tipo),['amenaza','peticion_pago','condicion']);
  assert.ok(r.evidencias.every(e=>e.cita===text));
  assert.throws(()=>groundSegmentSelection({rol:'comprension',evidencias:[{segmento:'s0',tipos:['amenaza','amenaza']}]},segments,text));
  assert.throws(()=>groundSegmentSelection({rol:'comprension',evidencias:[{segmento:'s0',tipos:['identidad_verificada']}]},segments,text));
});
