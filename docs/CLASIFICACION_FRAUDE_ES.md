# Tipos preventivos y fuentes en español

18 de octubre de 2026. Investigación realizada mediante el plugin Campus. Las categorías son una adaptación de ingeniería de Tiskz: ninguna fuente ha validado estos umbrales, prompts ni la precisión de la aplicación.

## Fuentes y cobertura

1. Lazo García, V., y Rivas Champion, G. (2022). La relación entre el extorsionador y la víctima en un caso de extorsión: una aproximación desde el análisis de la conversación. *Lengua y Sociedad, 21*(2), 373–400. https://doi.org/10.15381/lengsoc.v21i2.22535
   - Campus confirmó título, autores, año y DOI en Crossref. Se leyó parcialmente la copia HTML de SciELO: secciones 35–54, 85–104, 125–144 y 205–224. URL: https://www.scielo.org.pe/scielo.php?pid=S2413-26592022000200373&script=sci_arttext
   - Las secciones 209–212 describen solicitud/resistencia, amenaza/aceptación e instrucciones en cinco conversaciones de un caso. Las secciones 140–141 sitúan las amenazas y las exigencias en contexto. Las formas amistosas no acreditan legitimidad ni delito.
   - Aplicación: combinar conductas ancladas a turnos, conservar condiciones y no usar jergas o imperativos aislados como detector. Una amenaza recibida y narrada no equivale a ejercerla.
   - Límite: estudio de caso; no es un corpus representativo ni una validación de detección automática. El verificador automático de fragmentos HTML de Campus devolvió un error de formato; no se presenta como verificación automática aprobada. La correspondencia de la paráfrasis se revisó con los pasajes leídos.

2. Sedano Pinzón, J. J. (2024). El contexto actual e histórico de la ingeniería social. *LATAM Revista Latinoamericana de Ciencias Sociales y Humanidades, 5*(5). https://doi.org/10.56712/latam.v5i5.2691
   - Campus confirmó DOI, autor, año y título completo con subtítulo inglés en Crossref. Copia leída: https://dialnet.unirioja.es/descarga/articulo/9719855.pdf, páginas PDF 1–12 de 20. El título y DOI aparecen en la primera página; la página 9 describe vishing y búsqueda de datos sensibles. SHA-256: `975030a06c442578c291f31d4f79e85e6da655f5c87cdefc640420875de2adb0`.
   - Aplicación: distinguir solicitudes sensibles y supuesta representación de un simple contacto. No equiparar pedir dinero con engañar.
   - Límite: revisión descriptiva; no mide precisión ni latencia de un clasificador. Campus verificó la presencia de un fragmento en la página 9 (evidenceId `11d1b8b7c7df7d6630734f5cc5da3c4dc118f6b103293f95b756b6fc85035a82`), pero dejó el juicio semántico al cliente. Su comprobación adicional de identidad del archivo no concluyó por un error TLS; no se afirma que aprobara esa comprobación. El título, autor, año y DOI fueron contrastados directamente con la primera página leída.

3. Banco de España (2020, 24 de marzo). Vishing: llamada telefónica no deseada. https://clientebancario.bde.es/pcb/es/blog/vishing.html
   - Campus leyó las secciones HTML 50–69: la 59 describe supuesto soporte y control del dispositivo; la 60, supuesta entidad bancaria y OTP; la 66, verificación por número oficial. SHA-256 `466b725f7aa2617d7087eb172517a4e877caace6d0000adac7421cd3b4b07e42`.
   - Guía oficial, no paper ni prueba de exactitud. Complementa los estudios para definir ejemplos operativos de credenciales y acceso remoto.

## Contrato e implementación

`fraud-taxonomy.mjs` fija etiquetas, criterios y referencias. `risk-segments.mjs` combina únicamente evidencias que comprensión seleccionó y el servidor ancló a la transcripción. El modelo no inventa referencias. No hay una tercera inferencia ni consultas bibliográficas durante una llamada.

| Categoría provisional | Criterio de implementación |
| --- | --- |
| Posible extorsión | Amenaza y exigencia de pago o condición, con alerta contextual del detector. |
| Posible fraude de claves o códigos (vishing) | Petición afirmativa de credenciales con alerta contextual. |
| Posible fraude de acceso remoto | Petición de control con alerta contextual. |
| Posible fraude de pago bajo presión | Pago, presión/aislamiento/autoridad alegada y alerta contextual. |
| Conducta por verificar o relato | No se presenta como tipo de estafa; se conserva la distinción de contexto. |

`assessment.update.assessment.modalidades[]` incluye `categoria`, `etiqueta`, `interpretacion`, `evidencias`, `fuentes` y `criterio`. `risk.update.scam_type` contiene únicamente la primera hipótesis preventiva de la revisión actual; puede ser null. Una alerta puede emitirse antes de tener explicación: el corte no espera una clasificación. Sin citas suficientes se muestra tipo aún sin determinar.

La APK 0.4.9 muestra el tipo en la llamada y su detalle, junto a citas y enlaces de un catálogo fijo. Conserva esos datos en el historial existente. Actualizaciones nuevas retiran tipos anteriores para no arrastrar una acusación. La voz puede aportar `scam_type` de reportes previos: la app lo etiqueta como antecedente, separado del contenido actual, sin convertirlo en identidad o clasificación de la nueva llamada. Si esos reportes no tienen un tipo, no se inventa.

El porcentaje, la decisión de alerta, los permisos de conservación y la política de corte permanecen independientes de la modalidad. Son pruebas de integración y reglas con ejemplos ficticios; no equivalen a entrenar un modelo ni a medir sensibilidad/especificidad en llamadas reales peruanas.
