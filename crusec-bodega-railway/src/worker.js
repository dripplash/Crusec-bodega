const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const SPECIAL_AREAS = {
  PIEZA_1: { key: 'PIEZA_1', label: 'Pieza 1', spots: { ESTANTE_1: 'Estante 1', ESTANTE_2: 'Estante 2', ESTANTE_3: 'Estante 3' } },
  PIEZA_2: { key: 'PIEZA_2', label: 'Pieza 2', spots: { ESTANTE_1: 'Estante 1', ESTANTE_2: 'Estante 2', ESTANTE_3: 'Estante 3' } },
  PIEZA_3: { key: 'PIEZA_3', label: 'Pieza 3', spots: { ESTANTE_1: 'Estante 1', ESTANTE_2: 'Estante 2', ESTANTE_3: 'Estante 3' } },
  SEGUNDO_PISO: { key: 'SEGUNDO_PISO', label: 'Segundo piso', spots: { PIEZA: 'Pieza', ESTANTE_1: 'Estante 1', PISO: 'Piso' } },
};

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...securityHeaders(), ...headers } });
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

function normalizeSku(value) { return String(value || '').trim().toUpperCase(); }
function clean(value) { return String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim(); }
function first(...values) { return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? ''; }
function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}
function brandFromCode(code) {
  const prefix = normalizeSku(code).charAt(0);
  return prefix === 'P' ? 'Pitaya' : prefix === 'Y' ? 'Yozen' : 'Crusec';
}

function timingSafeEqualText(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let different = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) different |= (left[i % (left.length || 1)] || 0) ^ (right[i % (right.length || 1)] || 0);
  return different === 0;
}

function authorized(request, env) {
  if (String(env.REQUIRE_APP_ACCESS || 'true').toLowerCase() === 'false') return true;
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(':');
    return separator >= 0 && timingSafeEqualText(decoded.slice(0, separator), env.APP_ACCESS_USER || '') && timingSafeEqualText(decoded.slice(separator + 1), env.APP_ACCESS_PASSWORD || '');
  } catch { return false; }
}

function authRequired() {
  return new Response('Autenticación requerida.', {
    status: 401,
    headers: { ...securityHeaders(), 'WWW-Authenticate': 'Basic realm="Crusec Bodega", charset="UTF-8"' },
  });
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret || '')));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptJson(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), new TextEncoder().encode(JSON.stringify(value)));
  const bytes = new Uint8Array(iv.length + encrypted.byteLength);
  bytes.set(iv); bytes.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...bytes));
}

async function decryptJson(value, secret) {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await encryptionKey(secret), bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function readToken(env) {
  const row = await env.DB.prepare('SELECT encrypted_json FROM oauth_tokens WHERE id = 1').first();
  if (!row?.encrypted_json) return null;
  try { return await decryptJson(row.encrypted_json, env.DATA_ENCRYPTION_KEY); } catch { return null; }
}

async function saveToken(env, token, previous = null) {
  if (!token?.access_token) throw new Error('Relbase no devolvió access_token.');
  const expiresIn = Math.max(60, Number(token.expires_in || 900));
  const stored = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || previous?.refresh_token || null,
    token_type: token.token_type || previous?.token_type || 'Bearer',
    scope: token.scope || previous?.scope || '',
    expires_at: token.expires_at || new Date(Date.now() + expiresIn * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const encrypted = await encryptJson(stored, env.DATA_ENCRYPTION_KEY);
  await env.DB.prepare('INSERT INTO oauth_tokens (id, encrypted_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET encrypted_json=excluded.encrypted_json, updated_at=excluded.updated_at')
    .bind(encrypted, stored.updated_at).run();
  return stored;
}

function relbaseConfig(env) {
  const base = String(env.RELBASE_BASE_URL || 'https://api.relbase.cl').replace(/\/+$/, '');
  return {
    base,
    authUrl: env.RELBASE_AUTH_URL || `${base}/oauth/authorize`,
    tokenUrl: env.RELBASE_TOKEN_URL || `${base}/oauth/token`,
    productsUrl: env.RELBASE_PRODUCTS_URL || `${base}/api/v2/productos`,
    clientId: env.RELBASE_CLIENT_ID || '', clientSecret: env.RELBASE_CLIENT_SECRET || '',
    redirectUri: env.RELBASE_REDIRECT_URI || '', scopes: env.RELBASE_SCOPES || 'products:read inventory:read warehouses:read',
  };
}

function safeRelbaseUrl(value, env) {
  const config = relbaseConfig(env);
  const url = new URL(value, config.productsUrl);
  if (url.protocol !== 'https:' || url.origin !== new URL(config.productsUrl).origin) throw new Error('Relbase devolvió una URL no permitida.');
  return url;
}

async function requestToken(env, parameters) {
  const config = relbaseConfig(env);
  const response = await fetch(config.tokenUrl, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, client_id: config.clientId, client_secret: config.clientSecret }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Relbase rechazó el token (${response.status}).`);
  return payload;
}

async function validAccessToken(env) {
  const current = await readToken(env);
  if (current?.access_token && new Date(current.expires_at).getTime() > Date.now() + 60_000) return current.access_token;
  if (!current?.refresh_token) throw new Error('Relbase todavía no está autorizado.');
  const refreshed = await requestToken(env, { grant_type: 'refresh_token', refresh_token: current.refresh_token });
  return (await saveToken(env, refreshed, current)).access_token;
}

function nestedId(value) { return value && typeof value === 'object' ? first(value.id, value.ware_house_id, value.warehouse_id, value.bodega_id, value.almacen_id) : value; }
function nestedName(value) { return value && typeof value === 'object' ? first(value.nombre, value.name, value.descripcion, value.label) : value; }
function stockValue(item) { return numberOrNull(first(item.stock_disponible, item.stockDisponible, item.disponible, item.available, item.available_quantity, item.stock, item.cantidad, item.quantity, item.qty, item.saldo)); }
function mainWarehouseStock(items, env) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const id = clean(first(item.ware_house_id, item.warehouse_id, item.bodega_id, item.almacen_id, nestedId(item.bodega), nestedId(item.warehouse)));
    const name = clean(first(item.bodega_nombre, item.warehouse_name, item.nombre_bodega, nestedName(item.bodega), nestedName(item.warehouse))).toLowerCase();
    if (id === String(env.RELBASE_MAIN_WAREHOUSE_ID || '2881') || name.includes('principal') || name.includes('casa matriz')) {
      const value = stockValue(item); if (value !== null) return value;
    }
  }
  return null;
}

function normalizeProduct(product, env, generation) {
  const sku = normalizeSku(first(product.sku, product.SKU, product.codigo, product.codigo_sku, product.codigo_producto, product.code, product.internal_code, product.barcode, product.codigo_barras, product.id));
  if (!sku) return null;
  const inventories = first(product.inventarios, product.inventory, product.inventories, product.stocks, product.bodegas, product.warehouses);
  const stock = mainWarehouseStock(inventories, env) ?? numberOrNull(first(product.stock_disponible, product.stockDisponible, product.disponible, product.available, product.stock, product.cantidad, product.quantity));
  const activeValue = first(product.active, product.activo, product.estado, product.status, true);
  return {
    sku, relbaseId: clean(first(product.id, product.relbaseId, sku)),
    name: clean(first(product.nombre, product.name, product.descripcion, product.description, `Producto ${sku}`)),
    barcode: clean(first(product.barcode, product.codigo_barras, product.codigoBarra, product.ean, product.upc)),
    brand: clean(first(product.brand, product.marca, product.brand_name, nestedName(product.brand), nestedName(product.marca))) || brandFromCode(sku),
    active: typeof activeValue === 'boolean' ? activeValue : !['false', '0', 'inactivo', 'inactive'].includes(String(activeValue).toLowerCase()),
    stock, stockUpdatedAt: first(product.stockUpdatedAt, product.updated_at, product.fecha_actualizacion, null), generation,
  };
}

function extractProducts(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['products', 'productos', 'resources', 'data', 'items', 'results']) if (Array.isArray(payload?.[key])) return payload[key];
  if (payload?.data && typeof payload.data === 'object') return extractProducts(payload.data);
  return [];
}

function nextPage(payload, current, env) {
  const direct = payload?.links?.next || payload?.pagination?.next || payload?.meta?.next || payload?.next;
  if (direct) return safeRelbaseUrl(direct, env).toString();
  const meta = payload?.meta || payload?.pagination || {};
  const currentPage = numberOrNull(first(meta.current_page, meta.currentPage, meta.page));
  const totalPages = numberOrNull(first(meta.total_pages, meta.totalPages, meta.pages, meta.last_page, meta.lastPage));
  if (currentPage === null || totalPages === null || currentPage >= totalPages) return null;
  const url = safeRelbaseUrl(current, env); url.searchParams.set('page', String(currentPage + 1)); return url.toString();
}

async function beginSync(env) {
  const generation = new Date().toISOString();
  await env.DB.prepare("UPDATE sync_state SET status='running', generation=?, next_url=?, page=0, product_count=0, started_at=?, finished_at=NULL, error=NULL WHERE id=1")
    .bind(generation, relbaseConfig(env).productsUrl, generation).run();
}

async function syncOnePage(env) {
  let state = await env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first();
  if (!state || state.status !== 'running' || !state.next_url) { await beginSync(env); state = await env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first(); }
  try {
    const accessToken = await validAccessToken(env);
    const response = await fetch(safeRelbaseUrl(state.next_url, env), { headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error_description || payload.error || `Relbase respondió ${response.status}.`);
    const products = extractProducts(payload).map((item) => normalizeProduct(item, env, state.generation)).filter(Boolean);
    const statements = products.map((p) => env.DB.prepare(`INSERT INTO products (sku,relbase_id,name,barcode,brand,active,stock,stock_updated_at,sync_generation) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET relbase_id=excluded.relbase_id,name=excluded.name,barcode=excluded.barcode,brand=excluded.brand,active=excluded.active,stock=excluded.stock,stock_updated_at=excluded.stock_updated_at,sync_generation=excluded.sync_generation`).bind(p.sku,p.relbaseId,p.name,p.barcode,p.brand,p.active?1:0,p.stock,p.stockUpdatedAt,p.generation));
    if (statements.length) await env.DB.batch(statements);
    const next = nextPage(payload, state.next_url, env);
    const page = Number(state.page || 0) + 1;
    const count = Number(state.product_count || 0) + products.length;
    if (next) {
      await env.DB.prepare('UPDATE sync_state SET next_url=?, page=?, product_count=? WHERE id=1').bind(next,page,count).run();
      return { complete: false, page, productCount: count };
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM products WHERE sync_generation <> ?').bind(state.generation),
      env.DB.prepare("UPDATE sync_state SET status='complete', next_url=NULL, page=?, product_count=?, finished_at=?, error=NULL WHERE id=1").bind(page,count,new Date().toISOString()),
    ]);
    return { complete: true, page, productCount: count };
  } catch (error) {
    await env.DB.prepare("UPDATE sync_state SET status='error', error=?, finished_at=? WHERE id=1").bind(error.message,new Date().toISOString()).run();
    throw error;
  }
}

function rowLocation(row) {
  if (!row?.location_type) return null;
  return row.location_type === 'special'
    ? { type:'special', areaKey:row.area_key, areaLabel:row.area_label, spotKey:row.spot_key, spotLabel:row.spot_label, position:row.position, fullLabel:row.full_label }
    : { type:'normal', aisle:row.aisle, side:row.side, sideLabel:row.side_label, rack:row.rack, level:row.level, fullLabel:row.full_label };
}

function publicProduct(row) {
  return { relbaseId:row.relbase_id||row.sku, sku:row.sku, name:row.name, barcode:row.barcode||'', brand:row.brand||brandFromCode(row.sku), active:Boolean(row.active), stock:row.stock, stockUpdatedAt:row.stock_updated_at, location:rowLocation(row), locationUpdatedAt:row.location_updated_at||null, locationUpdatedBy:row.location_updated_by||null };
}

const PRODUCT_SELECT = `SELECT p.*,l.type location_type,l.aisle,l.side,l.side_label,l.rack,l.level,l.area_key,l.area_label,l.spot_key,l.spot_label,l.position,l.full_label,l.updated_at location_updated_at,l.updated_by location_updated_by FROM products p LEFT JOIN locations l ON l.sku=p.sku`;

async function productsQuery(env, q = '', filter = 'all') {
  const where = []; const values = [];
  if (q) { where.push('(p.sku LIKE ? OR p.barcode LIKE ? OR p.name LIKE ? OR p.brand LIKE ?)'); const value=`%${q}%`; values.push(value,value,value,value); }
  if (filter === 'assigned') where.push('l.sku IS NOT NULL');
  if (filter === 'unassigned') where.push('l.sku IS NULL');
  if (filter === 'normal') where.push("l.type='normal'");
  if (filter === 'special') where.push("l.type='special'");
  if (filter === 'with-stock') where.push('p.stock > 0');
  if (filter === 'without-stock') where.push('p.stock = 0');
  const sql = `${PRODUCT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE WHEN l.sku IS NULL THEN 0 ELSE 1 END,p.sku LIMIT 10000`;
  return (await env.DB.prepare(sql).bind(...values).all()).results || [];
}

function validateLocation(body) {
  const aisle=Number(body.aisle), rack=Number(body.rack), level=Number(body.level), side=String(body.side||'').toUpperCase();
  if (!Number.isInteger(aisle)||aisle<1||aisle>6) return 'El pasillo debe estar entre 1 y 6.';
  if (!['D','I'].includes(side)) return 'El lado debe ser D o I.';
  if (!Number.isInteger(rack)||rack<1||rack>11) return 'El rack debe estar entre 1 y 11.';
  if (!Number.isInteger(level)||level<1||level>5) return 'El nivel debe estar entre 1 y 5.';
  const sideLabel=side==='D'?'Derecho':'Izquierdo';
  return {type:'normal',aisle,side,sideLabel,rack,level,fullLabel:`Pasillo ${aisle} — lado ${sideLabel.toLowerCase()} — rack ${rack} — nivel ${level}`};
}

function validateSpecial(body) {
  const areaKey=String(body.areaKey||'').toUpperCase(), spotKey=String(body.spotKey||'').toUpperCase(), area=SPECIAL_AREAS[areaKey];
  if (!area || !area.spots[spotKey]) return 'Debes elegir una ubicación especial válida.';
  let position=null; if (spotKey==='PISO') { position=Number(body.position); if (!Number.isInteger(position)||position<1||position>20) return 'La posición debe estar entre 1 y 20.'; }
  const spotLabel=area.spots[spotKey];
  return {type:'special',areaKey,areaLabel:area.label,spotKey,spotLabel,position,fullLabel:position?`${area.label} — ${spotLabel} — Posición ${position}`:`${area.label} — ${spotLabel}`};
}

async function saveLocation(env, sku, location, updatedBy, action) {
  const product = await env.DB.prepare('SELECT * FROM products WHERE sku=?').bind(sku).first();
  if (!product) return null;
  const previous = await env.DB.prepare('SELECT * FROM locations WHERE sku=?').bind(sku).first();
  const now=new Date().toISOString(), id=`${Date.now()}-${crypto.randomUUID()}`;
  const values=[sku,location.type,location.aisle||null,location.side||null,location.sideLabel||null,location.rack||null,location.level||null,location.areaKey||null,location.areaLabel||null,location.spotKey||null,location.spotLabel||null,location.position||null,location.fullLabel,now,updatedBy];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO locations (sku,type,aisle,side,side_label,rack,level,area_key,area_label,spot_key,spot_label,position,full_label,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET type=excluded.type,aisle=excluded.aisle,side=excluded.side,side_label=excluded.side_label,rack=excluded.rack,level=excluded.level,area_key=excluded.area_key,area_label=excluded.area_label,spot_key=excluded.spot_key,spot_label=excluded.spot_label,position=excluded.position,full_label=excluded.full_label,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(...values),
    env.DB.prepare('INSERT INTO history (id,created_at,sku,product_name,brand,action,updated_by,before_json,after_json,before_label,after_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,now,sku,product.name,product.brand,action,updatedBy,previous?JSON.stringify(rowLocation({...previous,location_type:previous.type})):null,JSON.stringify(location),previous?.full_label||null,location.fullLabel),
  ]);
  return (await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.sku=?`).bind(sku).first());
}

async function removeLocation(env, sku, updatedBy) {
  const product=await env.DB.prepare('SELECT * FROM products WHERE sku=?').bind(sku).first(); if(!product) return null;
  const previous=await env.DB.prepare('SELECT * FROM locations WHERE sku=?').bind(sku).first(); const now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM locations WHERE sku=?').bind(sku),
    env.DB.prepare('INSERT INTO history (id,created_at,sku,product_name,brand,action,updated_by,before_json,after_json,before_label,after_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(`${Date.now()}-${crypto.randomUUID()}`,now,sku,product.name,product.brand,'quitar ubicación',updatedBy,previous?JSON.stringify(previous):null,null,previous?.full_label||null,null),
  ]);
  return product;
}

async function handleAuth(request, env, url) {
  const config=relbaseConfig(env);
  if (url.pathname==='/auth/login') {
    const state=crypto.randomUUID(); const expires=new Date(Date.now()+10*60*1000).toISOString();
    await env.DB.prepare('INSERT INTO oauth_states (state,expires_at) VALUES (?,?)').bind(state,expires).run();
    const target=new URL(config.authUrl); target.searchParams.set('response_type','code'); target.searchParams.set('client_id',config.clientId); target.searchParams.set('redirect_uri',config.redirectUri); target.searchParams.set('scope',config.scopes); target.searchParams.set('state',state);
    return Response.redirect(target.toString(),302);
  }
  if (url.pathname==='/auth/callback') {
    const code=url.searchParams.get('code'), state=url.searchParams.get('state');
    const saved=state?await env.DB.prepare('SELECT * FROM oauth_states WHERE state=?').bind(state).first():null;
    if(!code||!saved||new Date(saved.expires_at).getTime()<Date.now()) return new Response('Autorización inválida o expirada.',{status:400});
    const token=await requestToken(env,{grant_type:'authorization_code',code,redirect_uri:config.redirectUri}); await saveToken(env,token); await env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();
    return new Response('<!doctype html><meta charset="utf-8"><title>Relbase conectado</title><h1>Relbase conectado correctamente</h1><p><a href="/">Volver a Crusec Bodega</a></p>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
  }
  return json({error:'Ruta de autorización no encontrada.'},404);
}

async function handleApi(request, env, url) {
  if (request.method==='GET'&&url.pathname==='/api/status') {
    const [count,state,token]=await Promise.all([env.DB.prepare('SELECT COUNT(*) count FROM products').first(),env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first(),readToken(env)]);
    return json({relbaseEnabled:true,relbaseAuthorized:Boolean(token?.access_token||token?.refresh_token),mode:'relbase',lastSyncAt:state?.finished_at||null,syncStatus:token?(state?.status==='running'?`Sincronizando página ${state.page||0}`:`Relbase conectado · ${count?.count||0} productos guardados`):'Relbase pendiente de autorización',productCount:count?.count||0,autoSyncEnabled:true,syncIntervalMinutes:Number(env.SYNC_INTERVAL_MINUTES||15),storage:'Cloudflare D1',maxSecondFloorPosition:20,specialAreas:Object.values(SPECIAL_AREAS).map(a=>({key:a.key,label:a.label,spots:Object.entries(a.spots).map(([key,label])=>({key,label}))}))});
  }
  if (request.method==='GET'&&url.pathname==='/api/sync/progress') { const state=await env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first(); return json({running:state?.status==='running',percent:state?.status==='complete'?100:Math.min(95,(state?.page||0)*5),page:state?.page||0,productCount:state?.product_count||0,startedAt:state?.started_at,finishedAt:state?.finished_at,error:state?.error}); }
  if (request.method==='POST'&&url.pathname==='/api/sync') { try { const result=await syncOnePage(env); return json({message:result.complete?`Sincronización completada. ${result.productCount} productos guardados.`:`Página ${result.page} sincronizada; continuando…`,productCount:result.productCount,lastSyncAt:result.complete?new Date().toISOString():null,complete:result.complete,progress:{running:!result.complete,page:result.page,productCount:result.productCount,percent:result.complete?100:Math.min(95,result.page*5)}},result.complete?200:202); } catch(error){return json({error:error.message},502);} }
  if (request.method==='GET'&&url.pathname==='/api/products') { const q=String(url.searchParams.get('q')||'').trim(); const rows=await productsQuery(env,q,String(url.searchParams.get('filter')||'all')); const state=await env.DB.prepare('SELECT * FROM sync_state WHERE id=1').first(); return json({products:rows.map(publicProduct),lastSyncAt:state?.finished_at||null,syncStatus:`${rows.length} productos`}); }
  if (request.method==='GET'&&url.pathname==='/api/products/search') { const sku=normalizeSku(url.searchParams.get('sku')); const row=await env.DB.prepare(`${PRODUCT_SELECT} WHERE p.sku=? OR UPPER(p.barcode)=? LIMIT 1`).bind(sku,sku).first(); return row?json({product:publicProduct(row)}):json({error:'Código de producto no registrado.'},404); }
  if (request.method==='GET'&&url.pathname==='/api/special-locations') { const rows=await productsQuery(env,'','special'); const area=String(url.searchParams.get('areaKey')||'').toUpperCase(),spot=String(url.searchParams.get('spotKey')||'').toUpperCase(); return json({products:rows.filter(r=>(!area||r.area_key===area)&&(!spot||r.spot_key===spot)).map(publicProduct)}); }
  const normal=url.pathname.match(/^\/api\/products\/([^/]+)\/location$/), special=url.pathname.match(/^\/api\/products\/([^/]+)\/special-location$/);
  if ((normal||special)&&request.method==='PUT') { const sku=normalizeSku(decodeURIComponent((normal||special)[1])); const body=await request.json().catch(()=>({})); const location=normal?validateLocation(body):validateSpecial(body); if(typeof location==='string')return json({error:location},400); const row=await saveLocation(env,sku,location,clean(body.updatedBy)||'Sin identificar',normal?'asignar o actualizar ubicación de bodega':'asignar o actualizar ubicación especial'); return row?json({product:publicProduct(row),message:'Ubicación guardada correctamente.'}):json({error:'Producto no encontrado.'},404); }
  if ((normal||special)&&request.method==='DELETE') { const sku=normalizeSku(decodeURIComponent((normal||special)[1])); const body=await request.json().catch(()=>({})); const row=await removeLocation(env,sku,clean(body.updatedBy)||'Sin identificar'); return row?json({product:publicProduct(row),message:'Ubicación eliminada.'}):json({error:'Producto no encontrado.'},404); }
  if (request.method==='GET'&&url.pathname==='/api/history') { const sku=normalizeSku(url.searchParams.get('sku')),limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit')||100))); const rows=sku?(await env.DB.prepare('SELECT * FROM history WHERE sku=? ORDER BY created_at DESC LIMIT ?').bind(sku,limit).all()).results:(await env.DB.prepare('SELECT * FROM history ORDER BY created_at DESC LIMIT ?').bind(limit).all()).results; return json({events:(rows||[]).map(r=>({id:r.id,createdAt:r.created_at,sku:r.sku,productName:r.product_name,brand:r.brand,action:r.action,updatedBy:r.updated_by,before:r.before_json?JSON.parse(r.before_json):null,after:r.after_json?JSON.parse(r.after_json):null,beforeLabel:r.before_label,afterLabel:r.after_label})),total:(rows||[]).length}); }
  if (request.method==='POST'&&url.pathname==='/api/admin/import') { const body=await request.json().catch(()=>({})); if(!env.ADMIN_PIN||!timingSafeEqualText(body.pin||'',env.ADMIN_PIN))return json({error:'PIN incorrecto.'},401); const generation=new Date().toISOString(),statements=[]; for(const item of body.products||[]){const p={...item,generation};statements.push(env.DB.prepare(`INSERT INTO products (sku,relbase_id,name,barcode,brand,active,stock,stock_updated_at,sync_generation) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET relbase_id=excluded.relbase_id,name=excluded.name,barcode=excluded.barcode,brand=excluded.brand,active=excluded.active,stock=excluded.stock,stock_updated_at=excluded.stock_updated_at,sync_generation=excluded.sync_generation`).bind(normalizeSku(p.sku),p.relbaseId||p.sku,p.name||'Producto sin nombre',p.barcode||'',p.brand||brandFromCode(p.sku),p.active===false?0:1,p.stock??null,p.stockUpdatedAt||null,generation));if(p.location){const l=p.location;statements.push(env.DB.prepare(`INSERT INTO locations (sku,type,aisle,side,side_label,rack,level,area_key,area_label,spot_key,spot_label,position,full_label,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET type=excluded.type,aisle=excluded.aisle,side=excluded.side,side_label=excluded.side_label,rack=excluded.rack,level=excluded.level,area_key=excluded.area_key,area_label=excluded.area_label,spot_key=excluded.spot_key,spot_label=excluded.spot_label,position=excluded.position,full_label=excluded.full_label,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(normalizeSku(p.sku),l.type,l.aisle||null,l.side||null,l.sideLabel||null,l.rack||null,l.level||null,l.areaKey||null,l.areaLabel||null,l.spotKey||null,l.spotLabel||null,l.position||null,l.fullLabel||'',p.locationUpdatedAt||generation,p.locationUpdatedBy||'Migración Railway'));}}
    for(const event of body.history||[]){
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO history (id,created_at,sku,product_name,brand,action,updated_by,before_json,after_json,before_label,after_label) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        event.id||`${Date.now()}-${crypto.randomUUID()}`,
        event.createdAt||event.created_at||new Date().toISOString(),
        normalizeSku(event.sku),
        event.productName||event.product_name||'Producto sin nombre',
        event.brand||brandFromCode(event.sku),
        event.action||'migración desde Railway',
        event.updatedBy||event.updated_by||'Migración Railway',
        event.before?JSON.stringify(event.before):(event.before_json||null),
        event.after?JSON.stringify(event.after):(event.after_json||null),
        event.beforeLabel||event.before_label||null,
        event.afterLabel||event.after_label||null
      ));
    }
    for(let i=0;i<statements.length;i+=50)await env.DB.batch(statements.slice(i,i+50));
    return json({message:'Datos importados.',products:(body.products||[]).length,history:(body.history||[]).length}); }
  return json({error:'Ruta API no encontrada.'},404);
}

export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.pathname==='/healthz')return json({ok:true,runtime:'cloudflare-workers'});
    if(!authorized(request,env))return authRequired();
    try {
      if(url.pathname.startsWith('/auth/'))return await handleAuth(request,env,url);
      if(url.pathname.startsWith('/api/'))return await handleApi(request,env,url);
      const response=await env.ASSETS.fetch(request); const headers=new Headers(response.headers); for(const [k,v] of Object.entries(securityHeaders()))headers.set(k,v); return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch(error){console.error(error);return json({error:'Error interno de la aplicación.',detail:error.message},500);}
  },
  async scheduled(_controller,env,ctx){ctx.waitUntil(syncOnePage(env));},
};
