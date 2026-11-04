// ============================================================
// App de tareas - Node.js + Express + PostgreSQL (opcional)
// Proyecto de Sistemas Operativos: Docker & Docker Compose
//
// Modo BASE DE DATOS : si existe la variable DB_HOST se conecta a PostgreSQL.
// Modo MEMORIA       : si NO existe DB_HOST, guarda las tareas en memoria
//                      (útil para probar la app sin instalar PostgreSQL).
// ============================================================
const express = require('express');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 3000;
const USE_DB = Boolean(process.env.DB_HOST);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Capa de datos ----------
let store;

if (USE_DB) {
  const { Pool } = require('pg');
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'secret',
    database: process.env.DB_NAME || 'appdb',
  });

  store = {
    modo: 'postgresql',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tareas (
          id SERIAL PRIMARY KEY,
          titulo TEXT NOT NULL,
          completada BOOLEAN NOT NULL DEFAULT FALSE,
          creada TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    },
    async listar() {
      const r = await pool.query('SELECT * FROM tareas ORDER BY id DESC');
      return r.rows;
    },
    async crear(titulo) {
      const r = await pool.query(
        'INSERT INTO tareas (titulo) VALUES ($1) RETURNING *', [titulo]);
      return r.rows[0];
    },
    async alternar(id) {
      const r = await pool.query(
        'UPDATE tareas SET completada = NOT completada WHERE id = $1 RETURNING *', [id]);
      return r.rows[0];
    },
    async borrar(id) {
      const r = await pool.query('DELETE FROM tareas WHERE id = $1', [id]);
      return r.rowCount > 0;
    },
    async ping() { await pool.query('SELECT 1'); },
  };
} else {
  let tareas = [];
  let siguienteId = 1;
  store = {
    modo: 'memoria',
    async init() {},
    async listar() { return [...tareas].reverse(); },
    async crear(titulo) {
      const t = { id: siguienteId++, titulo, completada: false, creada: new Date().toISOString() };
      tareas.push(t);
      return t;
    },
    async alternar(id) {
      const t = tareas.find((x) => x.id === id);
      if (t) t.completada = !t.completada;
      return t;
    },
    async borrar(id) {
      const antes = tareas.length;
      tareas = tareas.filter((x) => x.id !== id);
      return tareas.length < antes;
    },
    async ping() {},
  };
}

// ---------- Rutas ----------
// Healthcheck (se usará en la Práctica 12 con Docker Compose)
app.get('/health', async (req, res) => {
  try {
    await store.ping();
    res.json({ estado: 'ok', almacenamiento: store.modo });
  } catch (err) {
    res.status(503).json({ estado: 'error', detalle: err.message });
  }
});

// Información del contenedor (sirve para ver qué instancia atendió la petición)
app.get('/api/info', (req, res) => {
  res.json({
    hostname: os.hostname(), // dentro de Docker = ID corto del contenedor
    plataforma: `${os.type()} ${os.release()}`,
    node: process.version,
    almacenamiento: store.modo,
    uptime_segundos: Math.round(process.uptime()),
    cabeceras_proxy: {
      host: req.headers.host,
      'x-forwarded-for': req.headers['x-forwarded-for'] || null,
    },
  });
});

app.get('/api/tareas', async (req, res, next) => {
  try { res.json(await store.listar()); } catch (e) { next(e); }
});

app.post('/api/tareas', async (req, res, next) => {
  try {
    const titulo = String(req.body.titulo || '').trim();
    if (!titulo) return res.status(400).json({ error: 'El título es obligatorio.' });
    if (titulo.length > 200) return res.status(400).json({ error: 'Máximo 200 caracteres.' });
    res.status(201).json(await store.crear(titulo));
  } catch (e) { next(e); }
});

app.patch('/api/tareas/:id', async (req, res, next) => {
  try {
    const t = await store.alternar(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Tarea no encontrada.' });
    res.json(t);
  } catch (e) { next(e); }
});

app.delete('/api/tareas/:id', async (req, res, next) => {
  try {
    const ok = await store.borrar(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Tarea no encontrada.' });
    res.status(204).end();
  } catch (e) { next(e); }
});

// Manejo de errores
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ---------- Arranque ----------
// Reintenta la conexión a la BD: en Docker Compose Postgres puede tardar
// unos segundos en aceptar conexiones aunque su contenedor ya esté "up".
async function iniciar() {
  const intentos = 15;
  for (let i = 1; i <= intentos; i++) {
    try {
      await store.init();
      break;
    } catch (err) {
      console.log(`[db] intento ${i}/${intentos} falló: ${err.message}`);
      if (i === intentos) { console.error('[db] sin conexión, abortando.'); process.exit(1); }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor escuchando en el puerto ${PORT} | almacenamiento: ${store.modo}`);
  });
}

// Cierre ordenado: docker stop envía SIGTERM
['SIGTERM', 'SIGINT'].forEach((sig) =>
  process.on(sig, () => { console.log(`${sig} recibido, cerrando...`); process.exit(0); }));

iniciar();
