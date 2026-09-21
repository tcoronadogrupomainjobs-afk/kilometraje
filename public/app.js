/* App Cloudflare Pages + Supabase. Sin servidor propio.
   Mapas gratuitos: Nominatim (calle y nº -> coords) + OSRM (ruta).
   PDF en el navegador con jsPDF, replica la HojaKm modelo. */
const TIENE_SUPABASE = !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY
  && !String(window.SUPABASE_URL).includes("TU-PROYECTO")
  && typeof supabase !== "undefined");
let sb = TIENE_SUPABASE ? supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;
if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
// DEMO local: sin Supabase ni usuarios. Viajes en localStorage, calculo y PDF reales.
let DEMO = !TIENE_SUPABASE || localStorage.getItem("km_demo") === "1";
const DEMO_KEY = "km_viajes_demo";
const demoLeer = () => { try { return JSON.parse(localStorage.getItem(DEMO_KEY) || "null"); } catch { return null; } };
const demoGuardar = v => localStorage.setItem(DEMO_KEY, JSON.stringify(v));
function demoSeed() {
  let v = demoLeer();
  if (!v) {
    const ym = hoyISO().slice(0, 7);
    v = [
      { id: 1, fecha: ym + "-03", origen: "Noviercas", destino: "Los Rábanos", km: 104, motivo_codigo: "68383", motivo_curso: "OLIMPIADAS", precio_km: 0.26, total: 27.04, ruta_url: "https://www.openstreetmap.org/directions?from=41.71186,-2.03410&to=41.71800,-2.47663", proveedor: "Nominatim+OSRM" },
      { id: 2, fecha: ym + "-04", origen: "Noviercas", destino: "Velilla de la Sierra", km: 86, motivo_codigo: "68384", motivo_curso: "VIDEOJUEGOS", precio_km: 0.26, total: 22.36, ruta_url: "https://www.openstreetmap.org/directions?from=41.71186,-2.03410&to=41.80921,-2.40144", proveedor: "Nominatim+OSRM" },
    ];
    demoGuardar(v);
  } else {
    // Migracion suave: viajes de ejemplo antiguos sin enlace de ruta
    let cambio = false;
    v.forEach(x => {
      if (x.id === 1 && !x.ruta_url) { x.ruta_url = "https://www.openstreetmap.org/directions?from=41.71186,-2.03410&to=41.71800,-2.47663"; x.proveedor = "Nominatim+OSRM"; cambio = true; }
      if (x.id === 2 && !x.ruta_url) { x.ruta_url = "https://www.openstreetmap.org/directions?from=41.71186,-2.03410&to=41.80921,-2.40144"; x.proveedor = "Nominatim+OSRM"; cambio = true; }
    });
    if (cambio) demoGuardar(v);
  }
  return v;
}
const demoFiltrarRango = (desde, hasta) => demoSeed().filter(v => v.fecha >= desde && v.fecha <= hasta).sort((a, b) => a.fecha.localeCompare(b.fecha));
let perfil = null, precioKm = 0.26, ultimoCalculo = null, editandoId = null;
const $ = id => document.getElementById(id);
const fmtES = n => n.toFixed(2).replace(".", ",") + " €";
// Rango de fechas de la hoja (por defecto, mes natural en curso)
const hoyISO = () => new Date().toISOString().slice(0, 10);
const primerDia = () => hoyISO().slice(0, 7) + "-01";
const ultimoDia = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10); };
const rangoProf = () => ({ desde: $("desde-prof").value || primerDia(), hasta: $("hasta-prof").value || ultimoDia() });
const rangoCoord = () => ({ desde: $("desde-coord").value || primerDia(), hasta: $("hasta-coord").value || ultimoDia() });
const fmtFecha = iso => String(iso || "").split("-").reverse().join("/");

/* ---------- mapas ---------- */
/* ---------- mapas (proveedores gratuitos, sin clave, con respaldo) ----------
   Geocodifica: Nominatim -> Photon. Ruta: OSRM -> Valhalla.
   Se usa el primero que responda; se indica cual calculo cada viaje. */
const PROVINCIAS = ["alava","araba","albacete","alicante","alacant","almeria","asturias","avila","badajoz","baleares","balears","barcelona","burgos","caceres","cadiz","cantabria","castellon","castello","ceuta","ciudad real","cordoba","coruña","a coruña","cuenca","gerona","girona","granada","guadalajara","guipuzcoa","gipuzkoa","huelva","huesca","jaen","leon","lerida","lleida","lugo","madrid","malaga","melilla","murcia","navarra","orense","ourense","palencia","palmas","las palmas","pontevedra","rioja","la rioja","salamanca","tenerife","santa cruz de tenerife","segovia","sevilla","soria","tarragona","teruel","toledo","valencia","valladolid","vizcaya","bizkaia","zamora","zaragoza"];
const esProvincia = t => PROVINCIAS.includes(norm(t));
/* "Calle Mayor 1, Geras (León)" -> calle/localidad/provincia.
   "Ayuntamiento, Geras, León" -> calle "Ayuntamiento", localidad "Geras". */
function partirDireccion(dir) {
  const partes = String(dir).split(",").map(s => s.trim()).filter(Boolean);
  if (partes.length <= 1) {
    // Una sola palabra: casi siempre es la poblacion ("Valladolid"), no una calle.
    // (Si lleva numero, probablemente sea calle sin pueblo: se busca como calle.)
    const t = dir.trim();
    const m1 = t.match(/^(.*?)\(([^)]+)\)\s*$/);
    if (m1) return { calle: "", localidad: (m1[1].trim() || t), provincia: m1[2].trim() };
    if (/\d/.test(t)) return { calle: t, localidad: "", provincia: "" };
    return { calle: "", localidad: t, provincia: "" };
  }
  const tail = partes[partes.length - 1], pre = partes.length > 2 ? partes[partes.length - 2] : "";
  let localidad = tail, provincia = "";
  const m = tail.match(/^(.*?)\(([^)]+)\)\s*$/);
  if (m) {
    const fuera = m[1].trim(), dentro = m[2].trim();
    if (esProvincia(dentro)) { provincia = dentro; localidad = fuera || pre; }
    else if (esProvincia(fuera)) { provincia = fuera; localidad = dentro; }
    else localidad = fuera || dentro;
  } else if (pre && esProvincia(tail)) {
    if (/^\d+\s*[a-zA-Z°ºª]*$/.test(pre)) {
      // "Calle del Monasterio del Paular, 2, Valladolid": el 2 es el portal
      // y Valladolid la localidad (no la provincia como tal)
      provincia = tail; localidad = tail;
    } else { provincia = tail; localidad = pre; }
  }
  const quitar = (provincia && localidad === pre && pre) ? 2 : 1;
  const calle = partes.slice(0, partes.length - quitar).join(", ");
  return { calle, localidad, provincia };
}
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function localidadDeAddress(ad) {
  ad = ad || {};
  return ad.village || ad.town || ad.city || ad.municipality || ad.hamlet || ad.suburb || "";
}
// ¿El candidato está realmente en la localidad pedida? ("geras" debe aparecer en el resultado)
function casaConLocalidad(display, address, localidad) {
  if (!localidad) return true;
  const palabras = norm(localidad).split(/[^a-z]+/).filter(w => w.length > 2);
  if (!palabras.length) return true;
  const hay = norm(display + " " + Object.values(address || {}).join(" "));
  return palabras.some(w => hay.includes(w));
}
function elegirCandidato(candidatos, localidad) {
  return candidatos.find(c => casaConLocalidad(c.display, c.address, localidad)) || null;
}
async function geocode(dir) {
  const { calle, localidad, provincia } = partirDireccion(dir);
  const base = { format: "jsonv2", addressdetails: "1", limit: "5", countrycodes: "es" };
  const qOf = p => fetch("https://nominatim.openstreetmap.org/search?" + new URLSearchParams(p), { headers: { "Accept": "application/json" } });
  let cands = [];
  try {
    // 1) Estructurada: calle + pueblo (+ provincia) — la mas precisa
    const p1 = { ...base };
    if (calle) p1.street = calle;
    if (localidad) p1.city = localidad;
    if (provincia) p1.state = provincia;
    p1.country = "España";
    const r1 = await qOf(p1);
    if (r1.ok) cands = (await r1.json()).map(d => ({ display: d.display_name, address: d.address || {}, lat: +d.lat, lon: +d.lon }));
    // 1b) Solo el pueblo (centro): por si el punto exacto no existe en el mapa
    // (ej. el ayuntamiento de un pueblo pequeño). Es preferible al pueblo equivocado.
    if (localidad && !elegirCandidato(cands, localidad)) {
      const p1b = { ...base };
      p1b.city = localidad;
      if (provincia) p1b.state = provincia;
      p1b.country = "España";
      const r1b = await qOf(p1b);
      if (r1b.ok) cands = cands.concat((await r1b.json()).map(d => ({ display: d.display_name, address: d.address || {}, lat: +d.lat, lon: +d.lon })));
    }
    // 2) Texto libre como respaldo
    if (!elegirCandidato(cands, localidad)) {
      const r2 = await qOf({ ...base, q: dir.trim() + (/españa/i.test(dir) ? "" : ", España") });
      if (r2.ok) cands = cands.concat((await r2.json()).map(d => ({ display: d.display_name, address: d.address || {}, lat: +d.lat, lon: +d.lon })));
    }
  } catch { /* cae al Photon de abajo */ }
  let c = elegirCandidato(cands, localidad);
  let geoCon = "Nominatim", dudoso = false;
  if (!c && cands.length) { c = cands[0]; dudoso = !!localidad; } // nada en la localidad: avisa
  if (!c) {
    // 3) Respaldo: Photon (Komoot, datos OSM, sin clave; sin lang: con lang=es devuelve vacio)
    const u = "https://photon.komoot.io/api/?q=" + encodeURIComponent(dir.trim() + (/españa/i.test(dir) ? "" : ", España")) + "&limit=5";
    const r = await fetch(u, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("No se encontró: " + dir);
    const feats = ((await r.json()).features || []).filter(x => (x.properties || {}).countrycode === "ES");
    const lista = feats.map(f => {
      const p = f.properties || {};
      return { display: [p.name, p.street, p.city || p.town || p.village || p.county].filter(Boolean).join(", "), address: p, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    });
    c = elegirCandidato(lista, localidad) || lista[0];
    geoCon = "Photon";
    if (!c) throw new Error("No se encontró: " + dir);
    dudoso = !casaConLocalidad(c.display, c.address, localidad);
  }
  const loc = localidadDeAddress(c.address) || extraerLocalidadInput(dir);
  return { lat: c.lat, lon: c.lon, nombre: c.display, loc, geoCon, dudoso };
}
async function rutaOSRM(a, b, mid) {
  const tramo = mid ? `${a.lon},${a.lat};${mid.lon},${mid.lat};${b.lon},${b.lat}` : `${a.lon},${a.lat};${b.lon},${b.lat}`;
  const u = `https://router.project-osrm.org/route/v1/driving/${tramo}?overview=full&geometries=geojson&alternatives=${mid ? "false" : "3"}&steps=false`;
  const r = await fetch(u);
  if (!r.ok) throw new Error("OSRM " + r.status);
  const d = await r.json();
  if (d.code !== "Ok" || !d.routes?.length) throw new Error("OSRM sin ruta");
  const primera = d.routes[0];
  const op = r => {
    // punto intermedio del trazado para previsualizar ESTA opcion en el mapa
    let via = null;
    const pts = (r.geometry && r.geometry.coordinates) || [];
    if (pts.length > 10) { const m = pts[Math.floor(pts.length / 2)]; via = [+m[1].toFixed(5), +m[0].toFixed(5)]; }
    return { kmIda: +(r.distance / 1000).toFixed(1), kmIV: Math.round(r.distance / 1000 * 2), min: Math.round((r.duration || 0) / 60), via };
  };
  return { kmIda: primera.distance / 1000, alts: d.routes.map(x => Math.round(x.distance / 1000 * 2)), opciones: d.routes.map(op) };
}
// Enlace para abrir una opcion concreta en pantalla (via = punto de su trazado;
// mid = parada intermedia real pedida por el profesor, tiene prioridad)
function urlOpcion(a, b, o, mid) {
  if (mid) return `https://www.google.com/maps/dir/?api=1&origin=${a.lat.toFixed(5)},${a.lon.toFixed(5)}&destination=${b.lat.toFixed(5)},${b.lon.toFixed(5)}&waypoints=${mid.lat.toFixed(5)},${mid.lon.toFixed(5)}&travelmode=driving`;
  if (o && o.via) return `https://www.google.com/maps/dir/?api=1&origin=${a.lat.toFixed(5)},${a.lon.toFixed(5)}&destination=${b.lat.toFixed(5)},${b.lon.toFixed(5)}&waypoints=${o.via[0]},${o.via[1]}&travelmode=driving`;
  return `https://www.openstreetmap.org/directions?from=${a.lat.toFixed(5)},${a.lon.toFixed(5)}&to=${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
}
async function rutaValhalla(a, b, mid) {
  // Respaldo: Valhalla (FOSSGIS, sin clave). costing auto = prioriza vias rapidas.
  const locations = mid ? [{ lat: a.lat, lon: a.lon }, { lat: mid.lat, lon: mid.lon }, { lat: b.lat, lon: b.lon }] : [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }];
  const r = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locations, costing: "auto" }),
  });
  if (!r.ok) throw new Error("Valhalla " + r.status);
  const d = await r.json();
  const km = d?.trip?.summary?.length;
  if (typeof km !== "number") throw new Error("Valhalla sin ruta");
  const min = Math.round(((d.trip.summary || {}).time || 0) / 60);
  return { kmIda: km, alts: [Math.round(km * 2)], opciones: [{ kmIda: +km.toFixed(1), kmIV: Math.round(km * 2), min }] };
}
// Localidad para la tabla a partir del texto (km manual): usa el parseo
// calle/pueblo/provincia y solo como ultimo recurso el texto tras la ultima coma.
// Un número suelto nunca es localidad válida (ej. el portal de "Calle X, 2").
const esLocalidadValida = s => !!s && !/^\d+\s*[a-zA-Z°ºª]*$/.test(String(s).trim());
function localidadDeTexto(input) {
  const p = partirDireccion(input);
  const limpio = (p.localidad || "").replace(/\(.*?\)/g, "").trim();
  if (limpio && !esProvincia(limpio) && esLocalidadValida(limpio)) return limpio;
  if (p.provincia) return p.provincia;
  const ultimo = extraerLocalidadInput(input);
  return esLocalidadValida(ultimo) ? ultimo : String(input).trim();
}
// Sin geocodificar (km manual): la localidad es lo que va tras la ultima coma
// ("Calle Mayor 1, Noviercas" -> "Noviercas"). En tabla y PDF solo sale la localidad.
function extraerLocalidadInput(t) {
  const partes = String(t).split(",").map(s => s.trim()).filter(Boolean);
  let loc = partes.length > 1 ? partes[partes.length - 1] : (partes[0] || t);
  return loc.replace(/\(.*?\)/g, "").trim() || t.trim();
}
async function calcularKm(origen, destino, viaTexto) {
  const a = await geocode(origen), b = await geocode(destino);
  const viaLimpia = String(viaTexto || "").trim();
  const m = viaLimpia ? await geocode(viaLimpia) : null;
  let ruta, motor;
  try { ruta = await rutaOSRM(a, b, m); motor = "OSRM"; }
  catch { ruta = await rutaValhalla(a, b, m); motor = "Valhalla"; }
  // Criterio: primera ruta propuesta (prioriza autovia); si no hay autovia es la mas corta.
  // Con parada intermedia el profesor impone el trazado: se calcula pasando por ella.
  const kmIda = ruta.kmIda;
  const kmIV = Math.round(kmIda * 2);
  // Enlace verificable a la ruta calculada (Google Maps con punto del trazado; OSM si no hay)
  const url = urlOpcion(a, b, (ruta.opciones || [])[0], m);
  return { kmIda: +kmIda.toFixed(1), kmIV, alts: ruta.alts, opciones: ruta.opciones || [{ kmIda: +kmIda.toFixed(1), kmIV, min: 0 }], oLat: a.lat, oLon: a.lon, dLat: b.lat, dLon: b.lon, aGeo: a.nombre.slice(0, 90), bGeo: b.nombre.slice(0, 90), locO: a.loc, locD: b.loc, url, proveedor: `${a.geoCon}+${motor}`, dudoso: a.dudoso || b.dudoso || (m ? m.dudoso : false),
    viaInput: viaLimpia, locV: m ? m.loc : "", viaGeo: m ? m.nombre.slice(0, 90) : "", vLat: m ? m.lat : null, vLon: m ? m.lon : null };
}

/* ---------- auth ---------- */
$("btn-login").onclick = async () => {
  if (DEMO || !sb) { entrarDemo(); return; }
  $("login-err").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("pass").value });
  if (error) { $("login-err").textContent = error.message; return; }
  await arrancarUnaVez();
};
$("btn-salir-demo").onclick = () => { localStorage.removeItem("km_demo"); DEMO = !TIENE_SUPABASE ? true : false; location.reload(); };
function entrarDemo() {
  DEMO = true;
  const guardado = (() => { try { return JSON.parse(localStorage.getItem("km_perfil_demo") || "null"); } catch { return null; } })();
  perfil = { id: "demo", nombre: "ADELA RUIZ LAVILLA", nif: "72896446Q", domicilio: "", categoria: "PROFESOR TITULAR", proyecto: "CYL DIGITAL", rol: "profesor", ...(guardado || {}) };
  precioKm = parseFloat((localStorage.getItem("km_precio") || "0.26").replace(",", ".")) || 0.26;
  demoSeed();
  $("v-login").hidden = true;
  $("demo-banner").hidden = false;
  $("sesion").innerHTML = `${perfil.nombre} (demo local) <button id="out">Salir</button>`;
  $("out").onclick = () => { localStorage.removeItem("km_demo"); location.reload(); };
  // En demo se muestran los dos paneles: pruebas como profesora y como coordinadora
  $("v-prof").hidden = false; $("v-coord").hidden = false;
  $("desde-prof").value = primerDia(); $("hasta-prof").value = ultimoDia(); $("f-fecha").valueAsDate = new Date();
  if ($("prof-nombre")) $("prof-nombre").textContent = perfil.nombre;
  cargarDatos();
  $("desde-coord").value = primerDia(); $("hasta-coord").value = ultimoDia(); $("precio").value = String(precioKm).replace(".", ",");
  $("pdf-user").innerHTML = `<option value="demo">${perfil.nombre}</option>`;
  $("btn-ver").onclick = cargarCoord; $("filtro-prof").onchange = cargarCoord; $("desde-coord").onchange = cargarCoord; $("hasta-coord").onchange = cargarCoord;
  $("btn-precio").onclick = () => { precioKm = parseFloat($("precio").value.replace(",", ".")) || 0.26; localStorage.setItem("km_precio", String(precioKm)); alert("Precio demo: " + precioKm.toFixed(2) + " €/km"); };
  $("btn-pdf-coord").onclick = async () => {
    const { desde, hasta } = rangoCoord();
    const v = demoFiltrarRango(desde, hasta);
    if (!v.length) { alert("Sin viajes en ese periodo."); return; }
    const certs = await listarCerts(v);
    const sin = faltanCerts(v, certs);
    if (sin.length && !confirm(`Hay ${sin.length} viaje(s) sin certificado de asistencia. ¿Generar el PDF igualmente?`)) return;
    await pdfHoja(perfil, v, { desde, hasta }, { certs, tickets: await listarTickets(desde, hasta) });
  };
  cargarProf(); cargarCoord();
}
async function arrancar() {
  DEMO = false;
  $("demo-banner").hidden = true;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const { data } = await sb.from("profiles").select("*").eq("id", user.id).single();
  perfil = data;
  const s = await sb.from("settings").select("*").eq("clave", "precio_km").single();
  if (s.data) precioKm = parseFloat(s.data.valor);
  $("v-login").hidden = true;
  $("sesion").innerHTML = `${perfil.nombre || user.email} (${perfil.rol}) <button id="out">Salir</button>`;
  $("out").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  if (perfil.rol === "coordinador") { $("v-coord").hidden = false; initCoord(); }
  else { $("v-prof").hidden = false; $("desde-prof").value = primerDia(); $("hasta-prof").value = ultimoDia(); $("f-fecha").valueAsDate = new Date(); if ($("prof-nombre")) $("prof-nombre").textContent = perfil.nombre || ""; cargarDatos(); cargarProf(); }
}
if (sb) sb.auth.onAuthStateChange((_e, s) => { if (s?.user && !perfil && !DEMO) arrancarUnaVez(); });
// Un solo arranque en vuelo: al recargar, la sesión inicial y la llamada
// directa competían y pintaban la tabla dos veces
let arranqueEnCurso = null;
function arrancarUnaVez() {
  if (!arranqueEnCurso) arranqueEnCurso = arrancar().finally(() => arranqueEnCurso = null);
  return arranqueEnCurso;
}

/* ---------- profesor ---------- */
// Si dos cargas coinciden (doble arranque al recargar), solo la última pinta
let turnoProf = 0, turnoCoord = 0, turnoTick = 0, turnoCert = 0;
async function cargarProf() {
  const turno = ++turnoProf;
  const { desde, hasta } = rangoProf();
  let data;
  if (DEMO) data = demoFiltrarRango(desde, hasta);
  else {
    const r = await sb.from("viajes").select("*")
      .gte("fecha", desde).lte("fecha", hasta).order("fecha");
    data = r.data;
  }
  const tb = $("t-prof").querySelector("tbody"); tb.innerHTML = "";
  let tot = 0;
  data = agrupProf ? ordenarComoPdf(data) : (data || []).sort(compararViajes(ordenProf.campo, ordenProf.dir));
  const colores = mapaColoresCursos(data);
  // Referencia por viaje: 📜 certificado de asistencia
  const idsProf = (data || []).map(v => v.id);
  const certMap = {};
  if (idsProf.length) {
    const listaC = DEMO ? leerCertsArray().filter(c => idsProf.map(String).includes(String(c.viaje_id)))
      : ((await sb.from("certificados").select("viaje_id,nombre").in("viaje_id", idsProf)).data || []);
    listaC.forEach(c => certMap[String(c.viaje_id)] = c.nombre);
  }
  if (turno !== turnoProf) return; // una carga más reciente tomó el relevo
  const celdaC = v => certMap[String(v.id)] ? `<td class="st ok" title="${esc(certMap[String(v.id)])}">✅</td>` : `<td class="st no" title="Sin certificado de asistencia">❌</td>`;
  (data || []).forEach(v => {
    tot += +v.total;
    tb.innerHTML += `<tr style="background:${colores[claveCurso(v)]}"><td>${v.fecha.split("-").reverse().join("/")}</td>
      <td title="${esc(tituloRuta(v))}">${esc(textoRuta(v))}${iconoRuta(v)}</td><td${v.manual ? ' class="km-manual" title="Km manual — autorizado por coordinadora"' : ""}>${v.km}</td>
      <td>${String(v.precio_km).replace(".", ",")} €</td><td>${fmtES(+v.total)}</td>
      ${celdaRecorte((v.motivo_codigo ? v.motivo_codigo + " - " : "") + v.motivo_curso)}
      ${celdaObs(v)}
      ${celdaC(v)}
      <td><button class="ibtn" data-edit="${v.id}" title="Editar">✎</button> <button class="ibtn danger" data-del="${v.id}" title="Borrar">✕</button></td></tr>`;
  });
  $("total-prof").textContent = "Total: " + fmtES(tot);
  tb.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => entrarEdicion(b.dataset.edit));
  renderTickets(); // miniaturas del periodo (también al cambiar fechas)
  renderCerts(data || []); // una linea por viaje para anexar su certificado
  $("total-prof").textContent = "Total: " + fmtES(tot);
  tb.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (!confirm("¿Borrar este viaje? Sus tickets pasan a 'general del periodo'.")) return;
    if (DEMO) {
      demoGuardar(demoSeed().filter(v => String(v.id) !== String(b.dataset.del)));
      const arr = leerTicketsArray();
      arr.forEach(t => { if (String(t.viaje_id) === String(b.dataset.del)) t.viaje_id = null; });
      guardarTicketsArray(arr);
      guardarCertsArray(leerCertsArray().filter(c => String(c.viaje_id) !== String(b.dataset.del)));
    } else {
      await sb.from("tickets").update({ viaje_id: null }).eq("viaje_id", b.dataset.del);
      const { data: certDel } = await sb.from("certificados").select("*").eq("viaje_id", b.dataset.del);
      for (const c of (certDel || [])) { await sb.storage.from("certificados").remove([c.path]); await sb.from("certificados").delete().eq("id", c.id); }
      await sb.from("viajes").delete().eq("id", b.dataset.del);
    }
    salirEdicion(); cargarProf(); if (!$("v-coord").hidden) cargarCoord();
  });
  marcarRecortes(tb);
}
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
/* Celdas recortadas a una linea (Motivo y Observaciones): boton mas/menos muestra el texto completo */
function celdaRecorte(t) {
  t = esc(t || "");
  if (!t) return `<td class="rec"></td>`;
  return `<td class="rec" title="${t}"><span class="rec-wrap"><span class="rec-txt">${t}</span><button class="rec-mas" type="button" title="Ver texto completo">más</button></span></td>`;
}
function celdaObs(v) {
  return celdaRecorte(v.observaciones);
}
document.addEventListener("click", e => {
  const b = e.target && e.target.closest ? e.target.closest(".rec-mas") : null;
  if (!b) return;
  const td = b.closest("td.rec");
  if (!td) return;
  const abierto = td.classList.toggle("abierto");
  b.textContent = abierto ? "menos" : "más";
  if (!abierto) marcarRecortes(td);
});
/* Muestra el boton mas solo donde el texto desborda la columna */
function marcarRecortes(raiz) {
  const base = raiz || document;
  const celdas = Array.from(base.querySelectorAll("td.rec"));
  if (base.matches && base.matches("td.rec")) celdas.push(base);
  celdas.forEach(td => {
    if (td.classList.contains("abierto")) { td.classList.add("con-mas"); return; }
    const txt = td.querySelector(".rec-txt");
    if (!txt) return;
    td.classList.toggle("con-mas", txt.scrollWidth > txt.clientWidth + 1);
  });
}
let tmRecortes = null;
window.addEventListener("resize", () => {
  clearTimeout(tmRecortes);
  tmRecortes = setTimeout(() => marcarRecortes(document), 200);
});
/* Orden de las tablas web: clic en Fecha o Motivo (repite para invertir) */
let ordenProf = { campo: "fecha", dir: 1 };
let ordenCoord = { campo: "fecha", dir: 1 };
function compararViajes(campo, dir) {
  return (a, b) => {
    let r;
    if (campo === "motivo")
      r = String(a.motivo_codigo || "").localeCompare(String(b.motivo_codigo || ""), "es")
        || String(a.motivo_curso || "").localeCompare(String(b.motivo_curso || ""), "es")
        || String(a.fecha).localeCompare(String(b.fecha));
    else r = String(a.fecha).localeCompare(String(b.fecha));
    return r * dir;
  };
}
function pintarOrden() {
  const items = [
    ["th-fecha-prof", "Fecha", agrupProf ? null : ordenProf, "fecha"],
    ["th-motivo-prof", "Motivo", agrupProf ? null : ordenProf, "motivo"],
    ["th-fecha-coord", "Fecha", agrupCoord ? null : ordenCoord, "fecha"],
    ["th-motivo-coord", "Motivo", agrupCoord ? null : ordenCoord, "motivo"],
  ];
  items.forEach(([id, etiqueta, est, campo]) => {
    const el = $(id); if (!el) return;
    el.innerHTML = etiqueta + (est && est.campo === campo ? (est.dir === 1 ? " ▲" : " ▼") : "");
  });
}
/* Criterio del PDF: por fecha juntando cada curso donde cae su primer viaje */
const claveCurso = v => `${v.motivo_codigo || ""}|${v.motivo_curso || ""}`;
function ordenarComoPdf(viajes) {
  const primera = {};
  (viajes || []).forEach(v => { const k = claveCurso(v); if (!primera[k] || String(v.fecha) < primera[k]) primera[k] = String(v.fecha); });
  return [...(viajes || [])].sort((a, b) =>
    String(primera[claveCurso(a)]).localeCompare(String(primera[claveCurso(b)])) ||
    String(a.fecha).localeCompare(String(b.fecha)));
}
// Mismo color por curso que en el PDF (pasteles RGB -> CSS)
const BANDAS_CSS = ["#dfeffb", "#e4dff1", "#f1dde6", "#fdecd5", "#e0efdc", "#fff5d0", "#e0efef", "#f0e4f0"];
function mapaColoresCursos(viajes) {
  const primera = {};
  (viajes || []).forEach(v => { const k = claveCurso(v); if (!primera[k] || String(v.fecha) < primera[k]) primera[k] = String(v.fecha); });
  const claves = [...new Set((viajes || []).map(claveCurso))].sort((a, b) => String(primera[a]).localeCompare(String(primera[b])));
  const mapa = {};
  claves.forEach((k, i) => mapa[k] = BANDAS_CSS[i % BANDAS_CSS.length]);
  return mapa;
}
let agrupProf = false, agrupCoord = false;
function syncAgrup() {
  $("btn-agrup-prof").classList.toggle("on", agrupProf);
  $("btn-agrup-coord").classList.toggle("on", agrupCoord);
  pintarOrden();
}
function alternarOrden(est, campo, recargar) {
  if (est.campo === campo) est.dir *= -1; else { est.campo = campo; est.dir = 1; }
  pintarOrden(); recargar();
}
$("th-fecha-prof").onclick = () => { agrupProf = false; syncAgrup(); alternarOrden(ordenProf, "fecha", cargarProf); };
$("th-motivo-prof").onclick = () => { agrupProf = false; syncAgrup(); alternarOrden(ordenProf, "motivo", cargarProf); };
$("th-fecha-coord").onclick = () => { agrupCoord = false; syncAgrup(); alternarOrden(ordenCoord, "fecha", cargarCoord); };
$("th-motivo-coord").onclick = () => { agrupCoord = false; syncAgrup(); alternarOrden(ordenCoord, "motivo", cargarCoord); };
$("btn-agrup-prof").onclick = () => { agrupProf = !agrupProf; syncAgrup(); cargarProf(); };
$("btn-agrup-coord").onclick = () => { agrupCoord = !agrupCoord; syncAgrup(); cargarCoord(); };
pintarOrden();
// Poblaciones con primera letra en mayuscula ("Velilla de la Sierra"),
// respetando preposiciones/articulos en minuscula. El PDF sigue en mayusculas como el modelo.
const MINUS = ["de", "del", "la", "las", "el", "los", "y", "e", "en", "al", "a", "o", "u", "por", "con", "sin", "sobre", "tras", "ante", "bajo", "entre", "hacia", "hasta", "para", "segun", "durante"];
const cap = s => String(s ?? "").toLowerCase().split(/(\s+|[-–—'])/).map((w, i) => {
  if (!w || /^\s+$/.test(w) || /^[-–—']$/.test(w)) return w;
  if (i > 0 && MINUS.includes(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1);
}).join("");
// Enlace a la ruta calculada (OpenStreetMap) para verificarla
const iconoRuta = v => v.ruta_url ? ` <a href="${esc(v.ruta_url)}" target="_blank" rel="noopener" title="Ver ruta calculada en el mapa${v.proveedor && v.proveedor !== "manual" ? " (" + esc(v.proveedor) + ")" : ""}">🛣️</a>` : "";
// En las tablas web solo se muestra Origen → Destino (el punto intermedio
// no aparece, aunque sí cuenta en los km, el enlace de ruta y el PDF)
const textoRuta = v => `${cap(v.origen)} → ${cap(v.destino)}`;
// El punto intermedio no se muestra: solo Origen - Destino (sí cuenta en los km,
// el enlace de ruta y los datos guardados)
const textoRutaPDF = v => `${cap(v.origen)} - ${cap(v.destino)}`;
const tituloRuta = v => [v.origen_geo, v.destino_geo].filter(x => x).join(" → ") || `${v.origen || ""} → ${v.destino || ""}`;

$("desde-prof").onchange = cargarProf; $("hasta-prof").onchange = cargarProf;
// Clave para saber si el calculo guardado corresponde a las direcciones actuales
const claveRuta = () => $("f-origen").value.trim() + "|" + $("f-via").value.trim() + "|" + $("f-destino").value.trim();
// Punto intermedio real (si el calculo lo trae) para los enlaces al mapa
const midDe = b => (b && b.vLat != null && b.vLon != null) ? { lat: b.vLat, lon: b.vLon } : null;
$("btn-calc").onclick = async () => {
  $("calc-info").textContent = "Calculando…";
  try {
    ultimoCalculo = await calcularKm($("f-origen").value, $("f-destino").value, $("f-via").value);
    ultimoCalculo._k = claveRuta();
    $("calc-info").textContent = `Calculado con ${ultimoCalculo.proveedor}: ${ultimoCalculo.kmIda} km ida → ${ultimoCalculo.kmIV} km ida-vuelta (${fmtES(ultimoCalculo.kmIV * precioKm)}). Alternativas: ${ultimoCalculo.alts.join(" / ")} km.`
      + ` Origen entendido como: ${ultimoCalculo.aGeo} | Destino: ${ultimoCalculo.bGeo}`
      + (ultimoCalculo.locV ? ` | Vía: ${ultimoCalculo.viaGeo}` : "")
      + (ultimoCalculo.dudoso ? " ⚠ Revisa: no se encontró exactamente en la localidad indicada; precisa más (nº, pueblo, provincia)." : "");
    const ver = document.createElement("a"); // previsualizar la ruta antes de guardar
    ver.href = ultimoCalculo.url; ver.target = "_blank"; ver.rel = "noopener";
    ver.textContent = " 🛣️ Previsualizar ruta";
    $("calc-info").appendChild(document.createTextNode(" "));
    $("calc-info").appendChild(ver);
  } catch (e) { $("calc-info").textContent = "Error: " + e.message; ultimoCalculo = null; }
};
/* Elegir ruta: muestra las alternativas del mapa para que el profesor escoja.
   No toca el calculo automatico; al elegir, ese valor es el que se guarda. */
function elegirOpcion(base, i) {
  const o = base.opciones[i];
  ultimoCalculo = { ...base, kmIda: o.kmIda, kmIV: o.kmIV, _k: base._k };
  document.querySelectorAll('#rutas-opciones input[name="ruta"]').forEach((r, j) => r.checked = j === i);
  $("calc-info").textContent = `Ruta elegida (opción ${i + 1}): ${o.kmIda} km ida → ${o.kmIV} km ida-vuelta (${fmtES(o.kmIV * precioKm)}). Se guardará este valor.`;
  const ver = document.createElement("a");
  ver.href = base.url; ver.target = "_blank"; ver.rel = "noopener";
  ver.textContent = " 🛣️ Previsualizar ruta";
  $("calc-info").appendChild(document.createTextNode(" "));
  $("calc-info").appendChild(ver);
}
function renderOpciones(base) {
  const box = $("rutas-opciones");
  box.innerHTML = "";
  const ops = base.opciones || [];
  if (ops.length < 2) {
    box.innerHTML = '<span class="muted">Solo hay una ruta posible entre esos puntos; es la calculada.</span>';
    return;
  }
  const minKm = Math.min(...ops.map(o => o.kmIV)), minT = Math.min(...ops.map(o => o.min));
  ops.forEach((o, i) => {
    const lab = document.createElement("label"); lab.className = "ruta-op";
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "ruta"; radio.checked = i === 0;
    radio.onchange = () => elegirOpcion(base, i);
    const txt = document.createElement("span");
    const marcas = [i === 0 ? "Recomendada" : null, o.kmIV === minKm ? "Más corta" : null, o.min === minT ? "Más rápida" : null].filter(Boolean).join(" · ");
    txt.textContent = `Opción ${i + 1}: ${o.kmIda} km ida → ${o.kmIV} km ida-vuelta · ${o.min} min${marcas ? " (" + marcas + ")" : ""} `;
    const ver = document.createElement("a");
    ver.href = urlOpcion({ lat: base.oLat, lon: base.oLon }, { lat: base.dLat, lon: base.dLon }, o, midDe(base));
    ver.target = "_blank"; ver.rel = "noopener"; ver.title = "Abrir esta opción en el mapa";
    ver.textContent = "🛣️";
    txt.appendChild(ver);
    lab.append(radio, txt); box.appendChild(lab);
  });
}
$("btn-elegir").onclick = async () => {
  const box = $("rutas-opciones");
  box.innerHTML = "";
  $("calc-info").textContent = "Buscando rutas…";
  try {
    const base = await calcularKm($("f-origen").value, $("f-destino").value, $("f-via").value);
    base._k = claveRuta();
    ultimoCalculo = { ...base };
    if (base.viaInput) {
      box.innerHTML = '<span class="muted">Con parada intermedia hay una única ruta (pasando por la vía indicada); es la calculada.</span>';
      $("calc-info").textContent = `Calculado con ${base.proveedor} vía ${base.locV}: ${base.kmIV} km ida-vuelta.`;
      return;
    }
    renderOpciones(base);
    $("calc-info").textContent = `Calculado con ${base.proveedor}: ${base.opciones.length} ruta(s). Elige una abajo; por defecto queda la recomendada (${base.kmIV} km ida-vuelta).`;
  } catch (e) { $("calc-info").textContent = "Error: " + e.message; ultimoCalculo = null; }
};
$("btn-save").onclick = async () => {
  const btn = $("btn-save");
  if (btn.dataset.busy === "1") return; // evita duplicados por doble clic
  btn.dataset.busy = "1"; btn.disabled = true;
  try {
  const origenInput = $("f-origen").value.trim(), viaInput = $("f-via").value.trim(), destinoInput = $("f-destino").value.trim();
  const fecha = $("f-fecha").value, curso = $("f-curso").value.trim(), cod = $("f-cod").value.trim();
  const obs = $("f-obs").value.trim();
  if (!fecha || !origenInput || !destinoInput || !curso) { alert("Fecha, origen, destino y curso son obligatorios."); return; }
  let km, locO, locV, locD, aGeo, vGeo, bGeo, manual, rutaUrl = "", proveedor = "manual";
  // Viaje que se está editando (para conservar localidades y enlace si no tocó direcciones)
  let viejo = null;
  if (editandoId) {
    if (DEMO) viejo = demoSeed().find(x => String(x.id) === String(editandoId));
    else viejo = (await sb.from("viajes").select("origen,destino,via,origen_geo,destino_geo,via_geo,ruta_url").eq("id", editandoId).single()).data;
  }
  const sinCambios = (geo, input) => extraerCalle(geo || "", "") === input;
  const direccionesIntactas = viejo && sinCambios(viejo.origen_geo, origenInput)
    && sinCambios(viejo.destino_geo, destinoInput) && sinCambios(viejo.via_geo || "", viaInput);
  if ($("f-km").value) {
    // Km manual: solo la localidad a la tabla; la calle completa queda como referencia
    km = Math.round(+$("f-km").value);
    if (direccionesIntactas && esLocalidadValida(viejo.origen) && esLocalidadValida(viejo.destino)) {
      // No tocó las direcciones: conserva las localidades ya calculadas
      // (evita que "Calle X, 2" acabe como localidad "2")
      locO = viejo.origen; locD = viejo.destino; locV = viejo.via || "";
    } else {
      locO = localidadDeTexto(origenInput); locD = localidadDeTexto(destinoInput);
      locV = viaInput ? localidadDeTexto(viaInput) : "";
    }
    aGeo = "manual: " + origenInput; bGeo = "manual: " + destinoInput;
    vGeo = viaInput ? "manual: " + viaInput : "";
    manual = true;
    // Al pasar a manual un viaje ya calculado, conserva su enlace si no tocaste las direcciones
    rutaUrl = (direccionesIntactas && viejo && viejo.ruta_url) ? viejo.ruta_url : "";
  } else {
    try {
      const k = claveRuta();
      const c = ultimoCalculo && ultimoCalculo._k === k ? ultimoCalculo : await calcularKm(origenInput, destinoInput, viaInput);
      km = c.kmIV; locO = c.locO; locD = c.locD; locV = c.locV || ""; rutaUrl = c.url || ""; proveedor = c.proveedor || "";
      // En tabla/PDF solo va la localidad; la calle y nº quedan guardadas como referencia
      aGeo = origenInput + " [" + c.aGeo + "]"; bGeo = destinoInput + " [" + c.bGeo + "]";
      vGeo = viaInput ? viaInput + " [" + (c.viaGeo || "") + "]" : "";
      manual = false;
    } catch (e) { alert("No se pudo calcular: " + e.message); return; }
  }
  const total = +(km * precioKm).toFixed(2);
  const origen = locO, destino = locD, via = locV || "";
  const registro = { fecha, origen, via, destino, km, motivo_codigo: cod, motivo_curso: curso, precio_km: precioKm, total, origen_geo: aGeo, via_geo: vGeo, destino_geo: bGeo, manual, observaciones: obs, ruta_url: rutaUrl, proveedor };
  // Compatibilidad: si la tabla Supabase aún no tiene las columnas via/via_geo,
  // reintenta sin ellas para no bloquear el guardado (pide ejecutar el schema nuevo).
  const guardarSupabase = async (datos, esEdicion) => {
    const intento = async d => esEdicion
      ? sb.from("viajes").update(d).eq("id", editandoId)
      : sb.from("viajes").insert({ user_id: perfil.id, ...d });
    let r = await intento(datos);
    if (r.error && /via/i.test(r.error.message || "")) {
      const { via: _1, via_geo: _2, ...sinVia } = datos;
      r = await intento(sinVia);
      if (!r.error) alert("Viaje guardado, pero la columna 'via' no existe aún en Supabase: ejecuta el schema.sql nuevo para ver la parada intermedia.");
    }
    return r.error;
  };
  if (DEMO) {
    const v = demoSeed();
    if (editandoId) {
      const i = v.findIndex(x => String(x.id) === String(editandoId));
      if (i >= 0) v[i] = { ...v[i], ...registro };
    } else v.push({ id: Date.now(), ...registro });
    demoGuardar(v);
  } else {
    const error = await guardarSupabase(registro, !!editandoId);
    if (error) { alert(error.message); return; }
  }
  salirEdicion();
  cargarProf(); if (!$("v-coord").hidden) cargarCoord();
  } finally { btn.dataset.busy = ""; btn.disabled = false; }
};
/* Editar: carga el viaje en el formulario para corregirlo */
function extraerCalle(geo, localidad) {
  geo = String(geo || "");
  if (geo.startsWith("manual: ")) return geo.slice(8);
  const i = geo.indexOf(" [");
  if (i > 0) return geo.slice(0, i);
  return localidad || geo;
}
async function entrarEdicion(id) {
  let v;
  if (DEMO) v = demoSeed().find(x => String(x.id) === String(id));
  else v = (await sb.from("viajes").select("*").eq("id", id).single()).data;
  if (!v) return;
  editandoId = v.id;
  $("f-fecha").value = v.fecha;
  $("f-origen").value = extraerCalle(v.origen_geo, v.origen);
  $("f-via").value = extraerCalle(v.via_geo || "", v.via || "");
  $("f-destino").value = extraerCalle(v.destino_geo, v.destino);
  $("f-cod").value = v.motivo_codigo || "";
  $("f-curso").value = v.motivo_curso || "";
  $("f-obs").value = v.observaciones || "";
  $("f-km").value = v.manual ? v.km : "";
  ultimoCalculo = null;
  $("calc-info").textContent = v.manual
    ? "Editando con km manual (" + v.km + " km). Cambia el valor o borra el campo para recalcular con el mapa."
    : "Editando viaje. Si cambias las direcciones, pulsa Calcular o se recalculará al actualizar.";
  $("rutas-opciones").innerHTML = "";
  if (v.ruta_url) {
    const ver = document.createElement("a");
    ver.href = v.ruta_url; ver.target = "_blank"; ver.rel = "noopener";
    ver.textContent = " 🛣️ Ver ruta guardada";
    $("calc-info").appendChild(document.createTextNode(" "));
    $("calc-info").appendChild(ver);
  }
  $("btn-save").textContent = "Actualizar viaje";
  $("btn-cancel-edit").hidden = false;
  const tit = $("sec-viaje");
  if (tit) {
    tit.textContent = "✎ Editando viaje del " + String(v.fecha || "").split("-").reverse().join("/") + " — modifica y pulsa «Actualizar viaje»";
    tit.classList.add("sec-editando");
  }
  (tit || $("btn-save")).scrollIntoView({ behavior: "smooth", block: "center" });
}
function salirEdicion() {
  editandoId = null;
  ["f-origen", "f-via", "f-destino", "f-cod", "f-curso", "f-km", "f-obs"].forEach(i => $(i).value = "");
  $("f-origen").value = (perfil && perfil.domicilio) || ""; // origen por defecto
  $("f-fecha").valueAsDate = new Date();
  ultimoCalculo = null; $("calc-info").textContent = "";
  $("rutas-opciones").innerHTML = "";
  $("btn-save").textContent = "Guardar viaje";
  $("btn-cancel-edit").hidden = true;
  const tit = $("sec-viaje");
  if (tit) { tit.textContent = "🚗 Nuevo viaje"; tit.classList.remove("sec-editando"); }
}
$("btn-cancel-edit").onclick = salirEdicion;
/* Mis datos: domicilio para el origen por defecto (nombre y DNI los gestiona la coordinadora) */
function cargarDatos() {
  if ($("f-nombre")) $("f-nombre").value = perfil.nombre || "";
  if ($("f-nif")) $("f-nif").value = perfil.nif || "";
  $("f-domicilio").value = perfil.domicilio || "";
  if (!$("f-origen").value) $("f-origen").value = perfil.domicilio || "";
}
$("btn-datos").onclick = async () => {
  const nombre = ($("f-nombre") ? $("f-nombre").value.trim() : perfil.nombre) || perfil.nombre || "",
    nif = ($("f-nif") ? $("f-nif").value.trim().toUpperCase() : perfil.nif) || perfil.nif || "";
  const domicilio = $("f-domicilio").value.trim();
  perfil.nombre = nombre; perfil.nif = nif; perfil.domicilio = domicilio;
  if (DEMO) {
    try { localStorage.setItem("km_perfil_demo", JSON.stringify({ nombre, nif, domicilio })); } catch {}
  } else {
    let { error } = await sb.from("profiles").update({ nombre, nif, domicilio }).eq("id", perfil.id);
    if (error && /domicilio/i.test(error.message || "")) {
      // Tabla aún sin la columna domicilio: guarda el resto y avisa
      ({ error } = await sb.from("profiles").update({ nombre, nif }).eq("id", perfil.id));
      if (!error) alert("Datos guardados, pero la columna 'domicilio' no existe aún en Supabase: ejecuta el schema.sql nuevo.");
    }
    if (error) { alert(error.message); return; }
  }
  if ($("prof-nombre")) $("prof-nombre").textContent = nombre;
  if (!$("f-origen").value) $("f-origen").value = domicilio;
  alert("Datos guardados. Saldrán en la hoja del PDF y tu dirección será el origen por defecto.");
};

/* ---------- tickets de gasolina (una pagina por ticket en el PDF final) ---------- */
const TICKETS_KEY = "km_tickets_demo"; // DEMO: [{id,nombre,dataUrl,viaje_id,fecha}]
function leerTicketsArray() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(TICKETS_KEY) || "null"); } catch { return []; }
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  // migracion formato antiguo {"YYYY-MM":[...]} -> fecha = dia 15
  const arr = [];
  Object.entries(raw).forEach(([mes, lista]) => (lista || []).forEach(t => arr.push({ ...t, fecha: t.fecha || mes + "-15" })));
  try { localStorage.setItem(TICKETS_KEY, JSON.stringify(arr)); } catch {}
  return arr;
}
const guardarTicketsArray = a => localStorage.setItem(TICKETS_KEY, JSON.stringify(a));
const ticketsDelRango = (desde, hasta) => leerTicketsArray().filter(t => (t.fecha || "") >= desde && (t.fecha || "") <= hasta);
// Reduce foto a JPEG manejable (demo en localStorage y PDF ligero)
function imagenADataUrl(im, max = 1600) {
  const k = Math.min(1, max / Math.max(im.width, im.height));
  const c = document.createElement("canvas");
  c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
  c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}
function leerFicheroComoImagen(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = rej; im.src = url;
  });
}
async function listarTickets(desde, hasta, uid) {
  if (DEMO) return ticketsDelRango(desde, hasta).map(t => ({ id: t.id, nombre: t.nombre, viaje_id: t.viaje_id || null, src: t.dataUrl }));
  let q = sb.from("tickets").select("*").gte("fecha", desde).lte("fecha", hasta).order("fecha");
  if (uid) q = q.eq("user_id", uid);
  const { data } = await q;
  const out = [];
  for (const t of (data || [])) {
    const { data: blob } = await sb.storage.from("tickets").download(t.path);
    if (!blob) continue;
    out.push({ id: t.id, nombre: t.nombre, path: t.path, src: URL.createObjectURL(blob) });
  }
  return out;
}
async function renderTickets() {
  const turno = ++turnoTick;
  const { desde, hasta } = rangoProf();
  // Viajes del periodo para asignar cada ticket a uno (o general del periodo)
  let viajesMes = [];
  if (DEMO) viajesMes = demoFiltrarRango(desde, hasta);
  else viajesMes = (await sb.from("viajes").select("id,fecha,origen,via,destino").gte("fecha", desde).lte("fecha", hasta).order("fecha")).data || [];
  const porId = Object.fromEntries(viajesMes.map(v => [String(v.id), v]));
  const lista = await listarTickets(desde, hasta);
  if (turno !== turnoTick) return;
  const box = $("tickets-prev");
  box.innerHTML = lista.length ? "" : '<span class="muted">Sin tickets en este periodo.</span>';
  lista.forEach(t => {
    const d = document.createElement("div"); d.className = "thumb";
    const img = document.createElement("img"); img.src = t.src; img.alt = t.nombre;
    const v = t.viaje_id ? porId[String(t.viaje_id)] : null;
    const leyenda = document.createElement("div");
    leyenda.textContent = t.nombre + (v ? ` (${fmtFecha(v.fecha)} ${textoRutaPDF(v)})` : " (general)");
    const btn = document.createElement("button"); btn.textContent = "Quitar"; btn.className = "ibtn danger sm";
    btn.onclick = () => borrarTicket(t);
    d.append(img, leyenda, btn); box.appendChild(d);
  });
}
async function borrarTicket(t) {
  if (!confirm("¿Quitar este ticket?")) return;
  if (DEMO) {
    guardarTicketsArray(leerTicketsArray().filter(x => String(x.id) !== String(t.id)));
  } else {
    if (t.path) await sb.storage.from("tickets").remove([t.path]);
    await sb.from("tickets").delete().eq("id", t.id);
  }
  renderTickets();
}
$("f-tickets").onchange = async ev => {
  const { desde, hasta } = rangoProf();
  const fTicket = hoyISO(); // tickets del periodo visible, sin asignar a viajes
  for (const file of ev.target.files) {
    try {
      const im = await leerFicheroComoImagen(file);
      const dataUrl = imagenADataUrl(im);
      if (DEMO) {
        const arr = leerTicketsArray();
        arr.push({ id: Date.now() + Math.random(), nombre: file.name, dataUrl, viaje_id: null, fecha: fTicket });
        try { guardarTicketsArray(arr); }
        catch { alert("Ticket demasiado grande para la demo (límite del navegador). Se incluye igualmente en este PDF si no recargas."); }
      } else {
        // Se sube la versión comprimida (~200-400 KB) para no llenar el GB gratuito
        const blob = await (await fetch(dataUrl)).blob();
        const nombreJpg = file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
        const path = `${perfil.id}/${fTicket.slice(0, 7)}/${Date.now()}_${nombreJpg}`;
        const { error: e1 } = await sb.storage.from("tickets").upload(path, blob, { contentType: "image/jpeg" });
        if (e1) { alert("Error subiendo " + file.name + ": " + e1.message); continue; }
        const { error: e2 } = await sb.from("tickets").insert({ user_id: perfil.id, mes: fTicket.slice(0, 7), fecha: fTicket, nombre: file.name, path, viaje_id: null });
        if (e2) alert("Error registrando " + file.name + ": " + e2.message);
      }
    } catch { alert("No se pudo leer " + file.name); }
  }
  ev.target.value = "";
  renderTickets(); cargarProf();
};
/* ---------- certificados de asistencia (uno por viaje, con arrastrar/soltar) ---------- */
const CERTS_KEY = "km_certificados_demo"; // DEMO: [{id,viaje_id,nombre,tipo,dataUrl}]
function leerCertsArray() {
  try { const v = JSON.parse(localStorage.getItem(CERTS_KEY) || "null"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
const guardarCertsArray = a => localStorage.setItem(CERTS_KEY, JSON.stringify(a));
function leerFicheroDataUrl(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file);
  });
}
// Chrome no permite abrir data: en pestaña nueva -> pasar por blob (si permitido)
async function dataUrlABlobUrl(dataUrl) {
  const r = await fetch(dataUrl);
  return URL.createObjectURL(await r.blob());
}
// Una linea por viaje del periodo con su hueco para anexar el certificado
async function renderCerts(viajes) {
  const turno = ++turnoCert;
  const box = $("cert-lineas");
  if (!viajes.length) { box.innerHTML = '<span class="muted">No hay viajes en este periodo.</span>'; return; }
  const mapa = {};
  if (DEMO) leerCertsArray().forEach(c => mapa[String(c.viaje_id)] = c);
  else ((await sb.from("certificados").select("*").in("viaje_id", viajes.map(v => v.id))).data || []).forEach(c => mapa[String(c.viaje_id)] = c);
  if (turno !== turnoCert) return;
  box.innerHTML = "";
  ordenarComoPdf(viajes).forEach(v => { // mismo orden que el PDF: por fecha juntando cursos
    const c = mapa[String(v.id)];
    const linea = document.createElement("div"); linea.className = "cert-linea";
    const info = document.createElement("span"); info.className = "viaje";
    info.textContent = `${fmtFecha(v.fecha)} ${textoRutaPDF(v)} · ${(v.motivo_codigo ? v.motivo_codigo + " - " : "") + (v.motivo_curso || "")}`;
    const zona = document.createElement("div"); zona.className = "dropzone" + (c ? " ok" : "");
    zona.textContent = c ? `📜 ${c.nombre}` : "Arrastra imagen/PDF o pulsa aquí";
    zona.title = c ? c.nombre : "Anexar el certificado de asistencia de este viaje";
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*,.pdf,application/pdf"; input.hidden = true;
    input.onchange = () => { if (input.files[0]) subirCert(v.id, input.files[0]); input.value = ""; };
    zona.onclick = () => input.click();
    zona.ondragover = ev => { ev.preventDefault(); zona.classList.add("over"); };
    zona.ondragleave = () => zona.classList.remove("over");
    zona.ondrop = ev => { ev.preventDefault(); zona.classList.remove("over"); if (ev.dataTransfer.files[0]) subirCert(v.id, ev.dataTransfer.files[0]); };
    linea.append(info, zona, input);
    if (c) {
      const ver = document.createElement("a"); ver.textContent = "Ver"; ver.href = "#"; ver.className = "ver";
      ver.onclick = async ev => {
        ev.preventDefault();
        const win = window.open("", "_blank"); // dentro del clic para que no lo bloquee
        if (!win) { alert("El navegador bloqueó la pestaña. Permite emergentes para este sitio."); return; }
        try {
          if (DEMO) win.location.href = await dataUrlABlobUrl(c.dataUrl);
          else {
            const { data: blob } = await sb.storage.from("certificados").download(c.path);
            if (!blob) throw new Error("vacio");
            win.location.href = URL.createObjectURL(blob);
          }
        } catch { win.close(); alert("No se pudo abrir el certificado."); }
      };
      const quitar = document.createElement("button"); quitar.textContent = "Quitar"; quitar.className = "ibtn danger sm";
      quitar.onclick = () => quitarCert(c);
      linea.append(ver, quitar);
    }
    box.appendChild(linea);
  });
}
async function subirCert(viajeId, file) {
  const esPdf = (file.type || "").includes("pdf") || /\.pdf$/i.test(file.name);
  if (DEMO) {
    let dataUrl = null;
    try { dataUrl = esPdf ? await leerFicheroDataUrl(file) : imagenADataUrl(await leerFicheroComoImagen(file)); }
    catch { dataUrl = null; }
    if (!dataUrl) { alert("No se pudo leer " + file.name); return; }
    const arr = leerCertsArray().filter(c => String(c.viaje_id) !== String(viajeId));
    arr.push({ id: Date.now() + Math.random(), viaje_id: viajeId, nombre: file.name, tipo: esPdf ? "pdf" : "img", dataUrl });
    try { guardarCertsArray(arr); } catch { alert("Documento demasiado grande para la demo (límite del navegador)."); return; }
  } else {
    const { data: prev } = await sb.from("certificados").select("*").eq("viaje_id", viajeId);
    for (const p of (prev || [])) { await sb.storage.from("certificados").remove([p.path]); await sb.from("certificados").delete().eq("id", p.id); }
    // Fotos: se suben comprimidas (~200-400 KB) para no llenar el GB gratuito; PDF tal cual
    let blobSubir = file, tipoSubida = file.type || (esPdf ? "application/pdf" : "image/jpeg");
    let nombrePath = file.name;
    if (!esPdf) {
      try {
        blobSubir = await (await fetch(imagenADataUrl(await leerFicheroComoImagen(file)))).blob();
        tipoSubida = "image/jpeg";
        nombrePath = file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
      } catch { alert("No se pudo leer " + file.name); return; }
    } else if (file.size > 5 * 1024 * 1024) {
      alert("Ese PDF pesa más de 5 MB y ocupa bastante del almacenamiento gratuito. Si puedes, escanéalo a menor resolución.");
    }
    const path = `${perfil.id}/${viajeId}/${Date.now()}_${nombrePath}`;
    const { error: e1 } = await sb.storage.from("certificados").upload(path, blobSubir, { contentType: tipoSubida });
    if (e1) { alert("Error subiendo: " + e1.message); return; }
    const { error: e2 } = await sb.from("certificados").insert({ user_id: perfil.id, viaje_id: viajeId, nombre: file.name, path, tipo: esPdf ? "pdf" : "img" });
    if (e2) { alert("Error registrando: " + e2.message); return; }
  }
  cargarProf();
}
async function quitarCert(c) {
  if (!confirm("¿Quitar este certificado?")) return;
  if (DEMO) guardarCertsArray(leerCertsArray().filter(x => String(x.id) !== String(c.id)));
  else { await sb.storage.from("certificados").remove([c.path]); await sb.from("certificados").delete().eq("id", c.id); }
  cargarProf();
}
// Certificados de los viajes dados (para el PDF)
async function listarCerts(viajes) {
  const ids = (viajes || []).map(v => v.id);
  if (!ids.length) return [];
  if (DEMO) return leerCertsArray().filter(c => ids.map(String).includes(String(c.viaje_id)))
    .map(c => ({ ...c, src: c.dataUrl }));
  const { data } = await sb.from("certificados").select("*").in("viaje_id", ids);
  const out = [];
  for (const c of (data || [])) {
    const { data: blob } = await sb.storage.from("certificados").download(c.path);
    if (blob) out.push({ ...c, src: URL.createObjectURL(blob) });
  }
  return out;
}
const faltanCerts = (viajes, certs) => (viajes || []).filter(v => !(certs || []).some(c => String(c.viaje_id) === String(v.id)));
// PDF (escaneado) -> paginas como imagenes para anexarlas
async function pdfAPaginas(src) {
  const pdf = await window.pdfjsLib.getDocument(src).promise;
  const out = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 20); p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1.6 });
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    out.push({ jpg: cv.toDataURL("image/jpeg", 0.85), w: cv.width, h: cv.height });
  }
  return out;
}
async function imagenNormalizada(src) {
  const im = await cargarImagenTicket(src);
  return { jpg: imagenADataUrl(im), w: im.width, h: im.height };
}
function paginaAnexo(doc, jpg, w, h, titulo) {
  doc.addPage("a4", "p"); // anexos siempre en vertical
  const PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
  doc.setFontSize(11);
  doc.text(titulo, 40, 40);
  const k = Math.min((PW - 80) / w, (PH - 110) / h);
  doc.addImage(jpg, "JPEG", (PW - w * k) / 2, 60, w * k, h * k);
}
// Logo con fondo blanco (el PNG es transparente y el JPEG no admite alfa)
function logoADataUrl(im) {
  const k = Math.min(1, 700 / im.width);
  const c = document.createElement("canvas");
  c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
  const x = c.getContext("2d");
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(im, 0, 0, c.width, c.height);
  return { jpg: c.toDataURL("image/jpeg", 0.92), w: c.width, h: c.height };
}
$("btn-pdf").onclick = async () => {
  const { desde, hasta } = rangoProf();
  let data;
  if (DEMO) data = demoFiltrarRango(desde, hasta);
  else data = (await sb.from("viajes").select("*").gte("fecha", desde).lte("fecha", hasta).order("fecha")).data;
  if (!data?.length) { alert("Sin viajes en ese periodo."); return; }
  const certs = await listarCerts(data);
  const sin = faltanCerts(data, certs);
  if (sin.length && !confirm(`Hay ${sin.length} viaje(s) sin certificado de asistencia. ¿Generar el PDF igualmente?`)) return;
  const tickets = await listarTickets(desde, hasta);
  await pdfHoja(perfil, data, { desde, hasta }, { certs, tickets });
};
/*Correo para Outlook (.eml): Para/CC/asunto/cuerpo + PDF anexado.
  El "De" lo pone el Outlook del profesor con su cuenta predeterminada. */
const CORREO_PARA = "mfernandez@grupomainjobs.com";
const CORREO_CC = "asoler@grupomainjobs.com";
const b64utf8 = s => btoa(unescape(encodeURIComponent(s)));
const plegarAsunto = s => "Subject: " + ((b64utf8(s).match(/.{1,45}/g) || []).map(t => `=?UTF-8?B?${t}?=`).join("\r\n "));
function construirEml({ para, cc, asunto, cuerpo, nombrePdf, pdfBase64 }) {
  const B = "limite-" + Date.now().toString(36);
  const partePdf = pdfBase64.replace(/.{1,76}/g, "$&\r\n");
  return ["MIME-Version: 1.0",
    `To: ${para}`, `Cc: ${cc}`, plegarAsunto(asunto),
    `Content-Type: multipart/mixed; boundary="${B}"`, "",
    `--${B}`, `Content-Type: text/plain; charset="utf-8"`, "Content-Transfer-Encoding: 8bit", "",
    cuerpo, "",
    `--${B}`, `Content-Type: application/pdf; name="${nombrePdf}"`,
    "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${nombrePdf}"`, "",
    partePdf, `--${B}--`, ""
  ].join("\r\n");
}
function descargarFichero(nombre, contenido, tipo) {
  const blob = contenido instanceof Blob ? contenido : new Blob([contenido], { type: tipo });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
}
$("btn-correo").onclick = async () => {
  const { desde, hasta } = rangoProf();
  let data;
  if (DEMO) data = demoFiltrarRango(desde, hasta);
  else data = (await sb.from("viajes").select("*").gte("fecha", desde).lte("fecha", hasta).order("fecha")).data;
  if (!data?.length) { alert("Sin viajes en ese periodo."); return; }
  const certs = await listarCerts(data);
  const sin = faltanCerts(data, certs);
  if (sin.length && !confirm(`Hay ${sin.length} viaje(s) sin certificado de asistencia. ¿Generar el PDF igualmente?`)) return;
  const tickets = await listarTickets(desde, hasta);
  const { nombrePdf, dataUri, tamMB } = await pdfHoja(perfil, data, { desde, hasta }, { certs, tickets }, true);
  if (tamMB > 10 && !confirm(`El PDF pesa ${tamMB.toFixed(1)} MB y puede dar problemas al enviarlo por correo. ¿Generar el .eml igualmente?`)) return;
  const periodo = `${fmtFecha(desde)} - ${fmtFecha(hasta)}`;
  const eml = construirEml({
    para: CORREO_PARA, cc: CORREO_CC,
    asunto: `Documentación de kilometraje de ${perfil.nombre} del periodo ${periodo}`,
    cuerpo: `Hola Mara:\n\nAdjunto te envío la hoja de kilometraje correspondiente al periodo del ${periodo}\n\nUn saludo,\n${perfil.nombre || ""}`,
    nombrePdf, pdfBase64: dataUri.split(",")[1],
  });
  descargarFichero(`Correo_kilometraje_${desde}_${hasta}.eml`, eml, "message/rfc822");
  alert("Correo generado: ábrelo y se abrirá en Outlook con el PDF anexado, listo para enviar.");
};
/* Archivar periodo: descarga el PDF final como copia local y borra de la nube
   los certificados y tickets del periodo (los viajes se conservan). */
async function borrarFicheros(certs, tickets) {
  if (DEMO) {
    const idsC = new Set((certs || []).map(c => String(c.id)));
    const idsT = new Set((tickets || []).map(t => String(t.id)));
    guardarCertsArray(leerCertsArray().filter(c => !idsC.has(String(c.id))));
    guardarTicketsArray(leerTicketsArray().filter(t => !idsT.has(String(t.id))));
  } else {
    for (const c of (certs || [])) {
      if (c.path) await sb.storage.from("certificados").remove([c.path]);
      await sb.from("certificados").delete().eq("id", c.id);
    }
    for (const t of (tickets || [])) {
      if (t.path) await sb.storage.from("tickets").remove([t.path]);
      await sb.from("tickets").delete().eq("id", t.id);
    }
  }
}
async function archivarRango(viajes, prof, desde, hasta, uid) {
  if (!viajes?.length) { alert("Sin viajes en ese periodo."); return; }
  const certs = await listarCerts(viajes);
  const tickets = await listarTickets(desde, hasta, uid);
  if (!certs.length && !tickets.length) { alert("No hay ficheros en la nube en este periodo: nada que archivar."); return; }
  await pdfHoja(prof, viajes, { desde, hasta }, { certs, tickets }); // copia local
  if (!confirm(`Copia descargada (${certs.length} certificado(s) y ${tickets.length} ticket(s)). ¿Borrarlos de la nube? Los viajes se conservan.`)) return;
  await borrarFicheros(certs, tickets);
  alert("Periodo archivado: ficheros borrados de la nube, viajes conservados.");
  if (!$("v-prof").hidden) cargarProf();
  if (!$("v-coord").hidden) cargarCoord();
}
$("btn-archivar-coord").onclick = async () => {
  const { desde, hasta } = rangoCoord();
  if (DEMO) { await archivarRango(demoFiltrarRango(desde, hasta), perfil, desde, hasta); return; }
  const uid = $("pdf-user").value;
  const { data: p } = await sb.from("profiles").select("*").eq("id", uid).single();
  const { data: v } = await sb.from("viajes").select("*").eq("user_id", uid).gte("fecha", desde).lte("fecha", hasta).order("fecha");
  await archivarRango(v || [], p, desde, hasta, uid);
};

/* ---------- coordinador (tiempo real) ---------- */
let canal = null;
async function initCoord() {
  $("desde-coord").value = primerDia(); $("hasta-coord").value = ultimoDia();
  const { data: profs } = await sb.from("profiles").select("*").eq("rol", "profesor").order("nombre");
  $("pdf-user").innerHTML = (profs || []).map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join("");
  $("filtro-prof").innerHTML = `<option value="">Todos</option>` + (profs || []).map(p => `<option value="${esc(p.nombre)}">${esc(p.nombre)}</option>`).join("");
  $("precio").value = String(precioKm).replace(".", ",");
  $("btn-ver").onclick = cargarCoord;
  $("filtro-prof").onchange = cargarCoord;
  $("desde-coord").onchange = cargarCoord; $("hasta-coord").onchange = cargarCoord;
  $("btn-precio").onclick = async () => {
    const v = $("precio").value.replace(",", ".");
    const { error } = await sb.from("settings").upsert({ clave: "precio_km", valor: v });
    if (!error) { precioKm = +v; alert("Precio actualizado."); }
  };
  $("btn-pdf-coord").onclick = async () => {
    const uid = $("pdf-user").value, { desde, hasta } = rangoCoord();
    const { data: p } = await sb.from("profiles").select("*").eq("id", uid).single();
    const { data: v } = await sb.from("viajes").select("*").eq("user_id", uid).gte("fecha", desde).lte("fecha", hasta).order("fecha");
    if (!v?.length) { alert("Sin viajes en ese periodo."); return; }
    const certs = await listarCerts(v);
    const sin = faltanCerts(v, certs);
    if (sin.length && !confirm(`Hay ${sin.length} viaje(s) sin certificado de asistencia. ¿Generar el PDF igualmente?`)) return;
    await pdfHoja(p, v, { desde, hasta }, { certs, tickets: await listarTickets(desde, hasta, uid) });
  };
  await cargarCoord();
  if (canal) sb.removeChannel(canal); // suscripcion en directo: ve viajes y certificados "a medida que los meten"
  canal = sb.channel("viajes-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "viajes" }, cargarCoord)
    .on("postgres_changes", { event: "*", schema: "public", table: "certificados" }, cargarCoord)
    .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, cargarCoord)
    .subscribe();
}
async function cargarCoord() {
  const turno = ++turnoCoord;
  const { desde, hasta } = rangoCoord(), f = $("filtro-prof").value.trim().toLowerCase();
  let data;
  if (DEMO) {
    data = demoFiltrarRango(desde, hasta).map(v => ({ ...v, profiles: { nombre: perfil.nombre } }))
      .filter(v => !f || v.profiles.nombre.toLowerCase().includes(f));
  } else {
    let q = sb.from("viajes").select("*, profiles!inner(nombre)").gte("fecha", desde).lte("fecha", hasta).order("fecha");
    if (f) q = q.ilike("profiles.nombre", `%${f}%`);
    data = (await q).data;
  }
  const tb = $("t-coord").querySelector("tbody"); tb.innerHTML = "";
  let tot = 0;
  data = agrupCoord ? ordenarComoPdf(data) : (data || []).sort(compararViajes(ordenCoord.campo, ordenCoord.dir));
  const colores = mapaColoresCursos(data);
  const idsCoord = (data || []).map(v => v.id);
  const certMap = {};
  if (idsCoord.length) {
    const listaC = DEMO ? leerCertsArray().filter(c => idsCoord.map(String).includes(String(c.viaje_id)))
      : ((await sb.from("certificados").select("viaje_id,nombre,path,tipo").in("viaje_id", idsCoord)).data || []);
    listaC.forEach(c => certMap[String(c.viaje_id)] = c);
  }
  if (turno !== turnoCoord) return; // una carga más reciente tomó el relevo
  const celdaC = v => certMap[String(v.id)]
    ? `<td class="st ok"><button class="ibtn sm" data-vercert="${v.id}" title="Ver certificado: ${esc(certMap[String(v.id)].nombre || "")}">📜</button></td>`
    : `<td class="st no" title="Sin certificado de asistencia">❌</td>`;
  (data || []).forEach(v => {
    tot += +v.total;
    tb.innerHTML += `<tr style="background:${colores[claveCurso(v)]}"><td>${v.fecha.split("-").reverse().join("/")}</td><td>${esc(v.profiles.nombre)}</td>
      <td title="${esc(tituloRuta(v))}">${esc(textoRuta(v))}${iconoRuta(v)}</td><td${v.manual ? ' class="km-manual" title="Km manual — autorizado por coordinadora"' : ""}>${v.km}</td><td>${fmtES(+v.total)}</td>
      ${celdaRecorte((v.motivo_codigo ? v.motivo_codigo + " - " : "") + v.motivo_curso)}${celdaObs(v)}${celdaC(v)}</tr>`;
  });
  $("total-coord").textContent = "Total: " + fmtES(tot);
  renderResumen(data || [], certMap, turno);
  tb.querySelectorAll("[data-vercert]").forEach(b => b.onclick = () => verCertCoord(certMap[b.dataset.vercert]));
  marcarRecortes(tb);
}
/* Resumen por profesor del periodo visible: compara actividad de un vistazo.
   Usa los filtros de fecha y profesora de la parte superior. */
const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const PALETA = ["#1a73e8", "#15803d", "#b45309", "#7c3aed", "#0891b2", "#dc2626", "#ca8a04", "#4d7c0f", "#0f766e", "#a21caf"];
function pintarChart(id, cfg) {
  if (!window.Chart) return;
  const el = document.getElementById(id);
  if (!el) return;
  const previo = window.Chart.getChart(el);
  if (previo) previo.destroy();
  new window.Chart(el, cfg);
}
const baseChart = titulo => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: titulo } } });
async function renderResumen(viajes, certMap, turno) {
  const box = $("resumen-coord");
  if (!box) return;
  const { desde, hasta } = rangoCoord(), f = $("filtro-prof").value.trim();
  const por = {};
  (viajes || []).forEach(v => {
    const n = (v.profiles && v.profiles.nombre) || "?";
    por[n] = por[n] || { viajes: 0, km: 0, total: 0, sinCert: 0 };
    por[n].viajes++; por[n].km += +v.km || 0; por[n].total += +v.total || 0;
    if (!certMap[String(v.id)]) por[n].sinCert++;
  });
  const filas = Object.entries(por).sort((a, b) => b[1].total - a[1].total);
  if (!filas.length) { box.innerHTML = '<span class="muted">Sin datos en este periodo.</span>'; return; }
  const maxKm = Math.max(...filas.map(([, r]) => r.km));
  const totV = filas.reduce((a, [, r]) => a + r.viajes, 0);
  const totK = filas.reduce((a, [, r]) => a + r.km, 0);
  const totE = filas.reduce((a, [, r]) => a + r.total, 0);
  const nombres = filas.map(([n]) => n);
  const colores = nombres.map((_, i) => PALETA[i % PALETA.length]);
  box.innerHTML = `<p class="muted">Periodo ${fmtFecha(desde)} – ${fmtFecha(hasta)}${f ? ` · profesora: «${esc(f)}»` : ""} (filtros de arriba)</p>
    <div class="kpis">
      <div class="kpi"><b>${filas.length}</b><span>profesores</span></div>
      <div class="kpi"><b>${totV}</b><span>viajes</span></div>
      <div class="kpi"><b>${Math.round(totK)} km</b><span>ida-vuelta</span></div>
      <div class="kpi"><b>${fmtES(totE)}</b><span>total</span></div>
    </div>
    <div class="charts">
      <div class="chartbox"><canvas id="ch-km"></canvas></div>
      <div class="chartbox"><canvas id="ch-euros"></canvas></div>
      <div class="chartbox"><canvas id="ch-cursos"></canvas></div>
      <div class="chartbox"><canvas id="ch-meses"></canvas></div>
    </div>
    <table class="dash"><thead><tr><th>Profesor</th><th>Viajes</th><th>Km</th><th>Total</th><th>Sin 📜</th><th></th></tr></thead><tbody>` +
    filas.map(([n, r]) => `<tr><td>${esc(n)}</td><td>${r.viajes}</td><td>${Math.round(r.km)}</td>` +
      `<td>${fmtES(r.total)}</td><td>${r.sinCert ? `<b class="alerta">${r.sinCert}</b>` : "0"}</td>` +
      `<td class="barcell"><div class="bar" style="width:${maxKm ? Math.round(r.km / maxKm * 100) : 0}%"></div></td></tr>`).join("") +
    `</tbody></table>`;
  pintarChart("ch-km", { type: "bar", data: { labels: nombres, datasets: [{ data: filas.map(([, r]) => Math.round(r.km)), backgroundColor: colores }] }, options: baseChart("Km por profesora") });
  pintarChart("ch-euros", { type: "doughnut", data: { labels: nombres, datasets: [{ data: filas.map(([, r]) => +r.total.toFixed(2)), backgroundColor: colores }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" }, title: { display: true, text: "Reparto de €" } } } });
  // Viajes por curso (top 8 del periodo)
  const porCurso = {};
  (viajes || []).forEach(v => {
    const k = (v.motivo_codigo ? v.motivo_codigo + " - " : "") + (v.motivo_curso || "Sin curso");
    porCurso[k] = porCurso[k] || { viajes: 0, km: 0 };
    porCurso[k].viajes++; porCurso[k].km += +v.km || 0;
  });
  const topC = Object.entries(porCurso).sort((a, b) => b[1].km - a[1].km).slice(0, 8);
  pintarChart("ch-cursos", { type: "bar", data: { labels: topC.map(([k]) => k), datasets: [{ data: topC.map(([, r]) => r.viajes), backgroundColor: "#15803d" }] }, options: { ...baseChart("Viajes por curso (top 8)"), indexAxis: "y" } });
  // Evolución de km en los últimos 6 meses (respeta el filtro de profesora)
  const h = new Date(); const d6 = new Date(h.getFullYear(), h.getMonth() - 5, 1).toISOString().slice(0, 10);
  const claves6 = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(h.getFullYear(), h.getMonth() - i, 1); claves6.push(d.toISOString().slice(0, 7)); }
  let todos;
  if (DEMO) todos = demoSeed().filter(v => v.fecha >= d6 && (!f || (perfil.nombre || "").toLowerCase().includes(f.toLowerCase())));
  else {
    let q = sb.from("viajes").select("fecha,km,profiles!inner(nombre)").gte("fecha", d6);
    if (f) q = q.ilike("profiles.nombre", `%${f}%`);
    todos = (await q).data || [];
  }
  if (turno !== turnoCoord) return;
  const kmMes = Object.fromEntries(claves6.map(k => [k, 0]));
  (todos || []).forEach(v => { const k = String(v.fecha).slice(0, 7); if (k in kmMes) kmMes[k] += +v.km || 0; });
  pintarChart("ch-meses", { type: "line", data: { labels: claves6.map(k => MESES_ES[+k.slice(5, 7) - 1] + " " + k.slice(2, 4)), datasets: [{ data: claves6.map(k => Math.round(kmMes[k])), borderColor: "#1a73e8", backgroundColor: "#1a73e833", fill: true, tension: 0.3 }] }, options: baseChart("Km por mes (6 meses)") });
}
// Coordinador: abrir el certificado de un viaje en pestaña nueva
async function verCertCoord(c) {
  if (!c) return;
  const win = window.open("", "_blank"); // dentro del clic para que no lo bloquee
  if (!win) { alert("El navegador bloqueó la pestaña. Permite emergentes para este sitio."); return; }
  try {
    if (DEMO) win.location.href = await dataUrlABlobUrl(c.dataUrl);
    else {
      const { data: blob } = await sb.storage.from("certificados").download(c.path);
      if (!blob) throw new Error("vacio");
      win.location.href = URL.createObjectURL(blob);
    }
  } catch { win.close(); alert("No se pudo abrir el certificado."); }
}

/* ---------- PDF final: hoja de kilometraje + una pagina por ticket ---------- */
function cargarImagenTicket(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im); im.onerror = rej; im.src = src;
  });
}
/* PDF final: tabla kilometraje + certificados de asistencia + tickets gasolina */
/* PDF final: hoja de kilometraje (replica del modelo oficial) + certificados + tickets.
   Primera pagina en horizontal; anexos en vertical. */
async function pdfHoja(prof, viajes, rango, tickets, soloDatos) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const W = 841.89, H = 595.28, M = 24;
  const e = v => String(v ?? "").replace(/[áéíóúñü]/gi, c => ({ á: "a", é: "e", í: "i", ó: "o", ú: "u", ñ: "n", ü: "u", Á: "A", É: "E", Í: "I", Ó: "O", Ú: "U", Ñ: "N" }[c] || c));
  const total = (viajes || []).reduce((a, v) => a + +v.total, 0);
  const marco = (x, y, w, h, fill) => {
    doc.setDrawColor(60); doc.setLineWidth(0.6);
    if (fill) { doc.setFillColor(fill[0], fill[1], fill[2]); doc.rect(x, y, w, h, "FD"); }
    else doc.rect(x, y, w, h);
  };
  // Texto encogido si no cabe en la celda
  const celdaTxt = (txt, x, y, w, size, bold, align) => {
    txt = String(txt ?? "");
    doc.setFont("helvetica", bold ? "bold" : "normal");
    let s = size;
    doc.setFontSize(s);
    while (s > 5.5 && doc.getTextWidth(txt) > w - 4) { s -= 0.5; doc.setFontSize(s); }
    doc.text(txt, align === "center" ? x + w / 2 : align === "right" ? x + w - 2 : x + 2, y, { align: align || "left" });
  };
  // Logo del grupo arriba a la derecha (incrustado en logo.js; respaldo: logo.png)
  try {
    let L = null;
    if (window.LOGO_DATAURL) L = { jpg: window.LOGO_DATAURL, w: window.LOGO_W || 700, h: window.LOGO_H || 180 };
    else L = logoADataUrl(await cargarImagenTicket("logo.png?v=20260918"));
    const lw = 130, lh = lw * L.h / L.w;
    doc.addImage(L.jpg, "JPEG", W - M - lw, 20, lw, lh);
  } catch (err) { if (window.console) console.warn("Logo no disponible:", err); }
  // Bloque de datos + Codigo/Hoja + Importe
  const iy = 76, rh = 14, labW = 68, valW = 210;
  [["Trabajador", e(prof.nombre || "")], ["N.I.F.", prof.nif || ""], ["Categoria", e(prof.categoria || "")],
   ["Proyecto", e(prof.proyecto || "")], ["Fecha", `${fmtFecha(rango.desde)} - ${fmtFecha(rango.hasta)}`]
  ].forEach(([lab, val], i) => {
    const y = iy + i * rh;
    marco(M, y, labW, rh); marco(M + labW, y, valW, rh);
    celdaTxt(e(lab), M, y + 10, labW, 8, false, "left");
    celdaTxt(val, M + labW, y + 10, valW, 8, true, "left");
  });
  doc.setFont("helvetica", "bold"); doc.setFontSize(12);
  doc.text("Importe", W / 2, iy + 2 * rh, { align: "center" });
  const rx = W - M - 150, ry = 90; // debajo del logo para no solaparse
  marco(rx, ry, 60, rh); marco(rx + 60, ry, 90, rh);
  celdaTxt("Codigo", rx, ry + 10, 60, 8, false, "left");
  marco(rx, ry + rh, 150, rh);
  celdaTxt("Hoja 1", rx, ry + 2 * rh - 4, 150, 8, false, "center");
  // Tabla: Fecha | Desplazamiento | Km Euros TOTAL | Motivo | Estancia | Comida | Total
  const anchos = [64, 150, 36, 44, 56, 199, 46, 46, 46, 46, 60];
  const X = i => M + anchos.slice(0, i).reduce((a, b) => a + b, 0);
  const ty = iy + 5 * rh + 8, h1 = 15, h2 = 12, h3 = 12, rhB = 13;
  const dibujarCabecera = y0 => {
    marco(X(2), y0, X(6) - X(2), h1); celdaTxt("Desplazamiento", X(2), y0 + 11, X(6) - X(2), 9, true, "center");
    marco(X(6), y0, X(8) - X(6), h1); celdaTxt("Estancia", X(6), y0 + 11, X(8) - X(6), 9, true, "center");
    marco(X(8), y0, X(10) - X(8), h1); celdaTxt("Comida", X(8), y0 + 11, X(10) - X(8), 9, true, "center");
    marco(X(10), y0, anchos[10], h1 + h2 + h3); celdaTxt("Total", X(10), y0 + (h1 + h2 + h3) / 2 + 3, anchos[10], 9, true, "center");
    const y1 = y0 + h1;
    [["", 0], ["", 1]].forEach(([t, i]) => { marco(X(i), y1, anchos[i], h2); });
    marco(X(2), y1, X(5) - X(2), h2); celdaTxt("Gasolina", X(2), y1 + 9, X(5) - X(2), 8, true, "center");
    for (let ci = 5; ci <= 9; ci++) marco(X(ci), y1, anchos[ci], h2); // Motivo/Poblac./Euros solo en la linea inferior, sin repetir
    const y2 = y1 + h2;
    ["Fecha", "Desplazamiento ida-vuelta", "Km.", "Euros", "TOTAL", "Motivo", "Poblac.", "Euros", "Poblac.", "Euros"].forEach((t, i) => {
      marco(X(i), y2, anchos[i], h3);
      if (t) celdaTxt(t, X(i), y2 + 9, anchos[i], 7.5, true, "center");
    });
    return y2 + h3;
  };
  // En el PDF los viajes van por fecha pero juntando los del mismo curso:
  // cada curso aparece donde cae su primer viaje y dentro, por fecha; mismo pastel por grupo
  const ordenados = ordenarComoPdf(viajes);
  const BANDAS = [[223, 239, 251], [228, 223, 241], [241, 221, 230], [253, 236, 213], [224, 239, 220], [255, 245, 208], [224, 239, 239], [240, 228, 240]];
  let bi = -1, lastKey = " ";
  const filasBody = ordenados.map(v => {
    const key = `${v.motivo_codigo || ""}|${v.motivo_curso || ""}`;
    if (key !== lastKey) { lastKey = key; bi = (bi + 1) % BANDAS.length; }
    return { v, band: BANDAS[bi], key };
  });
  const pieReserva = 100, SEP = 5; // hueco blanco entre cursos distintos
  let y = dibujarCabecera(ty);
  filasBody.forEach((f, idx) => {
    if (idx > 0 && f.key !== filasBody[idx - 1].key) y += SEP; // separar cursos
    if (y + rhB > H - M - pieReserva) { doc.addPage("a4", "l"); y = dibujarCabecera(ty); }
    const v = f.v;
      const vals = [
        [fmtFecha(v.fecha), "center"], [e(textoRutaPDF(v)), "left"],
        [String(v.km), "center"], [`${String(v.precio_km).replace(".", ",")} €`, "center"],
        [fmtES(+v.total), "center"], [e(`${v.motivo_codigo ? v.motivo_codigo + " - " : ""}${v.motivo_curso || ""}`), "center"],
        ["", "center"], ["", "center"], ["", "center"], ["", "center"], [fmtES(+v.total), "center"],
      ];
      vals.forEach(([t, al], i) => {
        doc.setFillColor(f.band[0], f.band[1], f.band[2]);
        doc.setDrawColor(60); doc.setLineWidth(0.6);
        doc.rect(X(i), y, anchos[i], rhB, "FD");
        if (t) celdaTxt(t, X(i), y + 9.5, anchos[i], 7.5, false, al);
      });
      y += rhB;
    });
    const totY = y + 18;
  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.text(fmtES(total), X(10) + anchos[10] / 2, totY, { align: "center" });
  doc.setFontSize(8);
  const pieY = H - M - 82; // firmas al pie de la hoja
  doc.text("FIRMA DEL TRABAJADOR", M, pieY);
  const ax = W - M - 340;
  doc.text("AUTORIZADO POR", ax, pieY);
  doc.setDrawColor(60); doc.setLineWidth(0.6);
  doc.rect(M, pieY + 8, 340, 54);
  doc.rect(ax, pieY + 8, 340, 54);
  const anexos = tickets && tickets.certs ? tickets : { certs: [], tickets: tickets || [] };
  // 1) Certificados de asistencia, en el orden de los viajes
  for (const v of (viajes || [])) {
    const c = (anexos.certs || []).find(x => String(x.viaje_id) === String(v.id));
    if (!c) continue;
    let paginas = [];
    try { paginas = c.tipo === "pdf" ? await pdfAPaginas(c.src) : [await imagenNormalizada(c.src)]; }
    catch { paginas = []; }
    if (!paginas.length) { doc.addPage("a4", "p"); doc.setFontSize(11); doc.text(e(`No se pudo incluir el certificado: ${c.nombre || ""}`).slice(0, 100), 40, 60); continue; }
    paginas.forEach((pg, p) => paginaAnexo(doc, pg.jpg, pg.w, pg.h,
      e(`Certificado de asistencia - ${fmtFecha(v.fecha)} ${textoRutaPDF(v)} - ${(v.motivo_codigo ? v.motivo_codigo + " - " : "") + (v.motivo_curso || "")}` + (paginas.length > 1 ? ` (pag. ${p + 1}/${paginas.length})` : "")).slice(0, 110)));
  }
  // 2) Tickets de gasolina, una pagina por ticket
  const listaT = anexos.tickets || [];
  for (let i = 0; i < listaT.length; i++) {
    const t = listaT[i];
    const tv = (viajes || []).find(x => String(x.id) === String(t.viaje_id));
    const ref = tv ? `${fmtFecha(tv.fecha)} ${textoRutaPDF(tv)}` : "general del periodo";
    try {
      const im = await imagenNormalizada(t.src);
      paginaAnexo(doc, im.jpg, im.w, im.h,
        e(`Ticket ${i + 1}/${listaT.length} - ${ref} - ${t.nombre || ""}`).slice(0, 110));
    } catch { doc.addPage("a4", "p"); doc.setFontSize(11); doc.text(e(`No se pudo incluir el ticket: ${t.nombre || ""}`).slice(0, 100), 40, 60); }
  }
  const nombrePdf = `HojaKm_${rango.desde}_${rango.hasta}_${prof.nombre || "hoja"}.pdf`;
  const dataUri = doc.output("datauristring");
  const tamMB = (dataUri.length * 3 / 4) / 1048576;
  if (soloDatos) return { nombrePdf, dataUri, tamMB };
  if (tamMB > 8) alert(`El PDF pesa ${tamMB.toFixed(1)} MB por los anexos. Se descarga igual, pero conviene borrar de la nube los ficheros de meses ya cerrados para no llenar el almacenamiento gratuito.`);
  doc.save(nombrePdf);
}

// Sin Supabase configurado (tu caso ahora): entra en demo.
// Con Supabase: intenta sesion, si no hay, muestra login.
if (DEMO) entrarDemo(); else arrancarUnaVez();
