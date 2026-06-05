"use strict";
/* ===== helpers ===== */
const $ = id => document.getElementById(id);
function toast(m) { const s = $("status"); s.textContent = m; s.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => s.classList.remove("show"), 2800); }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function fmtPrice(v) { const n = parseFloat(String(v ?? "").replace(",",".")); return isFinite(n) ? n.toFixed(2) : String(v ?? ""); }
function priceLabel(v) { const p = fmtPrice(v); return p ? (p + " " + state.settings.currency) : ""; }
function activeExtraNames() { return state.settings.extraFields.map(s => (s||"").trim()).filter(Boolean); }
function statusText(s) { return s==="in_stock"?"в наличност":s==="sold"?"продадено":"генериран"; }

/* ===== state ===== */
const CFG_KEY = "linenapp_cfg";
const DEFAULT_SETTINGS = { extraFields:["","",""], prefix:"", pad:6, next:1, currency:"€", perRow:4 };
let state = { settings:{...DEFAULT_SETTINGS}, catalog:[], labels:[], counts:{total:0,in_stock:0,sold:0,generated:0} };

function loadCfg() { try { return JSON.parse(localStorage.getItem(CFG_KEY)||"null"); } catch(e) { return null; } }
function saveCfg(url,key) { localStorage.setItem(CFG_KEY, JSON.stringify({url,key})); }

/* ===== SQL setup text ===== */
const SQL_SETUP = `-- Изпълнете веднъж в Supabase → SQL Editor → Run

create table if not exists settings (
  id text primary key,
  data jsonb not null default '{}'::jsonb
);
create table if not exists catalog (
  id text primary key,
  article_number text, model text, price text,
  extra jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
create table if not exists labels (
  number text primary key,
  article_number text, model text, price text,
  extra jsonb default '[]'::jsonb,
  batch_id text, batch_name text,
  status text default 'generated',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table labels add column if not exists stocked_at timestamptz;
alter table labels add column if not exists sold_at timestamptz;

grant usage on schema public to anon, authenticated;
grant all on settings, catalog, labels to anon, authenticated;
alter table settings enable row level security;
alter table catalog  enable row level security;
alter table labels   enable row level security;
drop policy if exists "all_settings" on settings;
drop policy if exists "all_catalog"  on catalog;
drop policy if exists "all_labels"   on labels;
create policy "all_settings" on settings for all to anon, authenticated using (true) with check (true);
create policy "all_catalog"  on catalog  for all to anon, authenticated using (true) with check (true);
create policy "all_labels"   on labels   for all to anon, authenticated using (true) with check (true);
notify pgrst, 'reload schema';`;

/* ===== sync indicator ===== */
const syncDot = document.getElementById("sync-dot");
db.onStatus((status, pending) => {
  syncDot.className = "sync-dot " + (status === "ok" ? "ok" : status === "pending" ? "pending" : status === "offline" ? "error" : "");
  syncDot.title = status === "ok" ? "Синхронизирано" : status === "pending" ? `${pending} чакащи операции` : status === "offline" ? "Офлайн" : "";
});

/* ===== connect ===== */
async function connectDB(url, key, silent) {
  try {
    await db.connect(url, key);
    const s = await db.getSettings();
    state.settings = Object.assign({...DEFAULT_SETTINGS}, s || {});
    if (!Array.isArray(state.settings.extraFields)) state.settings.extraFields = ["","",""];
    while (state.settings.extraFields.length < 3) state.settings.extraFields.push("");
    state.catalog = await db.getCatalog();
    state.labels  = await db.getLabels();
    state.counts  = await db.getCounts();
    saveCfg(url, key);
    renderBanner(); renderGenerate(); renderSettingsForm();
    renderScanSummary(); renderLabelSummary();
    if (!silent) toast("Свързано с базата");
    return true;
  } catch(e) {
    const msg = (e&&e.message)||String(e);
    if (/relation|does not exist|schema cache|table/i.test(msg)) {
      renderBanner("Таблиците липсват. Отворете „Настройки" и изпълнете SQL-а.");
      showSqlBox();
    } else {
      renderBanner("Грешка: " + msg);
    }
    if (!silent) toast("Грешка: " + msg);
    return false;
  }
}

async function loadFromIDBOnly() {
  state.labels  = await db.getLabels();
  state.catalog = await db.getCatalog();
  const s = await db.getSettings();
  if (s) state.settings = Object.assign({...DEFAULT_SETTINGS}, s);
  state.counts = await db.getCounts();
  renderBanner(); renderGenerate(); renderSettingsForm();
  renderScanSummary(); renderLabelSummary();
}

function renderBanner(customMsg) {
  const b = $("conn-banner");
  if (!customMsg && db.isOnline()) { b.innerHTML = ""; return; }
  if (customMsg) { b.innerHTML = `<div class="note warn">${esc(customMsg)}</div>`; return; }
  const pending = db.getPendingCount ? "" : "";
  b.innerHTML = `<div class="note warn">Офлайн — данните се пазят локално. Промените ще се синхронизират при връзка с интернет.</div>`;
}

async function refreshCounts() {
  state.counts = await db.getCounts();
  renderScanSummary(); renderLabelSummary();
}

/* ===== dark theme ===== */
const THEME_KEY = "linenapp_theme";
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("theme-btn").textContent = t === "dark" ? "☀️" : "🌙";
  localStorage.setItem(THEME_KEY, t);
}
$("theme-btn").addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
});
applyTheme(localStorage.getItem(THEME_KEY) || "light");

/* ===== tabs ===== */
document.querySelectorAll("nav button[data-tab]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("nav button[data-tab]").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  const tab = b.dataset.tab;
  ["generate","scan","catalog","labels","stats","settings"].forEach(t => $("tab-"+t).style.display = (t===tab) ? "block" : "none");
  if (tab === "generate") renderGenerate();
  if (tab === "scan")     renderScanSummary();
  if (tab === "catalog")  renderCatalog();
  if (tab === "labels")   renderLabels();
  if (tab === "stats")    loadStats();
  if (tab === "settings") renderSettingsForm();
  if (tab !== "scan")     stopScan();
}));

/* ===== QR ===== */
if (window.qrcode && qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs["UTF-8"]) {
  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
}
function makeQR(text) { const qr = qrcode(0,"M"); qr.addData(String(text),"Byte"); qr.make(); return qr; }
function drawQR(ctx, text, x, y, size) {
  const qr = makeQR(text), n = qr.getModuleCount(), cell = size/n;
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r,c)) ctx.fillRect(x+c*cell, y+r*cell, cell+0.6, cell+0.6);
}
function qrCanvas(text, px) { const c = document.createElement("canvas"); c.width = px; c.height = px; const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0,0,px,px); drawQR(ctx,text,0,0,px); return c; }

/* ===== label canvas for PDF ===== */
function wrapLines(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/), lines = []; let cur = "";
  for (const w of words) { const t = cur ? cur+" "+w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; let last = lines[maxLines-1]; while (ctx.measureText(last+"…").width > maxW && last.length > 1) last = last.slice(0,-1); lines[maxLines-1] = last+"…"; }
  return lines;
}
function labelDataURL(rec) {
  const W = 460, H = 600, c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0,0,W,H);
  ctx.fillStyle = "#1c1c1a"; ctx.textAlign = "center";
  let y = 52; ctx.font = "600 34px sans-serif";
  wrapLines(ctx, rec.model||rec.articleNumber||"", W-40, 2).forEach(l => { ctx.fillText(l,W/2,y); y += 40; });
  const extras = state.settings.extraFields.map((n,i) => ((n||"").trim() && rec.extra && rec.extra[i]) ? rec.extra[i] : null).filter(Boolean);
  if (extras.length) { ctx.font = "23px sans-serif"; ctx.fillStyle = "#6b6b66"; ctx.fillText(wrapLines(ctx,extras.join(" · "),W-40,1)[0],W/2,y); y += 18; ctx.fillStyle = "#1c1c1a"; }
  const qy = Math.max(y+8, 140); drawQR(ctx, rec.number, (W-250)/2, qy, 250);
  const pl = priceLabel(rec.price); if (pl) { ctx.font = "700 56px sans-serif"; ctx.fillText(pl,W/2,qy+250+58); }
  ctx.font = "22px sans-serif"; ctx.fillStyle = "#6b6b66"; ctx.fillText("№ "+rec.number,W/2,H-22);
  return c.toDataURL("image/png");
}

/* ===== PDF ===== */
function exportPDF(list) {
  if (!list||!list.length) { toast("Няма етикети за печат"); return; }
  if (!window.jspdf||!window.jspdf.jsPDF) { toast("PDF библиотеката не е заредена"); return; }
  toast("Подготвям PDF…");
  setTimeout(() => {
    const {jsPDF} = window.jspdf, doc = new jsPDF({unit:"mm",format:"a4"});
    const margin = 10, perRow = Math.max(2, Math.min(8, state.settings.perRow||4));
    const cellW = (210-margin*2)/perRow, cellH = cellW*1.30;
    const perCol = Math.max(1, Math.floor((297-margin*2)/cellH)), perPage = perRow*perCol;
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && i%perPage === 0) doc.addPage();
      const ip = i%perPage, col = ip%perRow, row = Math.floor(ip/perRow);
      const x = margin+col*cellW, y = margin+row*cellH, pad = 1.5;
      doc.addImage(labelDataURL(list[i]),"PNG",x+pad,y+pad,cellW-2*pad,cellH-2*pad);
      doc.setDrawColor(210); doc.setLineWidth(0.1); doc.rect(x,y,cellW,cellH);
    }
    doc.save("etiketi-"+new Date().toISOString().slice(0,10)+".pdf");
    toast("PDF е готов");
  }, 30);
}

/* ===== CSV ===== */
function exportCSV(list, filename) {
  if (!list||!list.length) { toast("Няма редове за експорт"); return; }
  const names = activeExtraNames();
  const head = ["Номер","Артикулен №","Модел","Цена","Валута",...names,"Партида","Статус","Създаден","Входиран","Продаден"];
  const rows = [head];
  const d = v => v ? new Date(v).toLocaleString("bg-BG") : "";
  list.forEach(l => {
    const ex = state.settings.extraFields.map((n,i) => (n||"").trim() ? ((l.extra&&l.extra[i])||"") : null).filter(v => v !== null);
    rows.push([l.number,l.articleNumber,l.model,fmtPrice(l.price),state.settings.currency,...ex,l.batchName||"",statusText(l.status),d(l.createdAt),d(l.stockedAt),d(l.soldAt)]);
  });
  const csv = rows.map(r => r.map(v => { const s = String(v??""); return /[",;\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }).join(";")).join("\n");
  const blob = new Blob(["﻿"+csv],{type:"text/csv;charset=utf-8"}), a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename||"etiketi.csv"; a.click(); URL.revokeObjectURL(a.href);
}

/* ===== GENERATE ===== */
function renderExtraInputs(container, idPrefix, values) {
  container.innerHTML = "";
  state.settings.extraFields.forEach((name,i) => {
    if (!(name||"").trim()) return;
    const d = document.createElement("div"); d.className = "field";
    d.innerHTML = `<label>${esc(name)}</label><input id="${idPrefix}-e${i}">`;
    container.appendChild(d);
    if (values && values[i] != null) $(idPrefix+"-e"+i).value = values[i];
  });
}
function renderGenerate() {
  const sel = $("gen-catalog");
  let o = `<option value="">— Ръчно въвеждане —</option>`;
  state.catalog.forEach(c => { const lbl = [c.articleNumber,c.model].filter(Boolean).join(" · ")+(c.price?(" — "+priceLabel(c.price)):""); o += `<option value="${c.id}">${esc(lbl)}</option>`; });
  sel.innerHTML = o;
  renderExtraInputs($("gen-extra"),"gen");
  applyGenMode();
}
$("gen-catalog").addEventListener("change", e => {
  const it = state.catalog.find(c => c.id === e.target.value);
  if (it) { $("gen-article").value=it.articleNumber||""; $("gen-model").value=it.model||""; $("gen-price").value=fmtPrice(it.price);
    state.settings.extraFields.forEach((n,i) => { const el = $("gen-e"+i); if (el) el.value = (it.extra&&it.extra[i])||""; }); }
});
let lastBatch = [], genMode = "manual";
function applyGenMode() { $("gen-catalog-wrap").style.display = genMode==="catalog" ? "block" : "none"; }
document.querySelectorAll("#gen-mode button").forEach(b => b.addEventListener("click", () => {
  genMode = b.dataset.gmode;
  document.querySelectorAll("#gen-mode button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); applyGenMode();
}));
$("gen-do").addEventListener("click", async () => {
  const article = $("gen-article").value.trim(), model = $("gen-model").value.trim(), price = $("gen-price").value.trim();
  const qty = Math.max(1, Math.min(2000, parseInt($("gen-qty").value)||0));
  if (!model&&!article) { toast("Въведете поне модел или артикулен номер"); return; }
  if (!qty) { toast("Въведете брой"); return; }
  const extra = state.settings.extraFields.map((n,i) => { if (!(n||"").trim()) return ""; const el = $("gen-e"+i); return el ? el.value.trim() : ""; });
  const s = state.settings, start = s.next, nums = [];
  for (let i = 0; i < qty; i++) nums.push(s.prefix + String(start+i).padStart(s.pad,"0"));
  const batchId = "B"+Date.now(), createdAt = new Date().toISOString(), batchName = article||model||"партида";
  const recs = nums.map(n => ({number:n,articleNumber:article,model,price:fmtPrice(price),extra,batchId,batchName,createdAt,status:"generated"}));
  $("gen-do").disabled = true;
  try {
    await db.insertLabels(recs);
    s.next = start+qty; await db.saveSettings(s);
    state.labels = [...recs, ...state.labels];
    lastBatch = recs;
    $("gen-result").style.display = "block";
    $("gen-result-info").textContent = `Създадени ${qty} етикета · ${batchName} · номера ${nums[0]}–${nums[nums.length-1]}.`;
    renderPreview(lastBatch.slice(0,24));
    await refreshCounts();
    toast("Записани "+qty+" етикета");
    db.sync();
  } catch(e) { toast("Грешка: "+((e&&e.message)||e)); }
  finally { $("gen-do").disabled = false; }
});
function renderPreview(list) {
  const w = $("gen-preview"); w.innerHTML = "";
  list.forEach(rec => {
    const card = document.createElement("div"); card.className = "lbl-card";
    card.appendChild(qrCanvas(rec.number,90));
    const m = document.createElement("div"); m.className = "m"; m.textContent = rec.model||rec.articleNumber||""; card.appendChild(m);
    const p = document.createElement("div"); p.className = "p"; p.textContent = priceLabel(rec.price); card.appendChild(p);
    const n = document.createElement("div"); n.className = "n"; n.textContent = "№ "+rec.number; card.appendChild(n);
    w.appendChild(card);
  });
  if (list.length < lastBatch.length) { const d = document.createElement("div"); d.className = "lbl-card"; d.style.cssText = "display:flex;align-items:center;justify-content:center;color:var(--muted)"; d.textContent = `+ още ${lastBatch.length-list.length}`; w.appendChild(d); }
}
$("gen-pdf").addEventListener("click", () => exportPDF(lastBatch));
$("gen-csv").addEventListener("click", () => exportCSV(lastBatch,"partida.csv"));

/* ===== SCAN ===== */
let scanner=null, scanning=false, scanMode="in", lastCode="", lastTime=0;
const pending = new Map();

function renderScanSummary() {
  $("scan-summary").innerHTML = [
    `<div class="summary-item"><b>${state.counts.in_stock}</b><span>В наличност</span></div>`,
    `<div class="summary-item"><b>${state.counts.sold}</b><span>Продадени</span></div>`,
    `<div class="summary-item"><b>${state.counts.generated}</b><span>Генерирани</span></div>`
  ].join("");
}
function renderLabelSummary() {
  $("lbl-summary").innerHTML = [
    `<div class="summary-item"><b>${state.counts.total}</b><span>Общо</span></div>`,
    `<div class="summary-item"><b>${state.counts.in_stock}</b><span>В наличност</span></div>`,
    `<div class="summary-item"><b>${state.counts.sold}</b><span>Продадени</span></div>`,
    `<div class="summary-item"><b>${state.counts.generated}</b><span>Генерирани</span></div>`
  ].join("");
}
document.querySelectorAll("#scan-mode button").forEach(b => b.addEventListener("click", () => {
  if (pending.size && !confirm("Смяната на режима ще изчисти текущия списък. Продължаваме?")) return;
  scanMode = b.dataset.mode;
  document.querySelectorAll("#scan-mode button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); pending.clear(); renderPending();
}));
function beep(ok) { try { const c=beep._c||(beep._c=new(window.AudioContext||window.webkitAudioContext)()); const o=c.createOscillator(),g=c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value=ok?880:240; g.gain.value=0.04; o.start(); o.stop(c.currentTime+0.12); }catch(e){} }
function flash(msg,kind) { const f=$("scan-flash"); f.className="flash "+kind; f.textContent=msg; }
function updateScanBtns() { $("scan-start").disabled=scanning; $("scan-stop").disabled=!scanning; const has=pending.size>0; $("scan-commit").disabled=!has; $("scan-clear").disabled=!has; }
function qrFormats() { return window.Html5QrcodeSupportedFormats ? [Html5QrcodeSupportedFormats.QR_CODE] : undefined; }
async function startScan() {
  if (scanning) return;
  if (!window.Html5Qrcode) { toast("Скенерът не е зареден (нужен интернет)"); return; }
  try {
    scanner = new Html5Qrcode("reader",{formatsToSupport:qrFormats(),verbose:false});
    await scanner.start({facingMode:"environment"},{fps:10,qrbox:{width:240,height:240}}, onDecode, ()=>{});
    scanning = true; updateScanBtns(); flash("Камерата е активна — насочете към QR кода.","info");
  } catch(e) { toast("Няма достъп до камера: "+((e&&e.message)||e)); scanner=null; scanning=false; updateScanBtns(); }
}
async function stopScan() { if (scanner) { try { await scanner.stop(); await scanner.clear(); } catch(e){} } scanner=null; scanning=false; updateScanBtns(); }
async function onDecode(text) { const now=Date.now(), code=String(text).trim(); if (code===lastCode&&now-lastTime<2500) return; lastCode=code; lastTime=now; await handleScanned(code); }
async function handleScanned(number) {
  if (pending.has(number)) { flash("Вече е в списъка: "+number,"info"); return; }
  const rec = await db.getLabelByNumber(number);
  if (!rec) { flash("Непознат код: "+number,"bad"); beep(false); return; }
  const target = scanMode==="in"?"in_stock":"sold";
  if (rec.status===target) { flash((scanMode==="in"?"Вече е в наличност: ":"Вече е изваден: ")+(rec.model||number),"info"); return; }
  pending.set(number,rec); renderPending(); beep(true);
  flash((scanMode==="in"?"+ за входиране: ":"+ за изваждане: ")+(rec.model||number)+(priceLabel(rec.price)?" — "+priceLabel(rec.price):""),"ok");
}
function renderPending() {
  const w = $("pend-list"); $("pend-count").textContent = pending.size;
  if (!pending.size) { w.innerHTML = `<div class="empty">Все още нищо сканирано.</div>`; updateScanBtns(); return; }
  let h = "";
  pending.forEach((r,num) => { h += `<div class="pendrow"><span class="mono">${esc(num)}</span><span>${esc(r.model||r.articleNumber||"")}</span><span class="mono">${esc(priceLabel(r.price))}</span><button class="x" data-num="${esc(num)}">×</button></div>`; });
  w.innerHTML = h;
  w.querySelectorAll(".x").forEach(b => b.addEventListener("click", () => { pending.delete(b.dataset.num); renderPending(); }));
  updateScanBtns();
  const commit = $("scan-commit"); commit.textContent = (scanMode==="in"?"Потвърди входиране (":"Потвърди изваждане (")+pending.size+")";
}
$("scan-start").addEventListener("click", startScan);
$("scan-stop").addEventListener("click", stopScan);
$("scan-clear").addEventListener("click", () => { pending.clear(); renderPending(); flash("Списъкът е изчистен","info"); });
$("scan-commit").addEventListener("click", async () => {
  if (!pending.size) return;
  const status = scanMode==="in"?"in_stock":"sold", nums = [...pending.keys()];
  $("scan-commit").disabled = true;
  try {
    const now = await db.setLabelsStatus(nums,status);
    const ns = new Set(nums);
    state.labels.forEach(l => { if (ns.has(l.number)) { l.status=status; if(status==="in_stock") l.stockedAt=now; else l.soldAt=now; } });
    toast((scanMode==="in"?"Входирани ":"Извадени ")+nums.length+" артикула");
    pending.clear(); renderPending();
    await refreshCounts(); db.sync();
  } catch(e) { toast("Грешка: "+((e&&e.message)||e)); }
  finally { updateScanBtns(); }
});

/* ===== CATALOG ===== */
function renderCatalog() {
  renderExtraInputs($("cat-extra"),"cat");
  const t = $("cat-table");
  if (!state.catalog.length) { t.innerHTML = `<tr><td class="empty">Все още няма артикули.</td></tr>`; return; }
  let head = `<tr><th>Артикулен №</th><th>Модел</th><th class="right">Цена</th>`;
  state.settings.extraFields.forEach(n => { if ((n||"").trim()) head += `<th>${esc(n)}</th>`; });
  head += `<th></th></tr>`;
  let rows = "";
  state.catalog.forEach(it => {
    rows += `<tr><td>${esc(it.articleNumber)}</td><td>${esc(it.model)}</td><td class="right mono">${esc(priceLabel(it.price))}</td>`;
    state.settings.extraFields.forEach((n,i) => { if ((n||"").trim()) rows += `<td>${esc((it.extra&&it.extra[i])||"")}</td>`; });
    rows += `<td class="right"><button class="btn sm danger cat-del" data-id="${it.id}">Изтрий</button></td></tr>`;
  });
  t.innerHTML = head+rows;
  t.querySelectorAll(".cat-del").forEach(b => b.addEventListener("click", async () => {
    try { await db.deleteCatalogItem(b.dataset.id); state.catalog=state.catalog.filter(c=>c.id!==b.dataset.id); renderCatalog(); renderGenerate(); toast("Изтрит артикул"); db.sync(); }
    catch(e) { toast("Грешка: "+((e&&e.message)||e)); }
  }));
}
$("cat-add").addEventListener("click", async () => {
  const article=$("cat-article").value.trim(), model=$("cat-model").value.trim(), price=$("cat-price").value.trim();
  if (!model&&!article) { toast("Въведете поне модел или артикулен номер"); return; }
  const extra = state.settings.extraFields.map((n,i) => { if (!(n||"").trim()) return ""; const el=$("cat-e"+i); return el?el.value.trim():""; });
  const item = {id:"C"+Date.now()+Math.floor(Math.random()*1000),articleNumber:article,model,price,extra};
  try {
    await db.addCatalogItem(item); state.catalog.push(item);
    $("cat-article").value=""; $("cat-model").value=""; $("cat-price").value="";
    state.settings.extraFields.forEach((n,i) => { const el=$("cat-e"+i); if(el) el.value=""; });
    renderCatalog(); renderGenerate(); toast("Добавен артикул"); db.sync();
  } catch(e) { toast("Грешка: "+((e&&e.message)||e)); }
});

/* ===== LABELS ===== */
function filteredLabels() {
  const q=$("lbl-search").value.trim().toLowerCase(), st=$("lbl-status").value;
  return state.labels.filter(l => {
    if (st && l.status!==st) return false;
    if (!q) return true;
    return (l.number+" "+(l.model||"")+" "+(l.articleNumber||"")).toLowerCase().includes(q);
  });
}
function renderLabels() {
  renderLabelSummary();
  const list = filteredLabels();
  $("lbl-count").textContent = list.length+" показани · "+state.counts.total+" общо";
  const t = $("lbl-table");
  if (!state.labels.length) { t.innerHTML=`<tr><td class="empty">Все още няма генерирани етикети.</td></tr>`; return; }
  if (!list.length) { t.innerHTML=`<tr><td class="empty">Няма съвпадения.</td></tr>`; return; }
  let head=`<tr><th style="width:28px"></th><th>Номер</th><th>Модел</th><th>Арт. №</th><th class="right">Цена</th>`;
  state.settings.extraFields.forEach(n => { if((n||"").trim()) head+=`<th>${esc(n)}</th>`; });
  head += `<th>Статус</th><th>Дата</th></tr>`;
  let rows="";
  const dShort = v => v ? new Date(v).toLocaleString("bg-BG",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"}) : "";
  const statusDate = l => l.status==="sold"?dShort(l.soldAt):l.status==="in_stock"?dShort(l.stockedAt):dShort(l.createdAt);
  list.slice(0,2000).forEach(l => {
    rows += `<tr><td><input type="checkbox" class="lbl-chk" data-num="${esc(l.number)}"></td><td class="mono">${esc(l.number)}</td><td>${esc(l.model)}</td><td>${esc(l.articleNumber)}</td><td class="right mono">${esc(priceLabel(l.price))}</td>`;
    state.settings.extraFields.forEach((n,i) => { if((n||"").trim()) rows+=`<td>${esc((l.extra&&l.extra[i])||"")}</td>`; });
    rows += `<td><span class="tag ${esc(l.status)}">${esc(statusText(l.status))}</span></td><td class="mono" style="white-space:nowrap">${esc(statusDate(l))}</td></tr>`;
  });
  t.innerHTML = head+rows;
}
function selNums() { return [...document.querySelectorAll(".lbl-chk:checked")].map(c=>c.dataset.num); }
function selRecs() { const s=new Set(selNums()); return state.labels.filter(l=>s.has(l.number)); }
$("lbl-search").addEventListener("input", renderLabels);
$("lbl-status").addEventListener("change", renderLabels);
$("lbl-all").addEventListener("click",  () => document.querySelectorAll(".lbl-chk").forEach(c=>c.checked=true));
$("lbl-none").addEventListener("click", () => document.querySelectorAll(".lbl-chk").forEach(c=>c.checked=false));
$("lbl-pdf").addEventListener("click",  () => { const r=selRecs(); if(!r.length){toast("Маркирайте поне един етикет");return;} exportPDF(r); });
$("lbl-csv").addEventListener("click",  () => { const r=selRecs(); exportCSV(r.length?r:filteredLabels(),"etiketi.csv"); });
$("lbl-del").addEventListener("click",  async () => {
  const nums=selNums(); if(!nums.length){toast("Маркирайте етикети");return;}
  if(!confirm("Изтриване на "+nums.length+" етикета? Това не може да се върне.")) return;
  try { await db.deleteLabels(nums); const s=new Set(nums); state.labels=state.labels.filter(l=>!s.has(l.number)); await refreshCounts(); renderLabels(); toast("Изтрити "+nums.length); db.sync(); }
  catch(e) { toast("Грешка: "+((e&&e.message)||e)); }
});

/* ===== STATS ===== */
let statsCache = null;
function money(n) { return (Math.round((n||0)*100)/100).toFixed(2)+" "+(state.settings.currency||"€"); }
function dayList(n) { const a=[],t=new Date(); t.setHours(0,0,0,0); for(let i=n-1;i>=0;i--) a.push(new Date(t.getTime()-i*86400000).toISOString().slice(0,10)); return a; }
function computeStats(labels, period) {
  const cutoff = Date.now()-period*86400000;
  let revenue=0,soldUnits=0,inStockUnits=0,inStockValue=0,soldAll=0,turnSum=0,turnCnt=0;
  const status={generated:0,in_stock:0,sold:0}, dayRev={}, soldModel={}, stockModel={};
  labels.forEach(l => {
    const price=parseFloat(String(l.price??"").replace(",","."))||0;
    if(status[l.status]==null)status[l.status]=0; status[l.status]++;
    if(l.status==="in_stock"){ inStockUnits++; inStockValue+=price; const m=l.model||l.articleNumber||"—"; const o=stockModel[m]||(stockModel[m]={u:0,v:0}); o.u++; o.v+=price; }
    if(l.status==="sold"){
      soldAll++;
      if(l.stockedAt&&l.soldAt){ const d=(new Date(l.soldAt)-new Date(l.stockedAt))/86400000; if(d>=0){turnSum+=d;turnCnt++;} }
      const t=l.soldAt?new Date(l.soldAt).getTime():(l.updatedAt?new Date(l.updatedAt).getTime():0);
      if(t>=cutoff){ soldUnits++; revenue+=price; const m=l.model||l.articleNumber||"—"; const o=soldModel[m]||(soldModel[m]={u:0,r:0}); o.u++; o.r+=price; const k=new Date(t).toISOString().slice(0,10); dayRev[k]=(dayRev[k]||0)+price; }
    }
  });
  return { revenue,soldUnits,inStockUnits,inStockValue,soldAll,
    sellThrough:(soldAll+inStockUnits)>0?soldAll/(soldAll+inStockUnits)*100:0,
    avgTurn:turnCnt?turnSum/turnCnt:null, avgPrice:soldUnits?revenue/soldUnits:0,
    status,dayRev,soldModel,stockModel,period };
}
async function loadStats() {
  $("stats-body").innerHTML = `<div class="empty">Зареждане…</div>`;
  try { statsCache = await db.getStatsLabels(); renderStats(); }
  catch(e) { $("stats-body").innerHTML=`<div class="empty">Грешка: ${esc((e&&e.message)||e)}</div>`; }
}
function renderStats() {
  if (!statsCache) return;
  if (!statsCache.length) { $("stats-body").innerHTML=`<div class="empty">Все още няма данни.</div>`; return; }
  const period=parseInt($("stats-period").value)||30;
  const s=computeStats(statsCache,period);
  const days=dayList(period), maxRev=Math.max(1,...days.map(d=>s.dayRev[d]||0));
  const dlab=d=>d.slice(8,10)+"."+d.slice(5,7);
  const bars=days.map(d=>{ const v=s.dayRev[d]||0; return `<div class="bar" style="height:${(v/maxRev*100).toFixed(1)}%"><span>${dlab(d)}: ${money(v)}</span></div>`; }).join("");
  const topSold=Object.entries(s.soldModel).sort((a,b)=>b[1].u-a[1].u).slice(0,8);
  const maxSold=Math.max(1,...topSold.map(e=>e[1].u));
  const soldBars=topSold.length?topSold.map(([m,o])=>`<div class="hbar"><div class="lab"><span class="nm">${esc(m)}</span><span class="vl">${o.u} бр · ${money(o.r)}</span></div><div class="track"><div class="fill" style="width:${(o.u/maxSold*100).toFixed(1)}%"></div></div></div>`).join(""):`<div class="empty">Няма продажби в периода.</div>`;
  const topStock=Object.entries(s.stockModel).sort((a,b)=>b[1].v-a[1].v).slice(0,8);
  const maxStockV=Math.max(1,...topStock.map(e=>e[1].v));
  const stockBars=topStock.length?topStock.map(([m,o])=>`<div class="hbar"><div class="lab"><span class="nm">${esc(m)}</span><span class="vl">${o.u} бр · ${money(o.v)}</span></div><div class="track"><div class="fill stock" style="width:${(o.v/maxStockV*100).toFixed(1)}%"></div></div></div>`).join(""):`<div class="empty">Няма артикули в наличност.</div>`;
  const tot=Math.max(1,(s.status.generated||0)+(s.status.in_stock||0)+(s.status.sold||0));
  const pct=n=>((n||0)/tot*100).toFixed(1);
  $("stats-body").innerHTML=`
    <div class="kpis">
      <div class="kpi"><div class="v">${money(s.revenue)}</div><div class="l">Приходи (период)</div><div class="s">${s.soldUnits} продажби</div></div>
      <div class="kpi"><div class="v">${money(s.avgPrice)}</div><div class="l">Средна цена/продажба</div></div>
      <div class="kpi"><div class="v">${money(s.inStockValue)}</div><div class="l">Стойност наличност</div><div class="s">${s.inStockUnits} бр</div></div>
      <div class="kpi"><div class="v">${s.sellThrough.toFixed(0)}%</div><div class="l">Реализация</div></div>
      <div class="kpi"><div class="v">${s.avgTurn==null?"—":s.avgTurn.toFixed(1)+" дни"}</div><div class="l">Среден престой</div></div>
      <div class="kpi"><div class="v">${s.soldAll}</div><div class="l">Общо продадени</div></div>
    </div>
    <div class="sec-title">Приходи по дни</div>
    <div class="bars">${bars}</div>
    <div class="axis"><span>${dlab(days[0])}</span><span>${dlab(days[days.length-1])}</span></div>
    <div class="sec-title">Топ продавани (период)</div><div class="hbars">${soldBars}</div>
    <div class="sec-title">Наличност по стойност</div><div class="hbars">${stockBars}</div>
    <div class="sec-title">Разпределение</div>
    <div class="stacked"><div class="g" style="width:${pct(s.status.generated)}%"></div><div class="i" style="width:${pct(s.status.in_stock)}%"></div><div class="so" style="width:${pct(s.status.sold)}%"></div></div>
    <div class="legend"><span><i style="background:var(--bg2)"></i>Генерирани ${s.status.generated||0}</span><span><i style="background:var(--in)"></i>В наличност ${s.status.in_stock||0}</span><span><i style="background:var(--out)"></i>Продадени ${s.status.sold||0}</span></div>`;
}
$("stats-period").addEventListener("change", renderStats);

/* ===== SETTINGS ===== */
function renderSettingsForm() {
  const cfg=loadCfg(); if(cfg){ $("db-url").value=cfg.url||""; $("db-key").value=cfg.key||""; }
  const s=state.settings;
  $("set-f1").value=s.extraFields[0]||""; $("set-f2").value=s.extraFields[1]||""; $("set-f3").value=s.extraFields[2]||"";
  $("set-prefix").value=s.prefix||""; $("set-pad").value=s.pad; $("set-next").value=s.next;
  $("set-curr").value=s.currency; $("set-perrow").value=s.perRow;
}
function showSqlBox() { const box=$("db-sql-box"); box.style.display="block"; box.innerHTML=`<p class="hint">Копирайте и изпълнете в Supabase → SQL Editor:</p><pre>${esc(SQL_SETUP)}</pre>`; }
$("db-sql").addEventListener("click", showSqlBox);
$("db-connect").addEventListener("click", async () => {
  const url=$("db-url").value.trim(), key=$("db-key").value.trim();
  if(!url||!key){ toast("Въведете URL и ключ"); return; }
  $("db-connect").disabled=true;
  await connectDB(url,key,false);
  $("db-connect").disabled=false;
});
$("set-save").addEventListener("click", async () => {
  const s=state.settings;
  s.extraFields=[$("set-f1").value,$("set-f2").value,$("set-f3").value];
  s.prefix=$("set-prefix").value.trim();
  s.pad=Math.max(3,Math.min(10,parseInt($("set-pad").value)||6));
  s.next=Math.max(1,parseInt($("set-next").value)||1);
  s.currency=$("set-curr").value.trim()||"€";
  s.perRow=Math.max(2,Math.min(8,parseInt($("set-perrow").value)||4));
  try { await db.saveSettings(s); renderGenerate(); toast("Настройките са запазени"); db.sync(); }
  catch(e) { toast("Грешка: "+((e&&e.message)||e)); }
});
$("set-export").addEventListener("click", async () => {
  const data={settings:state.settings,catalog:state.catalog,labels:state.labels,exportedAt:new Date().toISOString()};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}), a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download="rezervno-kopie-"+new Date().toISOString().slice(0,10)+".json"; a.click(); URL.revokeObjectURL(a.href);
});

/* ===== SW registration ===== */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

/* ===== init ===== */
(async function init() {
  await db.init();
  renderBanner(); renderPending(); renderScanSummary();

  const cfg = loadCfg();
  if (cfg && cfg.url && cfg.key) {
    // Load from IDB immediately (instant), then try Supabase in background
    await loadFromIDBOnly();
    connectDB(cfg.url, cfg.key, true).then(() => {
      // Refresh UI after server sync
      state.labels  && renderLabels && null; // labels tab re-renders on tab click
    });
  } else {
    renderGenerate();
    renderSettingsForm();
  }
  // Periodic sync every 30s when online
  setInterval(() => db.sync(), 30000);
})();
