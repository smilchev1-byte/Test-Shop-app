"use strict";
const $ = id => document.getElementById(id);
const CFG_KEY = "linenapp_cfg";

let counts = { in_stock: 0, sold: 0 };
let mode = "in";
let scanner = null, scanning = false;
let lastCode = "", lastTime = 0;
const pending = new Map();

/* ===== helpers ===== */
function toast(m) { const s=$("status"); s.textContent=m; s.classList.add("show"); clearTimeout(toast._t); toast._t=setTimeout(()=>s.classList.remove("show"),2600); }
function esc(s) { return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function fmtPrice(v) { const n=parseFloat(String(v??"").replace(",",".")); return isFinite(n)?n.toFixed(2):String(v??""); }
function priceLabel(v,currency) { const p=fmtPrice(v); return p?(p+" "+(currency||"€")):""; }
function loadCfg() { try{ return JSON.parse(localStorage.getItem(CFG_KEY)||"null"); }catch(e){ return null; } }
function saveCfg(url,key) { localStorage.setItem(CFG_KEY,JSON.stringify({url,key})); }

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

/* ===== counts ===== */
function renderCounts() {
  $("counts").innerHTML = `
    <div>В наличност<b>${counts.in_stock}</b></div>
    <div>Продадени<b>${counts.sold}</b></div>`;
}
async function refreshCounts() {
  try {
    const c = await db.getCounts();
    counts.in_stock = c.in_stock;
    counts.sold = c.sold;
    renderCounts();
  } catch(e) {}
}

/* ===== connect ===== */
async function connect(url, key, silent) {
  try {
    await db.connect(url, key);
    saveCfg(url, key);
    await refreshCounts();
    showScanUI();
    if (!silent) toast("Свързано");
    return true;
  } catch(e) {
    const msg = (e&&e.message)||String(e);
    if (/relation|does not exist|schema cache|table/i.test(msg)) {
      toast("Липсват таблици — настройте ги в основното приложение");
    } else if (!silent) {
      toast("Грешка: " + msg);
    }
    showConnect();
    return false;
  }
}

function showConnect() {
  const c = loadCfg();
  if (c) { $("db-url").value=c.url||""; $("db-key").value=c.key||""; }
  $("connect-panel").classList.remove("hide");
  $("scan-ui").classList.add("hide");
  $("bar-bottom").classList.add("hide");
}

function showScanUI() {
  $("connect-panel").classList.add("hide");
  $("scan-ui").classList.remove("hide");
  $("bar-bottom").classList.remove("hide");
}

/* ===== gear / connect panel toggle ===== */
$("theme-btn").addEventListener("click", () => {}); // already bound above
document.addEventListener("keydown", e => { if (e.key==="Escape") $("connect-panel").classList.add("hide"); });

$("db-connect").addEventListener("click", async () => {
  const u=$("db-url").value.trim(), k=$("db-key").value.trim();
  if (!u||!k) { toast("Въведете URL и ключ"); return; }
  $("db-connect").disabled=true;
  await connect(u,k,false);
  $("db-connect").disabled=false;
});

/* ===== mode ===== */
function applyModeColor() {
  const inMode = mode==="in";
  $("start").className  = "btn btn-full " + (inMode?"in":"out");
  $("commit").className = "btn " + (inMode?"in":"out");
}
document.querySelectorAll("#mode button").forEach(b => b.addEventListener("click", () => {
  if (pending.size && !confirm("Смяната на режима ще изчисти списъка. Продължаваме?")) return;
  mode = b.dataset.mode;
  document.querySelectorAll("#mode button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  pending.clear(); renderList(); applyModeColor();
}));

/* ===== feedback ===== */
function beep(ok) { try{ const c=beep._c||(beep._c=new(window.AudioContext||window.webkitAudioContext)()); const o=c.createOscillator(),g=c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value=ok?880:240; g.gain.value=0.05; o.start(); o.stop(c.currentTime+0.12);}catch(e){} }
function buzz(ok) { if(navigator.vibrate) navigator.vibrate(ok?60:[40,40,40]); }
function flash(msg, kind) { const f=$("flash"); f.className="flash "+kind; f.textContent=msg; }

/* ===== scanner ===== */
function qrFormats() { return window.Html5QrcodeSupportedFormats ? [Html5QrcodeSupportedFormats.QR_CODE] : undefined; }

async function startScan() {
  if (scanning) return;
  if (!window.Html5Qrcode) { toast("Скенерът не е зареден (нужен интернет)"); return; }
  try {
    scanner = new Html5Qrcode("reader",{formatsToSupport:qrFormats(),verbose:false});
    await scanner.start(
      {facingMode:"environment"},
      {fps:10, qrbox:(vw,vh) => { const m=Math.floor(Math.min(vw,vh)*0.7); return {width:m,height:m}; }},
      onDecode, ()=>{}
    );
    scanning=true; updateBtns(); flash("Насочете към QR кода.","info");
  } catch(e) { toast("Няма достъп до камера: "+((e&&e.message)||e)); scanner=null; scanning=false; updateBtns(); }
}

async function stopScan() {
  if (scanner) { try{ await scanner.stop(); await scanner.clear(); }catch(e){} }
  scanner=null; scanning=false; updateBtns();
}

async function onDecode(text) {
  const now=Date.now(), code=String(text).trim();
  if (code===lastCode && now-lastTime<2500) return;
  lastCode=code; lastTime=now;
  await handle(code);
}

async function handle(number) {
  if (pending.has(number)) { flash("Вече е в списъка","info"); return; }
  let rec;
  try { rec = await db.getLabelByNumber(number); }
  catch(e) { flash("Грешка при заявка","bad"); return; }
  if (!rec) { flash("Непознат код: "+number,"bad"); beep(false); buzz(false); return; }
  const target = mode==="in"?"in_stock":"sold";
  if (rec.status===target) {
    flash((mode==="in"?"Вече е в наличност":"Вече е продадено")+": "+(rec.model||number),"info");
    return;
  }
  pending.set(number,rec); renderList(); beep(true); buzz(true);
  const price = priceLabel(rec.price, rec._currency);
  flash((mode==="in"?"+ за входиране: ":"+ за изваждане: ")+(rec.model||number)+(price?" — "+price:""),"ok");
}

function renderList() {
  $("cnt").textContent = pending.size;
  const w = $("list");
  if (!pending.size) { w.innerHTML=`<div class="empty">Все още нищо сканирано.</div>`; updateBtns(); return; }
  let h="";
  pending.forEach((r,num) => {
    h += `<div class="pendrow">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1;min-width:0">
          <div class="m">${esc(r.model||r.articleNumber||"артикул")}</div>
          <div class="meta">№ ${esc(num)}${r.price?" · "+esc(fmtPrice(r.price))+" €":""}</div>
        </div>
        <button class="x" data-num="${esc(num)}">×</button>
      </div>
    </div>`;
  });
  w.innerHTML = h;
  w.querySelectorAll(".x").forEach(b => b.addEventListener("click", () => { pending.delete(b.dataset.num); renderList(); }));
  updateBtns();
}

function updateBtns() {
  $("start").disabled  = scanning;
  $("stop").disabled   = !scanning;
  const has = pending.size > 0;
  $("commit").disabled = !has;
  $("clear").disabled  = !has;
  $("commit").textContent = (mode==="in"?"Входирай (":"Извади (") + pending.size + ")";
}

$("start").addEventListener("click", startScan);
$("stop").addEventListener("click",  stopScan);
$("clear").addEventListener("click", () => { pending.clear(); renderList(); flash("Списъкът е изчистен","info"); });

$("commit").addEventListener("click", async () => {
  if (!pending.size) return;
  const status = mode==="in"?"in_stock":"sold", nums=[...pending.keys()];
  $("commit").disabled = true;
  try {
    await db.setLabelsStatus(nums,status);
    toast((mode==="in"?"Входирани ":"Извадени ")+nums.length+" артикула");
    pending.clear(); renderList();
    await refreshCounts(); db.sync();
  } catch(e) { toast("Грешка при запис: "+((e&&e.message)||e)); }
  finally { updateBtns(); }
});

/* ===== SW ===== */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(()=>{});
}

/* ===== init ===== */
(async function init() {
  await db.init();
  renderCounts(); renderList(); applyModeColor();

  const c = loadCfg();
  if (c && c.url && c.key) {
    // Show scan UI immediately with cached data
    showScanUI();
    await refreshCounts();
    // Connect to Supabase in background
    connect(c.url, c.key, true);
  } else {
    showConnect();
  }

  // Periodic sync
  setInterval(() => db.sync(), 30000);
})();
