// Catálogo editorial: fuentes comprobadas con Campus, no citas generadas por el modelo.
export const fraudSources = Object.freeze({
  lazo_rivas_2022: { titulo: 'La relación entre el extorsionador y la víctima en un caso de extorsión',
    autores: 'Lazo García y Rivas Champion', ano: 2022, idioma: 'es', tipo: 'estudio_de_caso',
    url: 'https://doi.org/10.15381/lengsoc.v21i2.22535',
    limite: 'Cinco conversaciones de un caso; no valida un clasificador ni umbrales de riesgo.' },
  sedano_2024: { titulo: 'El contexto actual e histórico de la ingeniería social',
    autores: 'Sedano Pinzón', ano: 2024, idioma: 'es', tipo: 'revision_descriptiva',
    url: 'https://doi.org/10.56712/latam.v5i5.2691',
    limite: 'Revisión conceptual; no mide detección telefónica en Perú.' },
  bde_vishing_2020: { titulo: 'Vishing: llamada telefónica no deseada',
    autores: 'Banco de España', ano: 2020, idioma: 'es', tipo: 'guia_oficial',
    url: 'https://clientebancario.bde.es/pcb/es/blog/vishing.html',
    limite: 'Guía preventiva con ejemplos; no es un estudio de precisión.' },
});

export const fraudCategories = Object.freeze({
  posible_extorsion: ['Posible extorsión', ['lazo_rivas_2022'], 'Amenaza y exigencia de pago o condición, con alerta contextual.'],
  amenaza_por_verificar: ['Amenaza por verificar', ['lazo_rivas_2022'], 'Amenaza sin elementos suficientes para clasificar una extorsión.'],
  posible_fraude_credenciales: ['Posible fraude de claves o códigos (vishing)', ['sedano_2024', 'bde_vishing_2020'], 'Petición afirmativa de credenciales y alerta contextual.'],
  credenciales_por_verificar: ['Petición de claves o códigos por verificar', ['bde_vishing_2020'], 'Petición sensible sin alerta contextual suficiente.'],
  posible_fraude_acceso_remoto: ['Posible fraude de acceso remoto', ['bde_vishing_2020'], 'Petición de control del dispositivo y alerta contextual.'],
  acceso_remoto_por_verificar: ['Acceso remoto por verificar', ['bde_vishing_2020'], 'Petición de acceso que requiere aclaración.'],
  posible_fraude_pago: ['Posible fraude de pago bajo presión', ['sedano_2024', 'bde_vishing_2020'], 'Pago combinado con presión, aislamiento o autoridad alegada y alerta contextual.'],
  peticion_economica_por_verificar: ['Petición de dinero por verificar', ['sedano_2024'], 'Un pedido económico aislado no acredita fraude.'],
  relato_o_denuncia: ['Relato o denuncia de una amenaza', ['lazo_rivas_2022'], 'Describe una amenaza recibida; no equivale a ejercerla durante la llamada.'],
  solicitud_cotidiana: ['Solicitud cotidiana', [], 'No contiene por sí sola una acción sensible.'],
});

export function principalFraudType(assessment) {
  return assessment?.modalidades?.find(m => m.interpretacion === 'hipotesis_preventiva')?.etiqueta ?? null;
}
