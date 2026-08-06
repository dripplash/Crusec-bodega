const fs = require('fs');
const path = require('path');

const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = path.resolve(process.env.DATA_DIR || PROJECT_DATA_DIR);
const TOKEN_FILE = path.join(DATA_DIR, 'relbase-token.json');

const RELBASE_BASE_URL = String(process.env.RELBASE_BASE_URL || 'https://api.relbase.cl').replace(/\/+$/, '');
const RELBASE_AUTH_URL = process.env.RELBASE_AUTH_URL || `${RELBASE_BASE_URL}/oauth/authorize`;
const RELBASE_TOKEN_URL = process.env.RELBASE_TOKEN_URL || `${RELBASE_BASE_URL}/oauth/token`;
const RELBASE_PRODUCTS_URL = process.env.RELBASE_PRODUCTS_URL || `${RELBASE_BASE_URL}/api/v2/productos`;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getConfig() {
  return {
    clientId: process.env.RELBASE_CLIENT_ID || '',
    clientSecret: process.env.RELBASE_CLIENT_SECRET || '',
    redirectUri: process.env.RELBASE_REDIRECT_URI || '',
    scopes: process.env.RELBASE_SCOPES || 'products:read inventory:read warehouses:read',
    authUrl: RELBASE_AUTH_URL,
    tokenUrl: RELBASE_TOKEN_URL,
    productsUrl: RELBASE_PRODUCTS_URL,
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

function readToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (error) {
    console.error('Error leyendo token Relbase:', error);
    return null;
  }
}

function saveToken(token, previous = null) {
  ensureDataDir();

  const expiresIn = Number(token.expires_in || 900);
  const expiresAt = token.expires_at || new Date(Date.now() + expiresIn * 1000).toISOString();

  const stored = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || previous?.refresh_token || null,
    token_type: token.token_type || previous?.token_type || 'Bearer',
    scope: token.scope || previous?.scope || '',
    expires_in: expiresIn,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };

  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2));
  fs.renameSync(tmp, TOKEN_FILE);

  return stored;
}

function tokenStillValid(token) {
  if (!token?.access_token || !token?.expires_at) return false;
  const expiresAt = new Date(token.expires_at).getTime();
  if (Number.isNaN(expiresAt)) return false;

  // Renovar con 60 segundos de margen.
  return expiresAt > Date.now() + 60_000;
}

async function requestToken(params) {
  const config = getConfig();

  if (!isConfigured()) {
    throw new Error('Relbase no está configurado. Revisa RELBASE_CLIENT_ID, RELBASE_CLIENT_SECRET y RELBASE_REDIRECT_URI en Railway.');
  }

  const body = new URLSearchParams({
    ...params,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    console.error('Error token Relbase:', response.status, payload);
    throw new Error(payload.error_description || payload.error || `Relbase rechazó la solicitud de token (${response.status}).`);
  }

  if (!payload.access_token) {
    console.error('Respuesta token Relbase sin access_token:', payload);
    throw new Error('Relbase no devolvió access_token.');
  }

  return payload;
}

async function exchangeCodeForToken(code) {
  const config = getConfig();

  const token = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  return saveToken(token);
}

async function refreshAccessToken() {
  const previous = readToken();

  if (!previous?.refresh_token) {
    throw new Error('Relbase todavía no está autorizado. Entra a /auth/login para autorizar la aplicación.');
  }

  const token = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: previous.refresh_token,
  });

  return saveToken(token, previous);
}

async function getValidAccessToken() {
  const current = readToken();

  if (tokenStillValid(current)) {
    return current.access_token;
  }

  const refreshed = await refreshAccessToken();
  return refreshed.access_token;
}

function getAuthUrl(state) {
  const config = getConfig();

  if (!isConfigured()) {
    throw new Error('Relbase no está configurado. Faltan variables en Railway.');
  }

  const url = new URL(config.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);

  return url.toString();
}

function status() {
  const token = readToken();

  return {
    configured: isConfigured(),
    authorized: Boolean(token?.refresh_token || token?.access_token),
    tokenExpiresAt: token?.expires_at || null,
    productsUrl: RELBASE_PRODUCTS_URL,
  };
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function nestedName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return firstValue(value.nombre, value.name, value.descripcion, value.description);
  }
  return '';
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sumStockArray(items) {
  if (!Array.isArray(items)) return null;

  let total = 0;
  let found = false;

  for (const item of items) {
    const qty = numberOrNull(firstValue(
      item.stock,
      item.stock_total,
      item.stock_disponible,
      item.disponible,
      item.cantidad,
      item.quantity,
      item.qty,
      item.saldo
    ));

    if (qty !== null) {
      total += qty;
      found = true;
    }
  }

  return found ? total : null;
}

function detectStock(product) {
  const direct = numberOrNull(firstValue(
    product.stock,
    product.stock_total,
    product.stock_disponible,
    product.disponible,
    product.cantidad,
    product.quantity,
    product.qty,
    product.saldo
  ));

  if (direct !== null) return direct;

  return (
    sumStockArray(product.inventarios) ??
    sumStockArray(product.inventory) ??
    sumStockArray(product.stocks) ??
    sumStockArray(product.bodegas) ??
    sumStockArray(product.warehouses) ??
    null
  );
}

function normalizeProduct(product) {
  const sku = String(firstValue(
    product.sku,
    product.SKU,
    product.codigo,
    product.código,
    product.codigo_sku,
    product.codigo_producto,
    product.codigoProducto,
    product.code,
    product.internal_code,
    product.barcode,
    product.codigo_barras,
    product.id
  )).trim().toUpperCase();

  const name = String(firstValue(
    product.nombre,
    product.name,
    product.descripcion,
    product.description,
    product.titulo,
    product.title,
    `Producto ${sku}`
  )).trim();

  const barcode = String(firstValue(
    product.barcode,
    product.codigo_barras,
    product.codigoBarra,
    product.codigo_barra,
    product.ean,
    product.upc
  )).trim();

  const brand = String(firstValue(
    product.marca,
    product.brand,
    nestedName(product.marca),
    nestedName(product.brand)
  )).trim();

  const activeValue = firstValue(product.active, product.activo, product.estado, product.status, true);
  const active = typeof activeValue === 'boolean'
    ? activeValue
    : !['false', '0', 'inactivo', 'inactive', 'disabled'].includes(String(activeValue).toLowerCase());

  return {
    relbaseId: product.id || product.relbaseId || sku,
    sku,
    name,
    barcode,
    brand,
    active,
    stock: detectStock(product),
    stockUpdatedAt: product.stockUpdatedAt || product.updated_at || product.fecha_actualizacion || null,
  };
}

function extractProducts(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.products)) return payload.products;
  if (Array.isArray(payload.productos)) return payload.productos;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;

  if (payload.data && typeof payload.data === 'object') {
    return extractProducts(payload.data);
  }

  return [];
}

async function fetchProductsPage(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    console.error('Error productos Relbase:', response.status, payload);
    throw new Error(payload.error_description || payload.error || `Relbase rechazó la consulta de productos (${response.status}).`);
  }

  return payload;
}

function nextPageUrl(payload) {
  const next =
    payload?.links?.next ||
    payload?.pagination?.next ||
    payload?.meta?.next ||
    payload?.next;

  if (!next) return null;

  try {
    return new URL(next, RELBASE_PRODUCTS_URL).toString();
  } catch {
    return null;
  }
}

async function listProducts() {
  const accessToken = await getValidAccessToken();

  let url = RELBASE_PRODUCTS_URL;
  const all = [];

  // Máximo 20 páginas para evitar loops infinitos si la API pagina.
  for (let page = 0; page < 20 && url; page += 1) {
    const payload = await fetchProductsPage(url, accessToken);
    const products = extractProducts(payload);
    all.push(...products);

    url = nextPageUrl(payload);
  }

  const normalized = all
    .map(normalizeProduct)
    .filter((product) => product.sku);

  return normalized;
}

module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  listProducts,
  status,
};
