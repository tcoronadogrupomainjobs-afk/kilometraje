# Actualizar la app (GitHub + Cloudflare Pages)

La web que ven los usuarios sale de la carpeta **`public/`** del repo de GitHub.
Cada vez que subes cambios al repo, Cloudflare **redespliega solo** en 1–2 minutos.

## Qué subir y qué no

Subir (manteniendo las carpetas):

- `public/` entera (`index.html`, `app.js`, `style.css`, `logo.js`, `logo.png`, `config.js`)
- `supabase/` (`schema.sql`, por si hay que aplicar migraciones)
- `app.py`, `README_DEPLOY.md`, `ACTUALIZAR.md`, `MANUAL.md`, `.gitignore`

NO subir (restos locales):

- `kilometraje.db`, `HojaKm*.pdf`, `__pycache__/`, `node_modules/`

Ojo con `public/config.js`: lleva las claves de Supabase y **tiene que estar** en el repo,
si no la nube entra en "modo demo". Solo hay que volver a subirlo si cambian las claves.

## Opción A: desde la web de GitHub

1. Abre el repo → pestaña **Code** → **Add file → Upload files**.
2. Arrastra los archivos cambiados **en su misma ruta** (p. ej. `public/app.js`).
3. **Commit changes** directo a `main`.

## Opción B: con GitHub Desktop

1. *File → Add local repository* → carpeta del proyecto.
2. Escribe el resumen del cambio abajo a la izquierda → **Commit**.
3. **Push origin** arriba.

## Comprobar el despliegue

1. Cloudflare Dashboard → **Workers & Pages** → tu proyecto → **Deployments**:
   arriba debe aparecer un despliegue nuevo en **Success**.
2. Abre la web y recarga con **Ctrl+F5** (evita caché vieja).

## Si no se actualiza

- Mira que el despliegue esté en **Success**; si no, **Retry deployment**.
- Si sale *"This project is disconnected from your Git account"*:
  proyecto → **Settings → Builds & deployments** → **Reconnect**, autoriza GitHub,
  elige repo y rama `main`, guarda.
- Tras editar `app.js` o `style.css`, sube el `?v=` de `index.html`
  (p. ej. `app.js?v=20260920a` → `...b`) para que los navegadores no usen la copia vieja.

## Cambios en la base de datos

Si el cambio incluye columnas/tablas nuevas, aplica la parte nueva del
`supabase/schema.sql` en Supabase → **SQL Editor** (el archivo trae bloques
de migración `if not exists`, se puede repetir sin romper nada).
