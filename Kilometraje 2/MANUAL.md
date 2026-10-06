# Manual de la Hoja de Kilometraje

App para registrar los desplazamientos de los profesores, calcular los km con
mapas gratuitos y generar la hoja oficial en PDF con sus certificados y tickets.

Entradas: cada usuaria accede con su **email y contraseña** (la crea el
coordinador en Supabase → Authentication → Add user; el rol se pone en la tabla
`profiles`: `profesor` o `coordinador`).

## Profesora

### Mis datos
Rellena **nombre completo**, **DNI** y **dirección habitual** y pulsa
*Guardar datos*. El nombre y el DNI salen en la hoja del PDF; la dirección
queda como **origen por defecto** de los viajes nuevos (se puede cambiar).

### Nuevo viaje
1. Selecciona **Ida** o **Ida y Vuelta** (por defecto, Ida y Vuelta).
2. **Fecha**, **código de curso** y **motivo/curso** (obligatorios).
3. **🏠 Origen**, **📍 Punto intermedio (opcional)** y **🏁 Destino** con calle,
   número y pueblo (p. ej. `Calle del Monasterio del Paular, 2, Valladolid`).
   También puedes escribir **coordenadas** con el formato `latitud, longitud`
   (p. ej. `42.54663237441167, -6.592219403075277`): la aplicación las usa
   directamente y muestra la población a la que pertenecen en la tabla y el PDF.
   El punto intermedio sirve para afinar la ruta: cuenta en los km pero no
   aparece en tablas ni PDF.
4. **Observaciones** (solo se ven en la web, no salen en el PDF).
5. **Calcular km**: usa la primera ruta propuesta (prioriza autovía; si no hay,
   la más corta) y aplica el trayecto seleccionado: **Ida** usa la distancia de
   ida; **Ida y Vuelta** duplica esa distancia y la redondea. Con *Previsualizar ruta*
   la ves en el mapa antes de guardar. Con **Elegir ruta** ves las alternativas
   y escoges una (sin punto intermedio).
6. **Km manual (opcional)**: solo con autorización de la coordinadora; se marca
   en rojo en la tabla.
7. **Guardar viaje**. Con ✎ lo editas, con ⧉ lo duplicas en otra fecha y con ✕ lo borras. El botón 👁 oculta la
   línea sin eliminarla: los viajes ocultos no suman km ni euros y no salen en el PDF.
   El límite por periodo es de **950 km**: el total se marca en **amarillo** desde
   800 km, en **naranja** desde 900 km y en **rojo** al superarlo, indicando siempre
   los kilómetros que faltan. También avisa antes de generar el PDF, aunque se
   permita continuar. La coordinadora ve los mismos colores al filtrar por profesora.

### Certificados y tickets
- En **Certificados de asistencia** aparece una sola línea por código de curso en el
  periodo, aunque el curso tenga varios viajes. Arrastra en ella el certificado del
  curso. La columna 📜 de cada viaje refleja el certificado de su código.
- En **Tickets de gasolina** se suben **imágenes o PDF** del periodo: salen de uno en
  una en las páginas finales del PDF (un PDF de varias páginas ocupa una página por hoja).

### PDF y correo
- **Generar PDF**: hoja oficial del periodo + certificados + tickets.
- **Crear correo**: genera el PDF y un archivo `.eml` que al abrirlo aparece en
  Outlook con el PDF anexado, listo para enviar.
- **Agrupar por curso**: ordena la tabla como el PDF (por fecha, juntando cada
  curso con su color).

## Coordinadora

Ve **todos los viajes en directo**: aparecen solos 1–2 segundos después de que
una profesora guarde, suba un certificado o un ticket (filtra por fechas y por
nombre; solo se muestra lo que entra en el filtro).

- **Precio €/km**: se cambia y se aplica a los viajes nuevos (0,26 por defecto).
- **PDF del profesor**: elige a quién en el desplegable y genera su hoja.
- **📜 en cada fila**: abre el certificado de ese viaje en pestaña nueva.
- **📊 Resumen por profesor**: tarjetas (profesores, viajes, km, €), 4 gráficas
  (km por profesora, reparto de €, viajes por curso, km de los últimos 6 meses)
  y tabla comparativa con viajes sin certificado en rojo. Todo sigue los
  filtros de fecha y profesora de arriba.
- **🗄️ Archivar periodo**: descarga el PDF final como copia y **borra de la
  nube** los certificados y tickets de ese periodo y profesora (los viajes se
  conservan). Solo lo hace la coordinadora.

## Notas

- Los km se calculan con Nominatim/Photon + OSRM (respaldo Valhalla); el enlace
  🛣️ de cada viaje abre la ruta calculada para verificarla.
- Las fotos se comprimen al subirlas para no llenar el plan gratuito; el PDF
  de un mes normal ocupa unos 400 KB.
- Proyecto gratis de Supabase: si está días sin usarse se **pausa** y se
  reactiva entrando al panel (no se pierde nada).
