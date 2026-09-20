"""App control kilometraje profesores.
Uso:  python app.py        -> arranca en http://127.0.0.1:5000
      python app.py --init -> crea DB + usuarios de ejemplo
Mapas gratuitos: Nominatim (geocodificar calle y nº) + OSRM (rutas).
Criterio km: primera ruta propuesta por OSRM (prioriza autovia/via rapida);
si no hay autovia, coincide con la mas corta. Ida-vuelta = 2 x ida.
"""
import sqlite3
import os
from datetime import date, datetime
from functools import wraps

import requests
from flask import (Flask, g, request, redirect, url_for, render_template,
                   flash, session, send_file, jsonify)
from flask_login import (LoginManager, UserMixin, login_user, logout_user,
                         login_required, current_user)
from werkzeug.security import generate_password_hash, check_password_hash

from pdf_hoja import generar_pdf_hoja

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "kilometraje.db")
PRECIO_KM_DEFECTO = 0.26

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "cambia-esta-clave-en-produccion")

login_manager = LoginManager(app)
login_manager.login_view = "login"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OSRM_URL = "https://router.project-osrm.org/route/v1/driving/{coords}"
HEADERS_OSM = {"User-Agent": "KilometrajeApp/1.0 (empresa formacion; contacto empresa)"}


# ---------------- DB ----------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        nombre TEXT NOT NULL,
        nif TEXT DEFAULT '',
        categoria TEXT DEFAULT 'PROFESOR TITULAR',
        proyecto TEXT DEFAULT 'CYL DIGITAL',
        rol TEXT NOT NULL DEFAULT 'profesor'
    );
    CREATE TABLE IF NOT EXISTS viajes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        fecha TEXT NOT NULL,
        origen TEXT NOT NULL,
        destino TEXT NOT NULL,
        km REAL NOT NULL,
        motivo_codigo TEXT DEFAULT '',
        motivo_curso TEXT DEFAULT '',
        precio_km REAL DEFAULT 0.26,
        total REAL NOT NULL,
        origen_geo TEXT DEFAULT '',
        destino_geo TEXT DEFAULT '',
        alternativas TEXT DEFAULT '',
        manual INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (
        clave TEXT PRIMARY KEY,
        valor TEXT
    );
    """)
    cur = db.cursor()
    cur.execute("INSERT OR IGNORE INTO settings (clave, valor) VALUES ('precio_km', '0.26')")
    # usuarios ejemplo si tabla vacia
    n = cur.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if n == 0:
        cur.execute(
            "INSERT INTO users (username, password_hash, nombre, nif, categoria, proyecto, rol)"
            " VALUES (?,?,?,?,?,?,?)",
            ("coordi", generate_password_hash("admin123"),
             "Coordinación", "", "", "", "coordinador"))
        cur.execute(
            "INSERT INTO users (username, password_hash, nombre, nif, categoria, proyecto, rol)"
            " VALUES (?,?,?,?,?,?,?)",
            ("adela", generate_password_hash("adela123"),
             "ADELA RUIZ LAVILLA", "72896446Q", "PROFESOR TITULAR",
             "CYL DIGITAL", "profesor"))
        print("Usuarios creados: coordi/admin123 (coordinador), adela/adela123 (profesora)")
    db.commit()
    db.close()


def get_precio_km():
    try:
        row = get_db().execute(
            "SELECT valor FROM settings WHERE clave='precio_km'").fetchone()
        return float((row["valor"] if row else PRECIO_KM_DEFECTO))
    except Exception:
        return PRECIO_KM_DEFECTO


class User(UserMixin):
    def __init__(self, row):
        self.id = str(row["id"])
        self._row = dict(row)

    @property
    def rol(self):
        return self._row["rol"]

    @property
    def nombre(self):
        return self._row["nombre"]


@login_manager.user_loader
def load_user(user_id):
    row = get_db().execute("SELECT * FROM users WHERE id=?",
                           (user_id,)).fetchone()
    return User(row) if row else None


def rol_requerido(*roles):
    def deco(f):
        @wraps(f)
        def wrap(*a, **kw):
            if not current_user.is_authenticated:
                return redirect(url_for("login"))
            if current_user.rol not in roles:
                flash("Sin permiso.", "error")
                return redirect(url_for("index"))
            return f(*a, **kw)
        return wrap
    return deco


# ---------------- Mapas: Nominatim + OSRM ----------------
def geocode(direccion):
    """Calle y nº (+ pueblo) -> (lat, lon, display_name)."""
    q = direccion.strip()
    if "españa" not in q.lower() and "espana" not in q.lower():
        q += ", España"
    r = requests.get(NOMINATIM_URL,
                     params={"q": q, "format": "json", "limit": 1,
                             "countrycodes": "es"},
                     headers=HEADERS_OSM, timeout=15)
    r.raise_for_status()
    data = r.json()
    if not data:
        raise ValueError(f"No se encontró la dirección: '{direccion}' "
                         f"(prueba 'Calle y nº, Pueblo (Provincia)')")
    return float(data[0]["lat"]), float(data[0]["lon"]), data[0].get(
        "display_name", "")


def calcular_ruta_osrm(origen, destino):
    """Devuelve dict con km_ida, km_ida_vuelta, alternativas.

    Criterio pedido: primera ruta propuesta con autovia y si no, la mas corta.
    OSRM ordena las rutas por tiempo (favorece autovia/via rapida) y la
    primera es la recomendada. Si no hay autovia disponible, la primera
    coincide con la mas corta.
    """
    lat1, lon1, nom1 = geocode(origen)
    lat2, lon2, nom2 = geocode(destino)
    coords = f"{lon1},{lat1};{lon2},{lat2}"
    r = requests.get(OSRM_URL.format(coords=coords),
                     params={"overview": "false", "alternatives": "3",
                             "steps": "false"},
                     timeout=20)
    r.raise_for_status()
    data = r.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise ValueError("OSRM no encontró ruta entre esas direcciones.")
    rutas = sorted(data["routes"], key=lambda x: (x["duration"], x["distance"]))
    # La primera de OSRM ya es la recomendada; la respetamos tal cual
    # (no reordenamos por distancia para no romper el criterio autovia).
    primera = data["routes"][0]
    km_ida = primera["distance"] / 1000.0
    km_iv = round(km_ida * 2)
    alts = [round(x["distance"] / 1000.0 * 2) for x in data["routes"]]
    return {
        "km_ida": round(km_ida, 1),
        "km_ida_vuelta": km_iv,
        "alternativas": alts,
        "origen_geo": f"{lat1},{lon1} ({nom1[:80]})",
        "destino_geo": f"{lat2},{lon2} ({nom2[:80]})",
    }


# ---------------- Rutas web ----------------
@app.route("/")
def index():
    if not current_user.is_authenticated:
        return redirect(url_for("login"))
    if current_user.rol == "coordinador":
        return redirect(url_for("panel_coordinador"))
    return redirect(url_for("panel_profesor"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        p = request.form.get("password", "")
        row = get_db().execute("SELECT * FROM users WHERE username=?",
                               (u,)).fetchone()
        if row and check_password_hash(row["password_hash"], p):
            login_user(User(row))
            return redirect(url_for("index"))
        flash("Usuario o contraseña incorrectos.", "error")
    return render_template("login.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))


def mes_param(default=None):
    m = request.args.get("mes") or request.form.get("mes") or (
        default or date.today().strftime("%Y-%m"))
    try:
        datetime.strptime(m, "%Y-%m")
    except ValueError:
        m = date.today().strftime("%Y-%m")
    return m


@app.route("/profesor")
@login_required
@rol_requerido("profesor")
def panel_profesor():
    mes = mes_param()
    uid = int(current_user.id)
    viajes = get_db().execute(
        "SELECT * FROM viajes WHERE user_id=? AND substr(fecha,1,7)=? "
        "ORDER BY fecha", (uid, mes)).fetchall()
    total = sum(v["total"] for v in viajes)
    precio = get_precio_km()
    return render_template("profesor.html", viajes=viajes, mes=mes,
                           total=total, precio=precio)


@app.route("/viaje/nuevo", methods=["GET", "POST"])
@login_required
@rol_requerido("profesor")
def nuevo_viaje():
    precio = get_precio_km()
    if request.method == "POST":
        fecha = request.form.get("fecha", "").strip()
        origen = request.form.get("origen", "").strip()
        destino = request.form.get("destino", "").strip()
        codigo = request.form.get("motivo_codigo", "").strip()
        curso = request.form.get("motivo_curso", "").strip()
        km_manual = request.form.get("km_manual", "").strip()
        try:
            datetime.strptime(fecha, "%Y-%m-%d")
        except ValueError:
            flash("Fecha no válida.", "error")
            return render_template("viaje_form.html", precio=precio)
        if not origen or not destino or not curso:
            flash("Origen, destino y motivo (curso) son obligatorios. "
                  "Pon calle y número: ej. 'Calle Mayor 1, Noviercas'.",
                  "error")
            return render_template("viaje_form.html", precio=precio)
        try:
            if km_manual:
                km_iv = int(float(km_manual.replace(",", ".")))
                info = {"km_ida_vuelta": km_iv, "km_ida": km_iv / 2,
                        "alternativas": [], "origen_geo": "manual",
                        "destino_geo": "manual"}
                manual = 1
            else:
                info = calcular_ruta_osrm(origen, destino)
                km_iv = info["km_ida_vuelta"]
                manual = 0
        except Exception as e:
            flash(f"No se pudo calcular el kilometraje: {e}", "error")
            return render_template("viaje_form.html", precio=precio,
                                   origen=origen, destino=destino,
                                   codigo=codigo, curso=curso, fecha=fecha)
        total = round(km_iv * precio, 2)
        get_db().execute(
            "INSERT INTO viajes (user_id, fecha, origen, destino, km, "
            "motivo_codigo, motivo_curso, precio_km, total, origen_geo, "
            "destino_geo, alternativas, manual) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (int(current_user.id), fecha, origen, destino, km_iv, codigo,
             curso, precio, total, info["origen_geo"], info["destino_geo"],
             ",".join(map(str, info["alternativas"])), manual))
        get_db().commit()
        flash(f"Viaje guardado: {km_iv} km ida-vuelta ({total:.2f} €).",
              "ok")
        return redirect(url_for("panel_profesor"))
    return render_template("viaje_form.html", precio=precio)


@app.route("/viaje/<int:vid>/borrar", methods=["POST"])
@login_required
@rol_requerido("profesor")
def borrar_viaje(vid):
    get_db().execute("DELETE FROM viajes WHERE id=? AND user_id=?",
                     (vid, int(current_user.id)))
    get_db().commit()
    flash("Viaje eliminado.", "ok")
    return redirect(url_for("panel_profesor"))


@app.route("/api/calcular")
@login_required
def api_calcular():
    """AJAX: calcula km sin guardar. ?origen=..&destino=.."""
    origen = request.args.get("origen", "")
    destino = request.args.get("destino", "")
    if not origen or not destino:
        return jsonify({"ok": False, "error": "Falta origen o destino"}), 400
    try:
        info = calcular_ruta_osrm(origen, destino)
        info["ok"] = True
        info["precio_km"] = get_precio_km()
        info["total"] = round(info["km_ida_vuelta"] * info["precio_km"], 2)
        return jsonify(info)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 422


@app.route("/pdf")
@login_required
def pdf():
    """Genera la hoja PDF del mes. El coordinador puede pedir ?user_id=."""
    mes = mes_param()
    if current_user.rol == "coordinador" and request.args.get("user_id"):
        uid = int(request.args["user_id"])
    else:
        uid = int(current_user.id)
    db = get_db()
    prof = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not prof:
        flash("Profesor no encontrado.", "error")
        return redirect(url_for("index"))
    if current_user.rol == "profesor" and uid != int(current_user.id):
        flash("Solo puedes ver tus datos.", "error")
        return redirect(url_for("index"))
    viajes = db.execute(
        "SELECT * FROM viajes WHERE user_id=? AND substr(fecha,1,7)=? "
        "ORDER BY fecha", (uid, mes)).fetchall()
    if not viajes:
        flash("No hay viajes ese mes.", "error")
        return redirect(request.referrer or url_for("index"))
    salida = os.path.join(BASE_DIR, "HojaKm.pdf")
    generar_pdf_hoja(salida, dict(prof), [dict(v) for v in viajes], mes)
    return send_file(salida, as_attachment=True,
                     download_name=f"HojaKm_{mes}_{prof['username']}.pdf")


@app.route("/coordinador")
@login_required
@rol_requerido("coordinador")
def panel_coordinador():
    mes = mes_param()
    f_prof = request.args.get("profesor", "").strip()
    db = get_db()
    profes = db.execute(
        "SELECT * FROM users WHERE rol='profesor' ORDER BY nombre").fetchall()
    q = ("SELECT v.*, u.nombre AS prof_nombre FROM viajes v "
         "JOIN users u ON u.id=v.user_id "
         "WHERE substr(v.fecha,1,7)=? ")
    args = [mes]
    if f_prof:
        q += "AND u.nombre LIKE ? "
        args.append(f"%{f_prof}%")
    q += "ORDER BY v.fecha, u.nombre"
    viajes = db.execute(q, args).fetchall()
    total = sum(v["total"] for v in viajes)
    return render_template("coordinador.html", viajes=viajes, mes=mes,
                           profes=profes, total=total,
                           f_prof=f_prof, precio=get_precio_km())


@app.route("/usuarios", methods=["GET", "POST"])
@login_required
@rol_requerido("coordinador")
def usuarios():
    db = get_db()
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        nombre = request.form.get("nombre", "").strip()
        nif = request.form.get("nif", "").strip().upper()
        categoria = request.form.get("categoria", "PROFESOR TITULAR").strip()
        proyecto = request.form.get("proyecto", "CYL DIGITAL").strip()
        rol = request.form.get("rol", "profesor").strip()
        pwd = request.form.get("password", "").strip() or "cambia123"
        if not username or not nombre:
            flash("Usuario y nombre son obligatorios.", "error")
        else:
            try:
                db.execute("INSERT INTO users (username, password_hash, "
                           "nombre, nif, categoria, proyecto, rol) "
                           "VALUES (?,?,?,?,?,?,?)",
                           (username, generate_password_hash(pwd), nombre,
                            nif, categoria, proyecto, rol))
                db.commit()
                flash(f"Usuario {username} creado (clave inicial: {pwd}).",
                      "ok")
            except sqlite3.IntegrityError:
                flash("Ese nombre de usuario ya existe.", "error")
    profes = db.execute("SELECT * FROM users ORDER BY rol, nombre").fetchall()
    return render_template("usuarios.html", profes=profes,
                           precio=get_precio_km())


@app.route("/ajustes", methods=["POST"])
@login_required
@rol_requerido("coordinador")
def ajustes():
    try:
        p = float(request.form.get("precio_km", "0.26").replace(",", "."))
        get_db().execute(
            "INSERT INTO settings (clave, valor) VALUES ('precio_km', ?) "
            "ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor", (str(p),))
        get_db().commit()
        flash(f"Precio por km actualizado a {p:.2f} €.", "ok")
    except ValueError:
        flash("Precio no válido.", "error")
    return redirect(url_for("usuarios"))


if __name__ == "__main__":
    import sys
    if "--init" in sys.argv or not os.path.exists(DB_PATH):
        init_db()
    app.run(debug=True, host="127.0.0.1", port=5000)
