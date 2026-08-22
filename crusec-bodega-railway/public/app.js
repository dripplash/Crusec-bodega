const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const STORAGE = {
  profile:'kordis.profile',
  lastSku:'kordis.lastSku'
};

const state = {
  profile:{name:'Usuario', avatar:'person'},
  hasProfile:false,
  products:[],
  currentSku:null,
  assignmentSku:null,
  assignment:{aisle:1,side:'I',rack:1,level:1},
  status:null,
  lastSyncAt:null,
  scannerStream:null,
  syncing:false
};

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('pageshow', () => window.scrollTo(0, 0));

function safeJson(value){ try{return JSON.parse(value)}catch{return null} }
function escapeHtml(value=''){
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function normalizeSku(value){ return String(value||'').trim().toUpperCase(); }
function sideLabel(side){ return String(side||'').toUpperCase()==='I' ? 'izquierdo' : 'derecho'; }
function displayBrand(){ return 'Crusec'; }
function locationKind(loc){ return !loc ? 'none' : (loc.type === 'special' || loc.areaKey ? 'special' : 'normal'); }
function locationLabel(loc){
  if(!loc) return 'Sin ubicación asignada';
  if(loc.fullLabel) return loc.fullLabel;
  if(locationKind(loc)==='special'){
    const parts=[loc.areaLabel||loc.areaKey,loc.spotLabel||loc.spotKey];
    if(loc.position) parts.push(`Posición ${loc.position}`);
    return parts.filter(Boolean).join(' — ');
  }
  return `Pasillo ${loc.aisle} — lado ${sideLabel(loc.side)} — rack ${loc.rack} — nivel ${loc.level}`;
}
function shortLocation(loc){
  if(!loc) return 'Sin ubicación';
  if(locationKind(loc)==='special') return loc.fullLabel || locationLabel(loc);
  return `P${loc.aisle} · ${loc.side} · R${loc.rack} · N${loc.level}`;
}
function firstName(){ return (state.profile.name || 'Usuario').trim().split(/\s+/)[0] || 'Usuario'; }
function productBySku(sku){ return state.products.find(p => normalizeSku(p.sku) === normalizeSku(sku)); }
function matchesProduct(p, q){
  const s=String(q||'').trim().toUpperCase();
  if(!s) return true;
  return [p.sku,p.barcode,p.name,p.brand].some(v => String(v||'').toUpperCase().includes(s));
}
function mergeProduct(product){
  if(!product?.sku) return product;
  const i=state.products.findIndex(p=>normalizeSku(p.sku)===normalizeSku(product.sku));
  if(i>=0) state.products[i]={...state.products[i],...product};
  else state.products.push(product);
  return i>=0 ? state.products[i] : product;
}

let searchSuggestionIndex = -1;
let searchSuggestionProducts = [];

function searchSuggestionScore(product, query){
  const q=String(query||'').trim().toUpperCase();
  if(!q) return 999;
  const sku=String(product?.sku||'').toUpperCase();
  const barcode=String(product?.barcode||'').toUpperCase();
  const name=String(product?.name||'').toUpperCase();
  if(sku===q || barcode===q) return 0;
  if(sku.startsWith(q)) return 1;
  if(barcode.startsWith(q)) return 2;
  if(name.startsWith(q)) return 3;
  if(sku.includes(q)) return 4;
  if(barcode.includes(q)) return 5;
  if(name.includes(q)) return 6;
  return 99;
}

function getSearchSuggestions(query){
  const q=String(query||'').trim();
  if(!q) return [];
  return state.products
    .filter(product=>matchesProduct(product,q))
    .map(product=>({product,score:searchSuggestionScore(product,q)}))
    .sort((a,b)=>a.score-b.score
      || String(a.product.sku||'').length-String(b.product.sku||'').length
      || String(a.product.name||'').localeCompare(String(b.product.name||''),'es'))
    .slice(0,7)
    .map(item=>item.product);
}

function hideSearchSuggestions(){
  const panel=$('#search-suggestions');
  if(panel) panel.classList.add('hidden');
  $('#search-input')?.setAttribute('aria-expanded','false');
  searchSuggestionIndex=-1;
}

function searchPreviewMarkup(product){
  if(!product) return '';
  const location=product.location?locationLabel(product.location):'Sin ubicación asignada';
  const stock=Number.isFinite(Number(product.stock))?formatNumber(product.stock):'—';
  return `
    <div class="search-preview-card">
      <div class="search-preview-copy">
        <span class="search-preview-kicker">Vista previa</span>
        <strong>${escapeHtml(product.name||'Producto sin nombre')}</strong>
        <span class="search-preview-sku">SKU: ${escapeHtml(product.sku||'—')}</span>
      </div>
      <div class="search-preview-meta">
        <span><b>Stock</b>${escapeHtml(stock)}</span>
        <span><b>Ubicación</b>${escapeHtml(location)}</span>
      </div>
      <button type="button" class="search-preview-open" data-search-preview-open="${escapeHtml(product.sku||'')}">
        Ver producto
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </button>
    </div>`;
}

function setSearchSuggestionActive(index, {scroll=true}={}){
  if(!searchSuggestionProducts.length) return;
  const max=searchSuggestionProducts.length-1;
  searchSuggestionIndex=Math.max(0,Math.min(index,max));
  const rows=$$('[data-search-suggestion]');
  rows.forEach((row,i)=>{
    const active=i===searchSuggestionIndex;
    row.classList.toggle('active',active);
    row.setAttribute('aria-selected',String(active));
    if(active && scroll) row.scrollIntoView({block:'nearest'});
  });
  const product=searchSuggestionProducts[searchSuggestionIndex];
  const preview=$('#search-preview');
  if(preview){
    preview.innerHTML=searchPreviewMarkup(product);
    preview.classList.remove('hidden');
    preview.querySelector('[data-search-preview-open]')?.addEventListener('click',()=>{
      $('#search-input').value=product.sku;
      hideSearchSuggestions();
      searchProduct(product.sku);
    });
  }
}

function renderSearchSuggestions(query){
  const panel=$('#search-suggestions');
  const list=$('#search-suggestion-list');
  const preview=$('#search-preview');
  if(!panel || !list || !preview) return;

  const q=String(query||'').trim();
  if(!q){
    list.innerHTML='';
    preview.innerHTML='';
    preview.classList.add('hidden');
    hideSearchSuggestions();
    return;
  }

  searchSuggestionProducts=getSearchSuggestions(q);
  if(!searchSuggestionProducts.length){
    list.innerHTML=`<div class="search-suggestion-empty">No hay coincidencias en el catálogo sincronizado.</div>`;
    preview.innerHTML='';
    preview.classList.add('hidden');
    panel.classList.remove('hidden');
    $('#search-input')?.setAttribute('aria-expanded','true');
    searchSuggestionIndex=-1;
    return;
  }

  list.innerHTML=searchSuggestionProducts.map((product,index)=>`
    <button type="button" class="search-suggestion-item" role="option"
      aria-selected="${index===0?'true':'false'}" data-search-suggestion="${escapeHtml(product.sku||'')}">
      <span class="search-suggestion-copy">
        <strong>${escapeHtml(product.name||'Producto sin nombre')}</strong>
        <small><span>SKU</span>${escapeHtml(product.sku||'—')}</small>
      </span>
      <span class="search-suggestion-side">
        <b>${formatNumber(product.stock)}</b>
        <small>${product.location?'Con ubicación':'Sin ubicación'}</small>
      </span>
    </button>`).join('');

  panel.classList.remove('hidden');
  $('#search-input')?.setAttribute('aria-expanded','true');
  searchSuggestionIndex=0;

  $$('[data-search-suggestion]',list).forEach((row,index)=>{
    row.addEventListener('mouseenter',()=>setSearchSuggestionActive(index,{scroll:false}));
    row.addEventListener('focus',()=>setSearchSuggestionActive(index,{scroll:false}));
    row.addEventListener('click',()=>{
      const product=searchSuggestionProducts[index];
      if(!product) return;
      $('#search-input').value=product.sku;
      setSearchSuggestionActive(index,{scroll:false});
    });
  });

  setSearchSuggestionActive(0,{scroll:false});
}
function formatNumber(value){
  const n=Number(value);
  return Number.isFinite(n) ? n.toLocaleString('es-CL') : '—';
}
function formatDate(value){
  if(!value) return 'Sin sincronización registrada';
  const d=new Date(value);
  return Number.isNaN(d.getTime()) ? 'Sin fecha disponible' : d.toLocaleString('es-CL');
}
async function api(url, options={}){
  const response=await fetch(url,{
    ...options,
    headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  const contentType=response.headers.get('content-type')||'';
  let payload=null;
  if(contentType.includes('application/json')){
    payload=await response.json().catch(()=>({}));
  }else{
    const text=await response.text();
    payload={message:text};
  }
  if(!response.ok){
    const err=new Error(payload?.error||payload?.message||`Error ${response.status}`);
    err.status=response.status;
    err.payload=payload;
    throw err;
  }
  return payload;
}
function loadState(){
  const savedProfile=safeJson(localStorage.getItem(STORAGE.profile));
  if(savedProfile?.name){
    state.profile={...state.profile,...savedProfile};
    state.hasProfile=true;
  }
}
async function loadStatus(){
  const payload=await api('/api/status');
  state.status=payload;
  state.lastSyncAt=payload.lastSyncAt||null;
  renderStatus();
  return payload;
}
async function loadCatalog(){
  const payload=await api('/api/products?filter=all&q=');
  state.products=Array.isArray(payload.products)?payload.products:[];
  if(payload.lastSyncAt) state.lastSyncAt=payload.lastSyncAt;
  updateSummaryAssigned();
  return state.products;
}
function renderStatus(){
  const s=state.status||{};
  if($('#summary-products')) $('#summary-products').textContent=formatNumber(s.productCount||state.products.length);
  if($('#summary-sync-interval')) $('#summary-sync-interval').textContent=s.autoSyncEnabled?`Cada ${s.syncIntervalMinutes||30} minutos`:'Desactivada';
  if($('#summary-sync-state')){
    $('#summary-sync-state').textContent=s.autoSyncEnabled?'Activa':'Manual';
    $('#summary-sync-state').classList.toggle('muted-status',!s.autoSyncEnabled);
  }
  const authorized=!!s.relbaseAuthorized;
  const configured=!!s.relbaseStatus?.configured;
  if($('#relbase-status-title')) $('#relbase-status-title').textContent=authorized?'Relbase conectado':(configured?'Relbase pendiente de autorización':'Relbase no configurado');
  if($('#last-sync-label')) $('#last-sync-label').textContent=state.lastSyncAt?`Última sincronización: ${formatDate(state.lastSyncAt)}`:(s.syncStatus||'Sin sincronización registrada');
  if($('#relbase-status-detail')){
    const wh = 'Bodega principal';
    $('#relbase-status-detail').textContent=`${formatNumber(s.productCount||0)} productos · OAuth ${authorized?'autorizado':'pendiente'} · ${wh}`;
  }
  $('#relbase-connect-btn')?.classList.toggle('hidden',authorized||!configured);
  if($('#sync-now-btn')) $('#sync-now-btn').disabled=!authorized || state.syncing;
}
function setAvatarElements(){
  $$('.current-avatar').forEach(el => {
    el.dataset.avatar = state.profile.avatar;
    el.dataset.initial = firstName().charAt(0).toUpperCase();
  });
}
function applyProfile(){
  $('#header-user-name').textContent = state.profile.name;
  $('#profile-popover-name').textContent = state.profile.name;
  $('#welcome-name').textContent = firstName();
  $('#settings-preview-name').textContent = state.profile.name;
  $('#settings-name').value = state.profile.name;
  setAvatarElements();
  $$('.avatar-choice').forEach(btn => btn.classList.toggle('selected', btn.dataset.avatarChoice === state.profile.avatar));
}
function saveProfile(){
  const name = $('#settings-name').value.trim().slice(0,50);
  if(!name){
    $('#settings-name').focus();
    return;
  }
  state.profile.name = name;
  localStorage.setItem(STORAGE.profile, JSON.stringify(state.profile));
  applyProfile();
  const note = $('#settings-saved');
  note.classList.remove('hidden');
  setTimeout(()=>note.classList.add('hidden'), 1800);
}

function setView(view){
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.mobile-nav-item').forEach(b => b.classList.toggle('active', b.dataset.mobileView === view));
  $('#profile-popover').classList.add('hidden');
  closeDrawer();

  if(view === 'locations') renderLocations();
  if(view === 'assignments') renderAssignments();
  if(view === 'inventory') renderInventory();
  if(view === 'excel') renderExcelPreview();
  if(view === 'settings') applyProfile();

  window.scrollTo({top:0,behavior:'auto'});
}

async function searchProduct(query){
  const q=String(query||'').trim();
  if(!q) return;
  hideSearchSuggestions();
  const message=$('#search-message');
  message.classList.add('hidden');

  let candidate=state.products.find(x=>normalizeSku(x.sku)===normalizeSku(q)||String(x.barcode||'')===q);
  if(!candidate) candidate=state.products.find(x=>matchesProduct(x,q));

  if(!candidate){
    try{
      const list=await api(`/api/products?filter=all&q=${encodeURIComponent(q)}`);
      candidate=(list.products||[])[0]||null;
      if(candidate) mergeProduct(candidate);
    }catch{}
  }

  if(!candidate){
    message.textContent=`No encontramos “${q}” en el catálogo sincronizado.`;
    message.classList.remove('hidden');
    return;
  }

  try{
    const live=await api(`/api/products/search?sku=${encodeURIComponent(candidate.sku)}`);
    if(live.product) candidate=mergeProduct(live.product);
    if(live.lastSyncAt) state.lastSyncAt=live.lastSyncAt;
  }catch(error){
    if(error.status!==404 && error.status!==502) console.warn(error);
  }

  state.currentSku=candidate.sku;
  localStorage.setItem(STORAGE.lastSku,candidate.sku);
  renderCurrentProduct();
  renderStatus();
}

function renderCurrentProduct(){
  const p=productBySku(state.currentSku);
  if(!p) return;

  $('#product-sku').textContent=p.sku||'—';
  $('#product-name').textContent=p.name||'Producto sin nombre';
  $('#product-brand').textContent=`Marca: ${displayBrand(p)}`;
  $('#product-stock').textContent=p.stock??'—';

  const statusText=$('.product-sync-label');
  if(statusText) statusText.textContent=state.status?.relbaseAuthorized?'Producto sincronizado':'Producto del catálogo';

  if(p.location){
    if(locationKind(p.location)==='special'){
      $('#location-title').textContent=p.location.areaLabel||'Ubicación especial';
      $('#location-side').textContent=p.location.spotLabel||'Zona especial';
      $('#location-rack').textContent=p.location.position?`Posición ${p.location.position}`:'Ubicación especial';
    }else{
      $('#location-title').textContent=`Pasillo ${p.location.aisle}`;
      $('#location-side').textContent=`Lado ${sideLabel(p.location.side)}`;
      $('#location-rack').innerHTML=`Rack ${p.location.rack}&nbsp;&nbsp;·&nbsp;&nbsp;Nivel ${p.location.level}`;
    }
  }else{
    $('#location-title').textContent='Sin ubicación';
    $('#location-side').textContent='Este producto todavía no está asignado';
    $('#location-rack').textContent='—';
  }

  const mapChevron=$('#location-chevron-btn');
  if(mapChevron){
    const canMap=locationKind(p.location)==='normal';
    mapChevron.disabled=!canMap;
    mapChevron.classList.toggle('hidden',!canMap);
  }

  $('#mini-map').innerHTML=warehouseMapSvg(p,true);
  $('#mobile-map') && ($('#mobile-map').innerHTML=warehouseMapSvg(p,true));
}

function warehouseMapSvg(product, compact=false){
  const rawLoc=product?.location||null;
  const loc=locationKind(rawLoc)==='normal'?rawLoc:null;
  const W=compact?900:1600;
  const H=compact?430:850;
  const frameX=compact?10:28;
  const frameY=compact?10:26;
  const rackTop=compact?95:190;
  const rackBottom=compact?326:640;
  const cellGap=compact?2.6:6.5;
  const rackW=compact?28:58;
  const aisleW=compact?18:34;
  const sidePadding=compact?34:92;
  const groupW=rackW*2+aisleW;
  const groupGap=(W-sidePadding*2-groupW*6)/5;
  const cellH=(rackBottom-rackTop-cellGap*10)/11;
  const font='font-family="Inter,Segoe UI,Arial,sans-serif"';

  const rackCell=(x,y,active)=>`
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${rackW}" height="${cellH.toFixed(1)}"
      rx="${compact?3.5:6}" fill="${active?'#146ef5':'#eef3f8'}"
      stroke="${active?'#0b5ed7':'#b9c9db'}" stroke-width="${active?(compact?1.8:2.2):(compact?1:1.25)}"/>
    ${active?`<circle cx="${(x+rackW/2).toFixed(1)}" cy="${(y+cellH/2).toFixed(1)}" r="${compact?3.3:5}" fill="#ffffff" stroke="#0d4fae" stroke-width="${compact?1:1.4}"/>`:''}`;

  let groups='';
  for(let aisle=1;aisle<=6;aisle++){
    const gx=sidePadding+(aisle-1)*(groupW+groupGap);
    const leftX=gx;
    const aisleX=gx+rackW;
    const rightX=aisleX+aisleW;
    const centerX=gx+groupW/2;
    const activeAisle=!!loc&&Number(loc.aisle)===aisle;
    let leftCells='',rightCells='';

    for(let rack=1;rack<=11;rack++){
      const y=rackTop+(11-rack)*(cellH+cellGap);
      const side=String(loc?.side||'').toUpperCase();
      leftCells+=rackCell(leftX,y,!!loc&&Number(loc.aisle)===aisle&&side==='I'&&Number(loc.rack)===rack);
      rightCells+=rackCell(rightX,y,!!loc&&Number(loc.aisle)===aisle&&side==='D'&&Number(loc.rack)===rack);
    }

    groups+=`<g>
      <text x="${centerX.toFixed(1)}" y="${compact?48:130}" text-anchor="middle" ${font}
        fill="${activeAisle?'#146ef5':'#152238'}" font-size="${compact?19:23}" font-weight="700">P${aisle}</text>
      <text x="${(leftX+rackW/2).toFixed(1)}" y="${compact?73:165}" text-anchor="middle" ${font}
        fill="#23344d" font-size="${compact?11:14}" font-weight="700">I</text>
      <text x="${(rightX+rackW/2).toFixed(1)}" y="${compact?73:165}" text-anchor="middle" ${font}
        fill="#23344d" font-size="${compact?11:14}" font-weight="700">D</text>
      <rect x="${aisleX.toFixed(1)}" y="${(rackTop-1).toFixed(1)}" width="${aisleW}" height="${(rackBottom-rackTop+2).toFixed(1)}"
        rx="${aisleW/2}" fill="${activeAisle?'#f4f8ff':'#fbfcfe'}"
        stroke="${activeAisle?'#c7dcff':'#d9e4ef'}" stroke-width="${compact?1:1.2}" stroke-dasharray="${compact?'3 3':'5 5'}"/>
      ${leftCells}${rightCells}
    </g>`;
  }

  let rowGuide='';
  if(!compact){
    for(let rack=11;rack>=1;rack--){
      const y=rackTop+(11-rack)*(cellH+cellGap)+cellH/2+4;
      rowGuide+=`<text x="63" y="${y.toFixed(1)}" ${font} fill="#263750" font-size="13" font-weight="700" text-anchor="middle">${rack}</text>`;
    }
  }

  const zoneHeader=compact?'':`
    <g ${font}>
      <g transform="translate(54 58)" stroke="#146ef5" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M0 7 12 0l12 7-12 7L0 7Zm0 8 12 7 12-7M0 23l12 7 12-7"/>
      </g>
      <text x="94" y="80" fill="#152238" font-size="15" font-weight="700" letter-spacing=".25">ZONA DE PICKING</text>
      <text x="63" y="${rackTop-18}" fill="#263750" font-size="12.5" font-weight="700" text-anchor="middle">FONDO</text>
      <text x="63" y="${rackBottom+31}" fill="#263750" font-size="12.5" font-weight="700" text-anchor="middle">ENTRADA</text>
      ${rowGuide}
    </g>`;

  const legend=compact?'':`
    <g transform="translate(${W-350} ${H-88})" ${font}>
      <circle cx="10" cy="10" r="8" fill="#146ef5"/><circle cx="10" cy="10" r="3" fill="#fff"/>
      <text x="29" y="15" fill="#263750" font-size="13" font-weight="700">Producto</text>
      <line x1="148" y1="-4" x2="148" y2="26" stroke="#d7e0ea"/>
      <rect x="176" y="1" width="23" height="18" rx="4" fill="#eef3f8" stroke="#b9c9db" stroke-width="1.2"/>
      <text x="210" y="15" fill="#263750" font-size="13" font-weight="700">Rack</text>
    </g>`;

  const entranceY=compact?H-52:H-79;
  const entrance=`
    <g transform="translate(${W/2-(compact?70:103)} ${entranceY})" ${font}>
      <path d="M18 0v${compact?20:27}m0 0-8-8m8 8 8-8" stroke="#146ef5" stroke-width="${compact?2.3:2.8}"
        fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="${compact?38:47}" y="${compact?-2:-1}" width="${compact?103:145}" height="${compact?27:36}"
        rx="${compact?8:11}" fill="#eff5ff" stroke="#c6dcff" stroke-width="1.2"/>
      <text x="${compact?89.5:119.5}" y="${compact?16.5:23}" text-anchor="middle" fill="#194d91"
        font-size="${compact?11:13.5}" font-weight="700">ENTRADA</text>
    </g>`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${escapeHtml(loc?locationLabel(loc):'Mapa de bodega')}" xmlns="http://www.w3.org/2000/svg"
      shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <rect x="${frameX}" y="${frameY}" width="${W-frameX*2}" height="${H-frameY*2}" rx="${compact?18:25}"
      fill="#fbfcfe" stroke="#d8e3ee" stroke-width="${compact?1.2:1.6}"/>
    ${zoneHeader}${groups}${entrance}${legend}
  </svg>`;
}

function renderLocations(){
  const selected=productBySku(state.currentSku)||state.products.find(p=>locationKind(p.location)==='normal');
  $('#full-map').innerHTML=warehouseMapSvg(selected,false);
  const list=$('#location-list');
  const items=state.products
    .filter(p=>p.location)
    .sort((a,b)=>{
      const ak=locationKind(a.location), bk=locationKind(b.location);
      if(ak!==bk) return ak==='normal'?-1:1;
      if(ak==='special') return locationLabel(a.location).localeCompare(locationLabel(b.location));
      return (a.location.aisle-b.location.aisle)||(a.location.rack-b.location.rack)||(a.location.level-b.location.level);
    })
    .slice(0,250);
  list.innerHTML=items.length?items.map(p=>`
    <button class="compact-item" type="button" data-map-sku="${escapeHtml(p.sku)}">
      <div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.sku)}</small></div>
      <span class="location-tag">${escapeHtml(shortLocation(p.location))}</span>
    </button>`).join(''):'<div class="compact-item"><div><strong>Sin ubicaciones</strong><small>Aún no hay productos ubicados.</small></div></div>';
  $$('[data-map-sku]').forEach(btn=>btn.addEventListener('click',()=>{
    state.currentSku=btn.dataset.mapSku;
    localStorage.setItem(STORAGE.lastSku,state.currentSku);
    $('#full-map').innerHTML=warehouseMapSvg(productBySku(state.currentSku),false);
  }));
}

function renderAssignments(){
  const q=$('#assignment-search')?.value||'';
  const list=$('#assignment-product-list');
  const products=state.products.filter(p=>matchesProduct(p,q)).slice(0,220);
  list.innerHTML=products.map(p=>`
    <button class="product-picker-item ${p.sku===state.assignmentSku?'selected':''}" type="button" data-assign-sku="${escapeHtml(p.sku)}">
      <strong>${escapeHtml(p.name)}</strong>
      <small>SKU: ${escapeHtml(p.sku)} · Stock ${escapeHtml(p.stock??'—')} · ${escapeHtml(shortLocation(p.location))}</small>
    </button>`).join('');
  $$('[data-assign-sku]').forEach(btn=>btn.addEventListener('click',()=>selectAssignmentProduct(btn.dataset.assignSku)));
  renderAssignmentEditor();
}
function selectAssignmentProduct(sku){
  const p=productBySku(sku); if(!p)return;
  state.assignmentSku=p.sku;
  state.assignment=locationKind(p.location)==='normal'
    ? {aisle:Number(p.location.aisle),side:String(p.location.side).toUpperCase(),rack:Number(p.location.rack),level:Number(p.location.level)}
    : {aisle:1,side:'I',rack:1,level:1};
  renderAssignments();
}
function renderAssignmentEditor(){
  const p=productBySku(state.assignmentSku); if(!p)return;
  $('#assign-sku').textContent=p.sku;
  $('#assign-name').textContent=p.name;
  $('#assign-stock').textContent=p.stock??'—';
  $('#delete-location-btn')?.classList.toggle('hidden',!p.location);

  renderChoice('#aisle-options',[1,2,3,4,5,6],'aisle',v=>String(v));
  renderChoice('#side-options',['I','D'],'side',v=>v==='I'?'Izquierdo':'Derecho');
  renderChoice('#rack-options',Array.from({length:11},(_,i)=>i+1),'rack',v=>String(v));
  renderChoice('#level-options',[1,2,3,4,5],'level',v=>String(v));
  updateAssignmentPreview();
}
function renderChoice(selector, values, key, labeler){
  const el=$(selector);
  el.innerHTML=values.map(v=>`<button type="button" class="choice-btn ${String(state.assignment[key])===String(v)?'active':''}" data-choice-key="${key}" data-choice-value="${v}">${labeler(v)}</button>`).join('');
  $$('[data-choice-key]',el).forEach(btn=>btn.addEventListener('click',()=>{
    const k=btn.dataset.choiceKey; let val=btn.dataset.choiceValue;
    if(k!=='side') val=Number(val);
    state.assignment[k]=val;
    renderAssignmentEditor();
  }));
}
function updateAssignmentPreview(){
  const l=state.assignment;
  $('#assignment-preview').innerHTML=`Ubicación seleccionada: <strong>Pasillo ${l.aisle} · ${l.side==='I'?'Izquierdo':'Derecho'} · Rack ${l.rack} · Nivel ${l.level}</strong>`;
}
async function saveAssignment(){
  const p=productBySku(state.assignmentSku); if(!p)return;
  try{
    const payload=await api(`/api/products/${encodeURIComponent(p.sku)}/location`,{
      method:'PUT',
      body:JSON.stringify({...state.assignment,updatedBy:state.profile.name})
    });
    mergeProduct(payload.product);
    state.currentSku=p.sku;
    localStorage.setItem(STORAGE.lastSku,p.sku);
    renderAssignments();
    renderCurrentProduct();
    updateSummaryAssigned();
    showToast(payload.message||`Ubicación guardada para ${p.sku}`);
  }catch(error){
    showToast(error.message||'No se pudo guardar la ubicación');
  }
}

async function deleteCurrentLocation(){
  const p=productBySku(state.assignmentSku); if(!p?.location)return;
  if(!confirm(`¿Quitar la ubicación actual de ${p.sku}?`)) return;
  try{
    const payload=await api(`/api/products/${encodeURIComponent(p.sku)}/location`,{
      method:'DELETE',
      body:JSON.stringify({updatedBy:state.profile.name})
    });
    mergeProduct(payload.product);
    state.currentSku=p.sku;
    renderAssignments();
    renderCurrentProduct();
    updateSummaryAssigned();
    showToast(payload.message||'Ubicación eliminada');
  }catch(error){
    showToast(error.message||'No se pudo eliminar la ubicación');
  }
}

async function openSpecialLocationModal(){
  const p=productBySku(state.assignmentSku); if(!p)return;
  const areas=state.status?.specialAreas||[];
  if(!areas.length){
    showToast('No hay zonas especiales configuradas.');
    return;
  }
  const current=locationKind(p.location)==='special'?p.location:null;
  const areaOptions=areas.map(a=>`<option value="${escapeHtml(a.key)}" ${current?.areaKey===a.key?'selected':''}>${escapeHtml(a.label)}</option>`).join('');
  openModal(`<div class="modal-title-row"><div><span class="eyebrow">UBICACIÓN ESPECIAL</span><h2>${escapeHtml(p.sku)}</h2></div></div>
    <p>${escapeHtml(p.name)}</p>
    <div class="special-modal-grid">
      <label>Zona<select id="special-area-select">${areaOptions}</select></label>
      <label>Lugar<select id="special-spot-select"></select></label>
      <label id="special-position-wrap" class="hidden">Posición<input id="special-position-input" type="number" min="1" inputmode="numeric" placeholder="Ejemplo: 8"></label>
    </div>
    <div class="modal-action-row"><button id="save-special-modal" class="btn btn-primary" type="button">Guardar ubicación especial</button></div>`);

  const areaSelect=$('#special-area-select'), spotSelect=$('#special-spot-select'), posWrap=$('#special-position-wrap'), posInput=$('#special-position-input');
  const refreshSpots=()=>{
    const area=areas.find(a=>a.key===areaSelect.value)||areas[0];
    spotSelect.innerHTML=(area?.spots||[]).map(s=>`<option value="${escapeHtml(s.key)}" ${current?.spotKey===s.key?'selected':''}>${escapeHtml(s.label)}</option>`).join('');
    if(current?.position) posInput.value=current.position;
    posWrap.classList.toggle('hidden',spotSelect.value!=='PISO');
  };
  areaSelect.addEventListener('change',refreshSpots);
  spotSelect.addEventListener('change',()=>posWrap.classList.toggle('hidden',spotSelect.value!=='PISO'));
  refreshSpots();
  $('#save-special-modal').addEventListener('click',async()=>{
    try{
      const payload=await api(`/api/products/${encodeURIComponent(p.sku)}/special-location`,{
        method:'PUT',
        body:JSON.stringify({
          areaKey:areaSelect.value,
          spotKey:spotSelect.value,
          position:spotSelect.value==='PISO'?Number(posInput.value):null,
          updatedBy:state.profile.name
        })
      });
      mergeProduct(payload.product);
      state.currentSku=p.sku;
      closeModal();
      renderAssignments();
      renderCurrentProduct();
      updateSummaryAssigned();
      showToast(payload.message||'Ubicación especial guardada');
    }catch(error){
      showToast(error.message||'No se pudo guardar la ubicación especial');
    }
  });
}

function renderInventory(){
  const q=$('#inventory-search')?.value||'';
  const filter=$('#inventory-filter')?.value||'all';
  let products=state.products.filter(p=>matchesProduct(p,q));
  if(filter==='stock')products=products.filter(p=>p.stock>0);
  if(filter==='assigned')products=products.filter(p=>p.location);
  if(filter==='unassigned')products=products.filter(p=>!p.location);
  products=products.slice(0,300);
  $('#inventory-body').innerHTML=products.map(p=>`
    <tr>
      <td><strong>${escapeHtml(p.name)}</strong><small>Marca: ${escapeHtml(displayBrand(p))}</small></td>
      <td>${escapeHtml(p.sku)}</td>
      <td><span class="stock-table">${p.stock}</span></td>
      <td><span class="${p.location?'assigned':'unassigned'}">${escapeHtml(locationLabel(p.location))}</span></td>
      <td><button type="button" class="table-action" data-edit-inventory="${p.sku}">Editar</button></td>
    </tr>`).join('');
  $$('[data-edit-inventory]').forEach(btn=>btn.addEventListener('click',()=>{
    state.assignmentSku=btn.dataset.editInventory;
    selectAssignmentProduct(state.assignmentSku);
    setView('assignments');
  }));
}

function renderExcelPreview(){
  const aisle=Number($('#excel-aisle')?.value||3);
  const products=state.products.filter(p=>p.location?.aisle===aisle).sort(locationSort);
  $('#excel-preview-count').textContent=`${products.length} producto${products.length===1?'':'s'} del Pasillo ${aisle}`;
  $('#excel-preview-list').innerHTML=products.length?products.map(p=>`
    <div class="compact-item">
      <div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.sku)}</small></div>
      <span class="location-tag">${shortLocation(p.location)}</span>
    </div>`).join(''):`<div class="compact-item"><div><strong>Sin productos</strong><small>Todavía no hay ubicaciones asignadas en este pasillo.</small></div></div>`;
}
function locationSort(a,b){
  const sideOrder={I:0,D:1};
  return (sideOrder[a.location.side]-sideOrder[b.location.side])||(a.location.rack-b.location.rack)||(a.location.level-b.location.level);
}
function downloadExcel(){
  const aisle=Number($('#excel-aisle').value);
  const url=`/api/exports/aisle?aisle=${encodeURIComponent(aisle)}&type=final`;
  window.location.href=url;
  showToast(`Preparando Excel del Pasillo ${aisle}`);
}

function updateSummaryAssigned(){
  const assigned=state.products.filter(p=>!!p.location).length;
  if($('#summary-assigned')) $('#summary-assigned').innerHTML=`${assigned.toLocaleString('es-CL')} <em>productos</em>`;
  if($('#summary-products') && state.products.length) $('#summary-products').textContent=state.products.length.toLocaleString('es-CL');
}

function openMapModal(){
  const p=productBySku(state.currentSku);
  if(!p)return;
  const loc=locationKind(p.location)==='normal'?p.location:null;

  const locationSummary=loc ? `
    <div class="map-location-summary" aria-label="Ubicación seleccionada">
      <div><span>Pasillo</span><strong>${escapeHtml(loc.aisle)}</strong></div>
      <div><span>Lado</span><strong>${escapeHtml(sideLabel(loc.side))}</strong></div>
      <div><span>Rack</span><strong>${escapeHtml(loc.rack)}</strong></div>
      <div><span>Nivel</span><strong>${escapeHtml(loc.level)}</strong></div>
    </div>` : `
    <div class="map-location-summary map-location-empty">
      <div><span>Ubicación</span><strong>${escapeHtml(locationLabel(p.location))}</strong></div>
    </div>`;

  openModal(`<div class="modal-title-row">
      <div><span class="eyebrow">UBICACIÓN</span><h2>Mapa de bodega</h2></div>
    </div>
    <div class="map-product-context">
      <strong>${escapeHtml(p.name)}</strong>
      <span>SKU ${escapeHtml(p.sku)}</span>
    </div>
    ${locationSummary}
    <div class="modal-map">${warehouseMapSvg(p,false)}</div>
    <p class="map-help">P1–P6 representan los pasillos. I/D indican el lado izquierdo y derecho. Rack 1 está hacia la entrada y Rack 11 hacia el fondo.</p>`);
}
async function openHistoryModal(){
  const p=productBySku(state.currentSku); if(!p)return;
  openModal(`<h2>Historial de ubicaciones</h2><p>${escapeHtml(p.name)} · ${escapeHtml(p.sku)}</p><div class="history-list"><div class="history-entry"><strong>Cargando…</strong></div></div>`);
  try{
    const payload=await api(`/api/history?sku=${encodeURIComponent(p.sku)}&limit=100`);
    const history=payload.events||[];
    const list=$('.history-list');
    if(!list)return;
    list.innerHTML=history.length?history.map(h=>`
      <div class="history-entry">
        <strong>${escapeHtml(h.afterLabel||h.action||'Cambio de ubicación')}</strong>
        <small>${escapeHtml(h.updatedBy||'Sin identificar')} · ${formatDate(h.createdAt)}</small>
        ${h.beforeLabel?`<small>Antes: ${escapeHtml(h.beforeLabel)}</small>`:''}
      </div>`).join(''):`<div class="history-entry"><strong>Sin cambios registrados</strong><small>Los próximos cambios aparecerán aquí.</small></div>`;
  }catch(error){
    const list=$('.history-list'); if(list) list.innerHTML=`<div class="history-entry"><strong>No se pudo cargar el historial</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}
function openDetailsModal(){
  const p=productBySku(state.currentSku);
  openModal(`<h2>Detalles del producto</h2><p>${escapeHtml(p.name)}</p>
    <div class="modal-details-grid">
      <div class="detail-box"><span>SKU</span><strong>${escapeHtml(p.sku)}</strong></div>
      <div class="detail-box"><span>Código de barras</span><strong>${escapeHtml(p.barcode)}</strong></div>
      <div class="detail-box"><span>Marca</span><strong>${escapeHtml(displayBrand(p))}</strong></div>
      <div class="detail-box"><span>Stock</span><strong>${p.stock} unidades</strong></div>
      <div class="detail-box" style="grid-column:1/-1"><span>Ubicación</span><strong>${escapeHtml(locationLabel(p.location))}</strong></div>
    </div>`);
}
function openModal(html){
  $('#modal-content').innerHTML=html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal(){
  $('#modal-backdrop').classList.add('hidden');
  stopScanner();
}
function showToast(message){
  let t=$('#toast');
  if(!t){
    t=document.createElement('div');t.id='toast';t.style.cssText='position:fixed;z-index:200;left:50%;bottom:95px;transform:translateX(-50%);background:#0b2032;color:white;padding:10px 14px;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.18);font:700 12px system-ui;transition:.2s ease;opacity:0';
    document.body.appendChild(t);
  }
  t.textContent=message;t.style.opacity='1';
  clearTimeout(t._timer);t._timer=setTimeout(()=>t.style.opacity='0',1800);
}

async function openScanner(){
  openModal(`<h2>Escanear código</h2><p>Usa la cámara o escribe el código manualmente.</p>
    <div class="scanner-wrap">
      <div class="scanner-video" id="scanner-video-wrap"><span>Preparando cámara…</span></div>
      <div class="scanner-side">
        <p>Si tu navegador no permite lectura automática, puedes introducir el código de barras o SKU.</p>
        <input id="scanner-manual" placeholder="Código o SKU">
        <button id="scanner-manual-btn" class="btn btn-primary" type="button">Buscar código</button>
      </div>
    </div>`);
  $('#scanner-manual-btn').addEventListener('click',()=>{
    const value=$('#scanner-manual').value.trim(); if(!value)return;
    closeModal(); $('#search-input').value=value; searchProduct(value);
  });
  try{
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Cámara no disponible');
    state.scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
    const wrap=$('#scanner-video-wrap');
    if(!wrap)return;
    const video=document.createElement('video');video.autoplay=true;video.playsInline=true;video.srcObject=state.scannerStream;
    wrap.innerHTML='';wrap.appendChild(video);
    if('BarcodeDetector' in window){
      const detector=new BarcodeDetector({formats:['ean_13','ean_8','code_128','qr_code']});
      const tick=async()=>{
        if(!state.scannerStream||!document.body.contains(video))return;
        try{
          const codes=await detector.detect(video);
          if(codes[0]?.rawValue){
            const value=codes[0].rawValue; closeModal();$('#search-input').value=value;searchProduct(value);return;
          }
        }catch{}
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }catch{
    const wrap=$('#scanner-video-wrap');
    if(wrap)wrap.innerHTML='<span>La cámara no está disponible en este navegador. Usa el campo manual.</span>';
  }
}
function stopScanner(){
  if(state.scannerStream){state.scannerStream.getTracks().forEach(t=>t.stop());state.scannerStream=null}
}

async function syncNow(){
  if(state.syncing)return;
  const btn=$('#sync-now-btn'), box=$('#sync-progress'), fill=$('#sync-progress-fill'), pct=$('#sync-progress-percent'), label=$('#sync-progress-label');
  state.syncing=true; renderStatus();
  box.classList.remove('hidden');
  fill.style.width='2%'; pct.textContent='2%'; label.textContent='Iniciando sincronización…';

  const poll=async()=>{
    try{
      const p=await api('/api/sync/progress');
      const percent=Math.max(2,Math.min(100,Number(p.percent||0)));
      fill.style.width=`${percent}%`;
      pct.textContent=`${percent}%`;
      label.textContent=p.running
        ? `Página ${p.page||0}${p.totalPages?` de ${p.totalPages}`:''} · Productos: ${formatNumber(p.productCount||0)}`
        : (p.error||'Sincronización completada');
      return p;
    }catch{return null}
  };

  let timer=setInterval(poll,700);
  try{
    const result=await api('/api/sync',{method:'POST',body:'{}'});
    clearInterval(timer); timer=null;
    await poll();
    if(result.lastSyncAt) state.lastSyncAt=result.lastSyncAt;
    await loadStatus();
    await loadCatalog();
    renderCurrentProduct();
    renderAssignments();
    renderInventory();
    renderExcelPreview();
    fill.style.width='100%'; pct.textContent='100%'; label.textContent=result.message||'Sincronización completada';
    showToast(result.message||'Sincronización completada');
  }catch(error){
    if(timer)clearInterval(timer);
    label.textContent=error.message||'No se pudo sincronizar';
    showToast(error.message||'No se pudo sincronizar');
  }finally{
    state.syncing=false; renderStatus();
  }
}

function openDrawer(){
  if(window.innerWidth>860)return;
  $('#mobile-drawer').classList.remove('hidden');
  $('#mobile-drawer-backdrop').classList.remove('hidden');
}
function closeDrawer(){
  $('#mobile-drawer').classList.add('hidden');
  $('#mobile-drawer-backdrop').classList.add('hidden');
}
function toggleSidebar(){
  if(window.innerWidth<=860){openDrawer();return}
  $('#sidebar').classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed');
}


function showOnboarding(){
  openModal(`<div class="onboarding">
    <img src="/assets/kordis-logo-horizontal.png" alt="KORDIS">
    <span class="eyebrow">BIENVENIDO A KORDIS</span>
    <h2>¿Quién está usando el sistema?</h2>
    <p>Ingresa tu nombre para continuar.</p>
    <form id="onboarding-form">
      <input id="onboarding-name" maxlength="50" autocomplete="name" placeholder="Ejemplo: Juan Pérez">
      <button class="btn btn-primary" type="submit">Continuar</button>
    </form>
  </div>`);
  $('#modal-close').classList.add('hidden');
  $('#onboarding-form').addEventListener('submit',e=>{
    e.preventDefault();
    const name=$('#onboarding-name').value.trim().slice(0,50);
    if(!name){$('#onboarding-name').focus();return}
    state.profile.name=name;
    state.hasProfile=true;
    localStorage.setItem(STORAGE.profile,JSON.stringify(state.profile));
    applyProfile();
    $('#modal-close').classList.remove('hidden');
    closeModal();
  });
  setTimeout(()=>$('#onboarding-name')?.focus(),50);
}

function setupEvents(){
  $$('.nav-link').forEach(btn=>btn.addEventListener('click',()=>setView(btn.dataset.view)));
  $$('[data-view-jump]').forEach(btn=>btn.addEventListener('click',()=>setView(btn.dataset.viewJump)));
  $$('[data-mobile-view]').forEach(btn=>btn.addEventListener('click',()=>setView(btn.dataset.mobileView)));
  $$('[data-drawer-view]').forEach(btn=>btn.addEventListener('click',()=>setView(btn.dataset.drawerView)));

  $('#menu-btn').addEventListener('click',toggleSidebar);
  $('#drawer-close').addEventListener('click',closeDrawer);
  $('#mobile-drawer-backdrop').addEventListener('click',closeDrawer);

  $('#profile-btn').addEventListener('click',e=>{
    e.stopPropagation();$('#profile-popover').classList.toggle('hidden');
  });
  $$('[data-profile-action]').forEach(btn=>btn.addEventListener('click',()=>{
    setView('settings');
    if(btn.dataset.profileAction==='change')setTimeout(()=>$('#settings-name').focus(),150);
  }));
  document.addEventListener('click',e=>{if(!e.target.closest('.profile-btn')&&!e.target.closest('.profile-popover'))$('#profile-popover').classList.add('hidden')});

  $('#search-form').addEventListener('submit',e=>{
    e.preventDefault();
    searchProduct($('#search-input').value);
  });
  $('#search-input').addEventListener('input',e=>{
    const cursor=e.target.selectionStart;
    e.target.value=e.target.value.toUpperCase();
    if(Number.isInteger(cursor)) e.target.setSelectionRange(cursor,cursor);
    renderSearchSuggestions(e.target.value);
  });
  $('#search-input').addEventListener('focus',e=>{
    if(e.target.value.trim()) renderSearchSuggestions(e.target.value);
  });
  $('#search-input').addEventListener('keydown',e=>{
    const panel=$('#search-suggestions');
    const open=panel && !panel.classList.contains('hidden') && searchSuggestionProducts.length;
    if(e.key==='ArrowDown' && open){
      e.preventDefault();
      setSearchSuggestionActive(searchSuggestionIndex<0?0:searchSuggestionIndex+1);
    }else if(e.key==='ArrowUp' && open){
      e.preventDefault();
      setSearchSuggestionActive(searchSuggestionIndex<=0?searchSuggestionProducts.length-1:searchSuggestionIndex-1);
    }else if(e.key==='Enter' && open && searchSuggestionIndex>=0){
      e.preventDefault();
      const product=searchSuggestionProducts[searchSuggestionIndex];
      if(product){
        e.target.value=product.sku;
        searchProduct(product.sku);
      }
    }else if(e.key==='Escape'){
      hideSearchSuggestions();
    }
  });
  document.addEventListener('pointerdown',e=>{
    if(!e.target.closest('.search-input')) hideSearchSuggestions();
  });
  $$('[data-example]').forEach(btn=>btn.addEventListener('click',()=>{$('#search-input').value=btn.dataset.example;searchProduct(btn.dataset.example)}));
  $('#scan-btn').addEventListener('click',openScanner);
  $('#open-map-btn').addEventListener('click',openMapModal);
  $('#location-chevron-btn')?.addEventListener('click',openMapModal);
  $('#mobile-open-map')?.addEventListener('click',openMapModal);
  $('#mobile-excel-action')?.addEventListener('click',()=>setView('excel'));
  $('#mobile-open-map')?.addEventListener('click',openMapModal);
  $('#mobile-excel-action')?.addEventListener('click',()=>setView('excel'));
  $('#history-btn').addEventListener('click',openHistoryModal);
  $('#details-btn').addEventListener('click',openDetailsModal);
  $('#edit-location-btn').addEventListener('click',()=>{
    state.assignmentSku=state.currentSku;
    selectAssignmentProduct(state.currentSku);
    setView('assignments');
  });

  $('#assignment-search').addEventListener('input',renderAssignments);
  $('#save-assignment-btn').addEventListener('click',saveAssignment);
  $('#special-location-btn')?.addEventListener('click',openSpecialLocationModal);
  $('#delete-location-btn')?.addEventListener('click',deleteCurrentLocation);
  $('#inventory-search').addEventListener('input',renderInventory);
  $('#inventory-filter').addEventListener('change',renderInventory);
  $('#excel-aisle').addEventListener('change',renderExcelPreview);
  $('#download-excel-btn').addEventListener('click',downloadExcel);
  $('#sync-now-btn').addEventListener('click',syncNow);

  $$('.avatar-choice').forEach(btn=>btn.addEventListener('click',()=>{
    state.profile.avatar=btn.dataset.avatarChoice;
    setAvatarElements();
    $$('.avatar-choice').forEach(choice=>choice.classList.toggle('selected', choice.dataset.avatarChoice===state.profile.avatar));
  }));
  $('#settings-name').addEventListener('input',e=>{
    const preview=e.target.value.trim();
    $('#settings-preview-name').textContent=preview || 'Usuario';
    $$('.current-avatar').forEach(el=>{el.dataset.initial=(preview||'U').charAt(0).toUpperCase()});
  });
  $('#save-profile-btn').addEventListener('click',saveProfile);

  $('#modal-close').addEventListener('click',closeModal);
  $('#modal-backdrop').addEventListener('click',e=>{if(e.target===$('#modal-backdrop'))closeModal()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
}

async function init(){
  loadState();
  setupEvents();
  applyProfile();

  try{
    await loadStatus();
    await loadCatalog();
  }catch(error){
    console.error(error);
    $('#search-message').textContent=`No se pudo cargar el catálogo: ${error.message}`;
    $('#search-message').classList.remove('hidden');
  }

  const savedSku=localStorage.getItem(STORAGE.lastSku);
  const initial=productBySku(savedSku)||state.products.find(p=>Number(p.stock)>0&&p.location)||state.products.find(p=>Number(p.stock)>0)||state.products[0]||null;
  if(initial){
    state.currentSku=initial.sku;
    state.assignmentSku=initial.sku;
    state.assignment=locationKind(initial.location)==='normal'
      ? {aisle:Number(initial.location.aisle),side:String(initial.location.side).toUpperCase(),rack:Number(initial.location.rack),level:Number(initial.location.level)}
      : {aisle:1,side:'I',rack:1,level:1};
    renderCurrentProduct();
  }

  renderAssignments();
  renderInventory();
  renderExcelPreview();
  updateSummaryAssigned();
  renderStatus();

  if(!state.hasProfile) showOnboarding();
}

document.addEventListener('DOMContentLoaded',init);
