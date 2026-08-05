const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const i = value.indexOf('=');
    if (i < 1) continue;
    const key = value.slice(0, i).trim();
    let val = value.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECT_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = path.resolve(process.env.DATA_DIR || PROJECT_DATA_DIR);
const LOCATIONS_FILE = path.join(DATA_DIR, 'locations.json');
const SEED_FILE = path.join(PROJECT_DATA_DIR, 'locations.seed.json');
const DEMO_PRODUCTS_FILE = path.join(PROJECT_DATA_DIR, 'demo-products.json');
const CATALOG_MODE = String(process.env.CATALOG_MODE || 'demo').toLowerCase();
const SYNC_INTERVAL_MINUTES = Math.max(1, Number(process.env.SYNC_INTERVAL_MINUTES || 10));

function normalizeSku(v) { return String(v || '').trim().toUpperCase(); }
function brandFromCode(code) {
  const p = normalizeSku(code).charAt(0);
  if (p === 'C') return 'Crusec';
  if (p === 'P') return 'Pitaya';
  if (p === 'Y') return 'Yozen';
  return 'Sin identificar';
}

function ensureLocationFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LOCATIONS_FILE)) {
    const seed = fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, 'utf8') : '{"locations":{}}';
    fs.writeFileSync(LOCATIONS_FILE, seed);
  }
}
function readLocations() {
  ensureLocationFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));
    return { locations: parsed.locations && typeof parsed.locations === 'object' ? parsed.locations : {} };
  } catch (error) {
    console.error('Error leyendo ubicaciones:', error);
    return { locations: {} };
  }
}
function writeLocations(db) {
  ensureLocationFile();
  const tmp = `${LOCATIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, LOCATIONS_FILE);
}
function readDemoProducts() {
  const parsed = JSON.parse(fs.readFileSync(DEMO_PRODUCTS_FILE, 'utf8'));
  return Array.isArray(parsed.products) ? parsed.products : [];
}

async function getCatalog() {
  if (CATALOG_MODE === 'relbase') {
    const relbase = require('./src/relbase');
    return relbase.listProducts();
  }
  return readDemoProducts();
}

function mergeLocation(product, locationsDb) {
  const saved = locationsDb.locations[normalizeSku(product.sku)] || {};
  return {
    ...product,
    sku: normalizeSku(product.sku),
    brand: product.brand || brandFromCode(product.sku),
    location: saved.location || null,
    locationUpdatedAt: saved.locationUpdatedAt || null,
    locationUpdatedBy: saved.locationUpdatedBy || null,
  };
}
function publicProduct(product) {
  return {
    relbaseId: product.relbaseId || product.sku,
    sku: normalizeSku(product.sku),
    name: product.name || 'Producto sin nombre',
    barcode: product.barcode || '',
    brand: product.brand || brandFromCode(product.sku),
    active: product.active !== false,
    stock: product.stock ?? null,
    stockUpdatedAt: product.stockUpdatedAt || null,
    location: product.location || null,
    locationUpdatedAt: product.locationUpdatedAt || null,
    locationUpdatedBy: product.locationUpdatedBy || null,
  };
}

function validateLocation(input) {
  const aisle = Number(input.aisle);
  const side = String(input.side || '').trim().toUpperCase();
  const rack = Number(input.rack);
  const level = Number(input.level);
  const maxAisle = Number(process.env.MAX_AISLE || 6);
  const maxRack = Number(process.env.MAX_RACK || 11);
  const maxLevel = Number(process.env.MAX_LEVEL || 6);
  if (!Number.isInteger(aisle) || aisle < 1 || aisle > maxAisle) return `El pasillo debe estar entre 1 y ${maxAisle}.`;
  if (!['D', 'I'].includes(side)) return 'El lado debe ser D (derecho) o I (izquierdo).';
  if (!Number.isInteger(rack) || rack < 1 || rack > maxRack) return `El rack debe estar entre 1 y ${maxRack}.`;
  if (!Number.isInteger(level) || level < 1 || level > maxLevel) return `El nivel debe estar entre 1 y ${maxLevel}.`;
  const sideLabel = side === 'D' ? 'Derecho' : 'Izquierdo';
  return { aisle, side, sideLabel, rack, level, fullLabel: `Pasillo ${aisle} — lado ${sideLabel.toLowerCase()} — rack ${rack} — nivel ${level}` };
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('La solicitud no contiene JSON válido.'); }
}

async function productSnapshot() {
  const [catalog, locations] = await Promise.all([getCatalog(), Promise.resolve(readLocations())]);
  return catalog.map(p => mergeLocation(p, locations));
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, {
      relbaseEnabled: CATALOG_MODE === 'relbase',
      mode: CATALOG_MODE,
      lastSyncAt: null,
      syncStatus: CATALOG_MODE === 'relbase' ? 'Relbase configurado' : 'Modo demo: Relbase pendiente de conectar',
      productCount: (await getCatalog()).length,
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      storage: DATA_DIR,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/products/search') {
    const sku = normalizeSku(url.searchParams.get('sku'));
    if (!sku) return sendJson(res, 400, { error: 'Debes ingresar un SKU o código de barras.' });
    const products = await productSnapshot();
    const product = products.find(p => normalizeSku(p.sku) === sku || normalizeSku(p.barcode) === sku);
    if (!product) return sendJson(res, 404, { error: 'Código de producto no registrado.' });
    return sendJson(res, 200, { product: publicProduct(product), lastSyncAt: null });
  }

  if (req.method === 'GET' && url.pathname === '/api/products') {
    const filter = String(url.searchParams.get('filter') || 'all');
    const q = String(url.searchParams.get('q') || '').trim().toUpperCase();
    let products = await productSnapshot();
    if (filter === 'unassigned') products = products.filter(p => !p.location);
    if (filter === 'assigned') products = products.filter(p => Boolean(p.location));
    if (filter === 'with-stock') products = products.filter(p => Number(p.stock) > 0);
    if (filter === 'without-stock') products = products.filter(p => Number(p.stock) === 0);
    if (q) products = products.filter(p => normalizeSku(p.sku).includes(q) || String(p.name || '').toUpperCase().includes(q) || String(p.brand || '').toUpperCase().includes(q));
    products.sort((a, b) => Boolean(a.location) === Boolean(b.location) ? a.sku.localeCompare(b.sku) : (a.location ? 1 : -1));
    return sendJson(res, 200, {
      products: products.map(publicProduct),
      lastSyncAt: null,
      syncStatus: CATALOG_MODE === 'relbase' ? 'Relbase conectado' : 'Modo demo: Relbase pendiente de conectar',
    });
  }

  const match = url.pathname.match(/^\/api\/products\/([^/]+)\/location$/);
  if (match && req.method === 'PUT') {
    const sku = normalizeSku(decodeURIComponent(match[1]));
    const products = await getCatalog();
    const exists = products.some(p => normalizeSku(p.sku) === sku);
    if (!exists) return sendJson(res, 404, { error: 'Producto no encontrado.' });
    const body = await readBody(req);
    const location = validateLocation(body);
    if (typeof location === 'string') return sendJson(res, 400, { error: location });
    const db = readLocations();
    db.locations[sku] = {
      location,
      locationUpdatedAt: new Date().toISOString(),
      locationUpdatedBy: String(body.updatedBy || 'Sin identificar').trim() || 'Sin identificar',
    };
    writeLocations(db);
    const product = mergeLocation(products.find(p => normalizeSku(p.sku) === sku), db);
    return sendJson(res, 200, { product: publicProduct(product), message: 'Ubicación guardada correctamente.' });
  }

  if (match && req.method === 'DELETE') {
    const sku = normalizeSku(decodeURIComponent(match[1]));
    const products = await getCatalog();
    const base = products.find(p => normalizeSku(p.sku) === sku);
    if (!base) return sendJson(res, 404, { error: 'Producto no encontrado.' });
    const db = readLocations();
    delete db.locations[sku];
    writeLocations(db);
    return sendJson(res, 200, { product: publicProduct(mergeLocation(base, db)), message: 'Ubicación eliminada.' });
  }

  if (req.method === 'POST' && url.pathname === '/api/sync') {
    if (CATALOG_MODE !== 'relbase') {
      return sendJson(res, 409, { error: 'Relbase todavía no está conectado. La app está funcionando con productos de demostración.' });
    }
    return sendJson(res, 200, { message: 'Relbase trabaja en lectura directa; no hay cambios que enviar a Relbase.' });
  }

  return sendJson(res, 404, { error: 'Ruta no encontrada.' });
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Acceso denegado');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendText(res, 404, 'Archivo no encontrado');
  const ext = path.extname(file).toLowerCase();
  const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.png':'image/png', '.ico':'image/x-icon', '.json':'application/json; charset=utf-8' };
  const content = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300' });
  res.end(content);
}

ensureLocationFile();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || 'Error interno del servidor.' });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`Crusec Bodega disponible en http://localhost:${PORT}`);
  console.log(`Catálogo: ${CATALOG_MODE}. Ubicaciones: ${LOCATIONS_FILE}`);
});
