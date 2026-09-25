# Kilometraje profesores — GitHub + Cloudflare Pages + Supabase (sin servidor)

Arquitectura: frontend estático en **Cloudflare Pages** + base de datos y auth en **Supabase**.
Mapas gratuitos sin API key: **Nominatim** (calle y nº → coordenadas) + **OSRM** (ruta).
PDF idéntico a tu `HojaKm` modelo, generado en el navegador.

## 1. Supabase (5 min)
1. Crea proyecto en supabase.com → copia **Project URL** y **anon key** (Settings > API).
2. **SQL Editor > New query**: pega todo `supabase/schema.sql` y ejecútalo.
   Crea tablas `profiles`, `viajes`, `settings` con RLS:
   - profesor: solo SELECT/INSERT/DELETE de sus viajes.
   - coordinador: ve todo **en directo** (realtime activado).
3. **Authentication > Users > Add user**: crea un coordinador y los profesores
   (email + password, auto-confirm).
4. **Table Editor > profiles**: pon `nombre`, `nif`, `categoria`, `proyecto`
   y `rol` (`coordinador` / `profesor`) a cada uno.

## 2. Probar en local
1. Copia `public/config.example.js` como `public/config.js` con tu URL y anon key:
   ```js
   window.SUPABASE_URL = "https://xyz.supabase.co";
   window.SUPABASE_ANON_KEY = "eyJ...";
   ```
2. `python -m http.server 8000 --directory public` → abre http://127.0.0.1:8000

## 3. GitHub + Cloudflare Pages
1. En esta carpeta: `git init && git add . && git commit -m "hoja km nube"`,
   crea repo en GitHub y `git push`.
2. Cloudflare Dashboard > **Workers & Pages > Create > Pages > Connect to Git**:
   elige el repo, **Framework preset: None**, **Build command: (vacío)**,
   **Output directory: `public`**, Deploy.
3. En el dominio `https://tu-app.pages.dev` la app funciona. El `config.js`
   (con las keys) **sí debe subirse** a Pages: en GitHub guarda `public/config.js`
   o mejor pon las keys como variables de entorno de Pages y genera el archivo
   en el build. Lo simple: commitea `config.js` (la anon key es pública por diseño,
   la seguridad la da RLS).

## Uso
- **Profesor**: elige mes → nuevo viaje (fecha, origen/destino con calle y nº,
  código + curso) → *Calcular km* → *Guardar*. *Generar PDF del mes* = hoja modelo.
  Cálculo: primera ruta OSRM (prioriza autovía); si no hay autovía, la más corta.
  Ida-vuelta = 2×ida redondeado, × 0,26 €/km.
- **Coordinador**: ve todo filtrado por mes/profesor en directo, cambia precio/km,
  genera el PDF de cualquier profesor.

> Nota: `app.py` (Flask+SQLite) queda como prototipo local. La versión nube es
> `public/` + `supabase/` y no necesita servidor Python.
