const fs = require('fs');
const path = require('path');

const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = path.resolve(process.env.DATA_DIR || PROJECT_DATA_DIR);
const TOKEN_FILE = path.join(DATA_DIR, 'relbase-token.json');

const RELBASE_BASE_URL = String(process.env.RELBASE_BASE_URL || 'https://api.relbase.cl').replace(/\/+$/, '');
const RELBASE_AUTH_URL = process.env.RELBASE_AUTH_URL || `${RELBASE_BASE_URL}/oauth/authorize`;
const RELBASE_TOKEN_URL = process.env.RELBASE_TOKEN_URL || `${RELBASE_BASE_URL}/oauth/token`;
const RELBASE_PRODUCTS_URL = process.env.RELBASE_PRODUCTS_URL || `${RELBASE_BASE_URL}/api/v2/productos`;
const RELBASE_MAIN_WAREHOUSE_NAME = String(
  process.env.RELBASE_MAIN_WAREHOUSE_NAME || 'Bodega principal'
).toLowerCase();
const RELBASE_MAIN_WAREHOUSE_ID = String(process.env.RELBASE_MAIN_WAREHOUSE_ID || '').trim();
const RELBASE_MAIN_WAREHOUSE_CODE = String(process.env.RELBASE_MAIN_WAREHOUSE_CODE || '').trim();
const RELBASE_LIVE_STOCK_ENABLED = String(
  process.env.RELBASE_LIVE_STOCK_ENABLED || 'true'
).toLowerCase() !== 'false';
const RELBASE_SAFETY_MAX_PAGES = Math.max(
  1000,
  Number(process.env.RELBASE_SAFETY_MAX_PAGES || 10000)
);
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

    const error = new Error(payload.error_description || payload.error || `Relbase rechazó la solicitud de token (${response.status}).`);
    error.status = response.status;
    error.payload = payload;
    throw error;
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
    safetyMaxPages: RELBASE_SAFETY_MAX_PAGES,
  };
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }

  return '';
}

function cleanText(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function cleanSku(value) {
  return cleanText(value).toUpperCase();
}

function nestedName(value) {
  if (!value) return '';

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    return firstValue(
      value.nombre,
      value.name,
      value.descripcion,
      value.description,
      value.label,
      value.title
    );
  }

  return '';
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;

  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function stockValueFromItem(item) {
  return numberOrNull(firstValue(
    item.stock_disponible,
    item.stockDisponible,
    item.disponible,
    item.available,
    item.available_quantity,
    item.availableQuantity,
    item.stock_available,
    item.stockAvailable,
    item.stock,
    item.stock_total,
    item.stockTotal,
    item.cantidad,
    item.quantity,
    item.qty,
    item.saldo,
    item.balance,
    item.on_hand,
    item.onHand
  ));
}

function compactText(value) {
  return cleanText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function warehouseText(item) {
  return compactText(firstValue(
    item.bodega_nombre,
    item.bodegaNombre,
    item.warehouse_name,
    item.warehouseName,
    item.almacen_nombre,
    item.almacenNombre,
    item.nombre_bodega,
    item.nombreBodega,
    item.nombre,
    item.name,
    item.descripcion,
    item.description,
    item.ubicacion,
    item.location,
    nestedName(item.bodega),
    nestedName(item.warehouse),
    nestedName(item.almacen),
    nestedName(item.store)
  ));
}

function warehouseIdText(item) {
  return cleanText(firstValue(
    item.bodega_id,
    item.bodegaId,
    item.id_bodega,
    item.idBodega,
    item.warehouse_id,
    item.warehouseId,
    item.almacen_id,
    item.almacenId,
    item.bodega?.id,
    item.warehouse?.id,
    item.almacen?.id
  ));
}

function warehouseCodeText(item) {
  return cleanText(firstValue(
    item.bodega_codigo,
    item.bodegaCodigo,
    item.codigo_bodega,
    item.codigoBodega,
    item.warehouse_code,
    item.warehouseCode,
    item.almacen_codigo,
    item.almacenCodigo,
    item.bodega?.codigo,
    item.warehouse?.code,
    item.almacen?.codigo
  ));
}

function isMainWarehouseItem(item) {
  const text = warehouseText(item);
  const id = warehouseIdText(item);
  const code = warehouseCodeText(item);

  if (RELBASE_MAIN_WAREHOUSE_ID && id && id === RELBASE_MAIN_WAREHOUSE_ID) return true;
  if (RELBASE_MAIN_WAREHOUSE_CODE && code && code === RELBASE_MAIN_WAREHOUSE_CODE) return true;

  const target = compactText(RELBASE_MAIN_WAREHOUSE_NAME);
  if (!text && !target) return false;

  return (
    text.includes(target) ||
    text.includes('bodega principal') ||
    text.includes('casa matriz') ||
    text.includes('principal')
  );
}

function stockFromMainWarehouseArray(items) {
  if (!Array.isArray(items)) return null;

  for (const item of items) {
    if (!isMainWarehouseItem(item)) continue;

    const qty = stockValueFromItem(item);
    if (qty !== null) return qty;
  }

  return null;
}

function sumStockArray(items) {
  if (!Array.isArray(items)) return null;

  let total = 0;
  let found = false;

  for (const item of items) {
    const qty = stockValueFromItem(item);

    if (qty !== null) {
      total += qty;
      found = true;
    }
  }

  return found ? total : null;
}

function detectStock(product) {
  /*
   * Importante:
   * Relbase puede entregar más de un número de stock.
   * Para Crusec necesitamos priorizar el disponible/actual antes que el stock general.
   */
  const availableDirect = numberOrNull(firstValue(
    product.stock_disponible,
    product.stockDisponible,
    product.disponible,
    product.available,
    product.available_quantity,
    product.availableQuantity,
    product.stock_available,
    product.stockAvailable,
    product.stock_actual,
    product.stockActual,
    product.stock_actual_disponible,
    product.stockActualDisponible,
    product.total_stock_disponible,
    product.totalStockDisponible
  ));

  if (availableDirect !== null) return availableDirect;

  const mainWarehouseStock =
    stockFromMainWarehouseArray(product.inventarios) ??
    stockFromMainWarehouseArray(product.inventory) ??
    stockFromMainWarehouseArray(product.inventories) ??
    stockFromMainWarehouseArray(product.stocks) ??
    stockFromMainWarehouseArray(product.bodegas) ??
    stockFromMainWarehouseArray(product.warehouses) ??
    stockFromMainWarehouseArray(product.stock_bodegas) ??
    stockFromMainWarehouseArray(product.stockBodegas) ??
    stockFromMainWarehouseArray(product.detalle_bodegas) ??
    stockFromMainWarehouseArray(product.detalleBodegas);

  if (mainWarehouseStock !== null) return mainWarehouseStock;

  const direct = numberOrNull(firstValue(
    product.stock,
    product.stock_total,
    product.stockTotal,
    product.cantidad,
    product.quantity,
    product.qty,
    product.saldo,
    product.balance,
    product.on_hand,
    product.onHand
  ));

  if (direct !== null) return direct;

  return (
    sumStockArray(product.inventarios) ??
    sumStockArray(product.inventory) ??
    sumStockArray(product.inventories) ??
    sumStockArray(product.stocks) ??
    sumStockArray(product.bodegas) ??
    sumStockArray(product.warehouses) ??
    sumStockArray(product.stock_bodegas) ??
    sumStockArray(product.stockBodegas) ??
    sumStockArray(product.detalle_bodegas) ??
    sumStockArray(product.detalleBodegas) ??
    null
  );
}

function normalizeProduct(product) {
  const sku = cleanSku(firstValue(
    product.sku,
    product.SKU,
    product.codigo,
    product.código,
    product.codigo_sku,
    product.codigoSku,
    product.codigo_producto,
    product.codigoProducto,
    product.code,
    product.internal_code,
    product.internalCode,
    product.barcode,
    product.codigo_barras,
    product.codigoBarras,
    product.codigo_barra,
    product.codigoBarra,
    product.id
  ));

  const name = cleanText(firstValue(
    product.nombre,
    product.name,
    product.descripcion,
    product.description,
    product.titulo,
    product.title,
    product.nombre_producto,
    product.nombreProducto,
    `Producto ${sku}`
  ));

  const barcode = cleanText(firstValue(
    product.barcode,
    product.codigo_barras,
    product.codigoBarras,
    product.codigoBarra,
    product.codigo_barra,
    product.ean,
    product.upc
  ));

  const brand = detectBrand(product);

  const activeValue = firstValue(
    product.active,
    product.activo,
    product.estado,
    product.status,
    true
  );

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
    stockUpdatedAt: product.stockUpdatedAt || product.updated_at || product.updatedAt || product.fecha_actualizacion || null,
  };
}

function extractProducts(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload.products)) return payload.products;
  if (Array.isArray(payload.productos)) return payload.productos;
  if (Array.isArray(payload.resources)) return payload.resources;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;

  if (payload.data && typeof payload.data === 'object') {
    if (Array.isArray(payload.data.resources)) return payload.data.resources;
    if (Array.isArray(payload.data.productos)) return payload.data.productos;
    if (Array.isArray(payload.data.products)) return payload.data.products;

    return extractProducts(payload.data);
  }

  return [];
}

function logDebugRelbase(payload, url) {
  if (global.__RELBASE_DEBUG_LOGGED__) return;

  global.__RELBASE_DEBUG_LOGGED__ = true;

  const sampleProducts = extractProducts(payload);
  const first = sampleProducts[0];

  console.log('========== DEBUG RELBASE ==========');
  console.log('URL consultada:', url);
  console.log('Campos principales de respuesta:', Object.keys(payload || {}));
  console.log('Meta:', JSON.stringify(payload?.meta || payload?.pagination || {}, null, 2));
  console.log('Cantidad en esta página:', sampleProducts.length);

  if (first) {
    console.log('Campos del primer producto:', Object.keys(first));
    console.log('Primer producto muestra:', JSON.stringify(first, null, 2).slice(0, 6000));
  } else {
    console.log('No se encontró producto de muestra en esta página.');
    console.log('Respuesta muestra:', JSON.stringify(payload, null, 2).slice(0, 6000));
  }

  console.log('======== FIN DEBUG RELBASE ========');
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

    const error = new Error(payload.error_description || payload.error || `Relbase rechazó la consulta de productos (${response.status}).`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  logDebugRelbase(payload, url);

  return payload;
}

function nextPageUrl(payload, currentUrl) {
  const directNext =
    payload?.links?.next ||
    payload?.pagination?.next ||
    payload?.meta?.next ||
    payload?.next;

  if (directNext) {
    try {
      return new URL(directNext, RELBASE_PRODUCTS_URL).toString();
    } catch {
      return null;
    }
  }

  const meta = payload?.meta || payload?.pagination || {};

  let nextPage = numberOrNull(firstValue(
    meta.next_page,
    meta.nextPage,
    meta.next
  ));

  const currentPage = numberOrNull(firstValue(
    meta.current_page,
    meta.currentPage,
    meta.page
  ));

  const totalPages = numberOrNull(firstValue(
    meta.total_pages,
    meta.totalPages,
    meta.pages
  ));

  if (nextPage === null && currentPage !== null && totalPages !== null && currentPage < totalPages) {
    nextPage = currentPage + 1;
  }

  if (nextPage === null || nextPage < 1) return null;
  if (totalPages !== null && nextPage > totalPages) return null;

  const url = new URL(currentUrl || RELBASE_PRODUCTS_URL);
  url.searchParams.set('page', String(nextPage));

  return url.toString();
}


async function fetchRelbaseJson(url, accessToken) {
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
    const error = new Error(
      payload.error_description ||
      payload.error ||
      payload.message ||
      `Relbase rechazó la consulta (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function collectStockArrays(value, arrays = []) {
  if (!value || typeof value !== 'object') return arrays;

  if (Array.isArray(value)) {
    arrays.push(value);
    for (const item of value) collectStockArrays(item, arrays);
    return arrays;
  }

  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') collectStockArrays(item, arrays);
  }

  return arrays;
}

function stockFromRelbaseStockPayload(payload) {
  const arrays = collectStockArrays(payload);

  for (const array of arrays) {
    const mainWarehouseStock = stockFromMainWarehouseArray(array);
    if (mainWarehouseStock !== null) return mainWarehouseStock;
  }

  /*
   * Algunos endpoints filtrados por bodega devuelven un objeto directo
   * en vez de una lista. Solo usamos el valor directo cuando no existe
   * detalle de bodegas en la respuesta.
   */
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (isMainWarehouseItem(payload)) {
      const directWarehouseStock = stockValueFromItem(payload);
      if (directWarehouseStock !== null) return directWarehouseStock;
    }

    const directStock = stockValueFromItem(payload);
    if (directStock !== null) return directStock;

    for (const key of ['data', 'stock', 'producto', 'product', 'resource', 'result']) {
      const child = payload[key];
      if (child && child !== payload) {
        const nestedStock = stockFromRelbaseStockPayload(child);
        if (nestedStock !== null) return nestedStock;
      }
    }
  }

  return null;
}

function buildStockLookupUrls({ sku, relbaseId, barcode } = {}) {
  const urls = [];
  const add = (url) => {
    if (!url) return;
    const value = url.toString();
    if (!urls.includes(value)) urls.push(value);
  };

  const addWithWarehouseParams = (path) => {
    const url = new URL(path, RELBASE_BASE_URL);

    if (RELBASE_MAIN_WAREHOUSE_ID) {
      const byId = new URL(url.toString());
      byId.searchParams.set('id_bodega', RELBASE_MAIN_WAREHOUSE_ID);
      add(byId);
    }

    if (RELBASE_MAIN_WAREHOUSE_CODE) {
      const byCode = new URL(url.toString());
      byCode.searchParams.set('codigo_bodega', RELBASE_MAIN_WAREHOUSE_CODE);
      add(byCode);
    }

    add(url);
  };

  const cleanId = cleanText(relbaseId);
  const cleanBarcode = cleanText(barcode);
  const cleanProductSku = cleanSku(sku);

  /*
   * Primero probamos endpoints que pueden devolver detalle por bodega.
   * Esto evita usar el stock general del producto cuando existe un desglose
   * de Casa matriz / Bodega principal.
   */
  if (cleanId && cleanId !== cleanProductSku) {
    addWithWarehouseParams(`/api/v1/productosStock.findById-DetalleBodegas.json/${encodeURIComponent(cleanId)}`);
    addWithWarehouseParams(`/api/v1/productos/${encodeURIComponent(cleanId)}/stock_por_bodegas`);
  }

  /*
   * Después probamos endpoints por SKU/código de barras. Algunos Relbase
   * devuelven la bodega en esos endpoints; otros devuelven solo stock general.
   */
  if (cleanProductSku) {
    addWithWarehouseParams(`/api/v1/productosStock.findByCodigoSku.json/${encodeURIComponent(cleanProductSku)}`);
    addWithWarehouseParams(`/api/v1/productosStock.KITfindByCodigoSku.json/${encodeURIComponent(cleanProductSku)}`);
  }

  if (cleanBarcode) {
    addWithWarehouseParams(`/api/v1/productosStock.findByCodigoBarra.json/${encodeURIComponent(cleanBarcode)}`);
    addWithWarehouseParams(`/api/v1/productosStock.KITfindByCodigoBarra.json/${encodeURIComponent(cleanBarcode)}`);
  }

  if (cleanId && cleanId !== cleanProductSku) {
    addWithWarehouseParams(`/api/v1/productosStock.findById.json/${encodeURIComponent(cleanId)}`);
  }

  return urls;
}

async function fetchStockUrlWithRefresh(url, accessToken) {
  try {
    return {
      payload: await fetchRelbaseJson(url, accessToken),
      accessToken,
    };
  } catch (error) {
    if (error.status !== 401) throw error;

    const refreshed = await refreshAccessToken();
    return {
      payload: await fetchRelbaseJson(url, refreshed.access_token),
      accessToken: refreshed.access_token,
    };
  }
}

async function findStockBySku({ sku, relbaseId, barcode } = {}) {
  if (!RELBASE_LIVE_STOCK_ENABLED) return null;

  const urls = buildStockLookupUrls({ sku, relbaseId, barcode });
  if (!urls.length) return null;

  let accessToken = await getValidAccessToken();
  let lastError = null;

  for (const url of urls) {
    try {
      const result = await fetchStockUrlWithRefresh(url, accessToken);
      accessToken = result.accessToken;

      const stock = stockFromRelbaseStockPayload(result.payload);

      if (stock !== null) {
        return {
          stock,
          source: url,
          stockUpdatedAt: new Date().toISOString(),
        };
      }
    } catch (error) {
      lastError = error;
      console.warn(`Relbase stock no respondió para ${sku || relbaseId} en ${url}:`, error.message);
    }
  }

  if (lastError) {
    return {
      stock: null,
      error: lastError.message,
      stockUpdatedAt: null,
    };
  }

  return null;
}

async function debugStockBySku({ sku, relbaseId, barcode } = {}) {
  const urls = buildStockLookupUrls({ sku, relbaseId, barcode });
  let accessToken = await getValidAccessToken();
  const responses = [];

  for (const url of urls) {
    try {
      const result = await fetchStockUrlWithRefresh(url, accessToken);
      accessToken = result.accessToken;

      responses.push({
        url,
        stockDetected: stockFromRelbaseStockPayload(result.payload),
        payload: result.payload,
      });
    } catch (error) {
      responses.push({
        url,
        error: error.message,
        status: error.status || null,
        payload: error.payload || null,
      });
    }
  }

  return {
    sku,
    relbaseId,
    barcode,
    warehouse: {
      name: RELBASE_MAIN_WAREHOUSE_NAME,
      id: RELBASE_MAIN_WAREHOUSE_ID || null,
      code: RELBASE_MAIN_WAREHOUSE_CODE || null,
    },
    checkedUrls: urls.length,
    responses,
  };
}

async function enrichProductStock(product) {
  const stockResult = await findStockBySku({
    sku: product?.sku,
    relbaseId: product?.relbaseId,
    barcode: product?.barcode,
  });

  if (!stockResult || stockResult.stock === null || stockResult.stock === undefined) {
    return product;
  }

  return {
    ...product,
    stock: stockResult.stock,
    stockSource: 'relbase-stock-bodega-principal',
    stockSourceUrl: stockResult.source || null,
    stockUpdatedAt: stockResult.stockUpdatedAt || new Date().toISOString(),
  };
}

async function listProducts(options = {}) {
  const onProgress = typeof options.onProgress === 'function'
    ? options.onProgress
    : null;

  let accessToken = await getValidAccessToken();

  let url = RELBASE_PRODUCTS_URL;
  const all = [];
  const seenUrls = new Set();
  let pageCount = 0;
  let knownTotalPages = null;

  while (url) {
    pageCount += 1;

    if (pageCount > RELBASE_SAFETY_MAX_PAGES) {
      throw new Error(
        `Relbase superó el límite de seguridad de ${RELBASE_SAFETY_MAX_PAGES} páginas. Se detuvo para proteger Railway.`
      );
    }

    if (seenUrls.has(url)) {
      throw new Error(
        'Relbase repitió una página durante la sincronización. Se detuvo para evitar un ciclo infinito.'
      );
    }

    seenUrls.add(url);

    let payload;

    try {
      payload = await fetchProductsPage(url, accessToken);
    } catch (error) {
      if (error.status === 401) {
        console.warn('Relbase respondió 401. Renovando token e intentando nuevamente...');
        const refreshed = await refreshAccessToken();
        accessToken = refreshed.access_token;
        payload = await fetchProductsPage(url, accessToken);
      } else {
        error.message = `Error sincronizando Relbase en página ${pageCount}: ${error.message}`;
        throw error;
      }
    }

    const products = extractProducts(payload);
    all.push(...products);

    const meta = payload?.meta || payload?.pagination || {};
    const totalPages = numberOrNull(firstValue(
      meta.total_pages,
      meta.totalPages,
      meta.pages,
      meta.last_page,
      meta.lastPage
    ));

    if (totalPages !== null) {
      knownTotalPages = totalPages;
    }

    let percent = 1;

    if (knownTotalPages) {
      percent = Math.min(99, Math.round((pageCount / knownTotalPages) * 100));
    } else {
      percent = Math.min(95, Math.max(1, Math.round(pageCount * 2)));
    }

    if (onProgress) {
      onProgress({
        page: pageCount,
        totalPages: knownTotalPages,
        productCount: all.length,
        percent,
      });
    }

    console.log(
      `Relbase página ${pageCount}: ${products.length} productos. Total acumulado: ${all.length}`
    );

    url = nextPageUrl(payload, url);
  }

  const normalized = all
    .map(normalizeProduct)
    .filter((product) => product.sku);

  const unique = new Map();

  for (const product of normalized) {
    unique.set(product.sku, product);
  }

  console.log(`Sincronización Relbase terminada: ${unique.size} productos únicos.`);

  if (onProgress) {
    onProgress({
      page: pageCount,
      totalPages: knownTotalPages,
      productCount: unique.size,
      percent: 100,
    });
  }

  return [...unique.values()];
}

function productMatchesSku(product, sku) {
  const normalized = normalizeProduct(product);

  return (
    normalized.sku === sku ||
    cleanSku(normalized.barcode) === sku ||
    cleanSku(normalized.relbaseId) === sku
  );
}

function buildProductLookupUrls(sku) {
  const urls = [];
  const base = new URL(RELBASE_PRODUCTS_URL);

  const addUrl = (url) => {
    const value = url.toString();
    if (!urls.includes(value)) urls.push(value);
  };

  /*
   * Intentos por filtros.
   * Si Relbase ignora alguno, no importa:
   * igual validamos que el SKU coincida exacto.
   */
  for (const key of ['sku', 'codigo', 'code', 'q', 'search', 'busqueda']) {
    const url = new URL(base.toString());
    url.searchParams.set(key, sku);
    addUrl(url);
  }

  return urls;
}

async function fetchProductLookupPayload(url, accessToken) {
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

  if (response.status === 404) return null;

  if (!response.ok) {
    const error = new Error(
      payload.error_description ||
      payload.error ||
      `Relbase rechazó la búsqueda puntual de producto (${response.status}).`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function singleProductCandidates(payload) {
  const candidates = [];

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    candidates.push(payload);

    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      candidates.push(payload.data);
    }

    if (payload.product && typeof payload.product === 'object') {
      candidates.push(payload.product);
    }

    if (payload.producto && typeof payload.producto === 'object') {
      candidates.push(payload.producto);
    }

    if (payload.resource && typeof payload.resource === 'object') {
      candidates.push(payload.resource);
    }
  }

  return candidates;
}

async function findProductBySku(skuInput) {
  const sku = cleanSku(skuInput);
  if (!sku) return null;

  let accessToken = await getValidAccessToken();
  const urls = buildProductLookupUrls(sku);

  for (const url of urls) {
    let payload;

    try {
      payload = await fetchProductLookupPayload(url, accessToken);
    } catch (error) {
      if (error.status === 401) {
        console.warn('Relbase respondió 401 en búsqueda puntual. Renovando token...');
        const refreshed = await refreshAccessToken();
        accessToken = refreshed.access_token;
        payload = await fetchProductLookupPayload(url, accessToken);
      } else {
        throw error;
      }
    }

    if (!payload) continue;

    /*
     * Caso 1:
     * Relbase devuelve una lista de productos.
     */
    const products = extractProducts(payload);
    const match = products.find((product) => productMatchesSku(product, sku));

    if (match) {
      return enrichProductStock(normalizeProduct(match));
    }

    /*
     * Caso 2:
     * Relbase devuelve un solo producto como objeto,
     * o lo devuelve dentro de data/product/producto/resource.
     */
    for (const candidate of singleProductCandidates(payload)) {
      const normalized = normalizeProduct(candidate);

      if (normalized.sku && productMatchesSku(candidate, sku)) {
        return enrichProductStock(normalized);
      }
    }
  }

  return null;
}
module.exports = {
  getAuthUrl,
  exchangeCodeForToken,
  listProducts,
  findProductBySku,
  findStockBySku,
  debugStockBySku,
  enrichProductStock,
  buildProductLookupUrls,
  buildStockLookupUrls,
  fetchProductsPage,
  getValidAccessToken,
  status,
};
