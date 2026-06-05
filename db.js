"use strict";
/* ===== IndexedDB + Supabase offline-first layer ===== *
 * All writes go to IDB immediately.
 * If Supabase is connected, also write there.
 * If Supabase is offline, queue the operation.
 * Call db.sync() to drain the queue (called on reconnect and periodically).
 */

const DB_NAME = "linenapp_idb";
const DB_VER  = 2;

const db = (() => {
  let _idb = null;
  let _sb  = null;
  let _syncing = false;
  let _online = navigator.onLine;
  const _listeners = [];

  /* ---------- IDB bootstrap ---------- */
  function openIDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains("settings"))  d.createObjectStore("settings",  { keyPath: "id" });
        if (!d.objectStoreNames.contains("catalog"))   d.createObjectStore("catalog",   { keyPath: "id" });
        if (!d.objectStoreNames.contains("labels"))    d.createObjectStore("labels",    { keyPath: "number" });
        if (!d.objectStoreNames.contains("syncQueue")) d.createObjectStore("syncQueue", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  function tx(store, mode = "readonly") {
    return _idb.transaction(store, mode).objectStore(store);
  }

  function idbGetAll(store) {
    return new Promise((res, rej) => {
      const r = tx(store).getAll();
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  function idbGet(store, key) {
    return new Promise((res, rej) => {
      const r = tx(store).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror   = () => rej(r.error);
    });
  }

  function idbPut(store, val) {
    return new Promise((res, rej) => {
      const r = tx(store, "readwrite").put(val);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  }

  function idbPutMany(store, vals) {
    return new Promise((res, rej) => {
      const t = _idb.transaction(store, "readwrite");
      const s = t.objectStore(store);
      vals.forEach(v => s.put(v));
      t.oncomplete = () => res();
      t.onerror    = () => rej(t.error);
    });
  }

  function idbDelete(store, key) {
    return new Promise((res, rej) => {
      const r = tx(store, "readwrite").delete(key);
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  }

  function idbDeleteMany(store, keys) {
    return new Promise((res, rej) => {
      const t = _idb.transaction(store, "readwrite");
      const s = t.objectStore(store);
      keys.forEach(k => s.delete(k));
      t.oncomplete = () => res();
      t.onerror    = () => rej(t.error);
    });
  }

  function idbClear(store) {
    return new Promise((res, rej) => {
      const r = tx(store, "readwrite").clear();
      r.onsuccess = () => res();
      r.onerror   = () => rej(r.error);
    });
  }

  /* ---------- sync queue ---------- */
  async function enqueue(op) {
    await idbPut("syncQueue", { ...op, ts: Date.now() });
  }

  async function dequeue(id) {
    await idbDelete("syncQueue", id);
  }

  /* ---------- Supabase helpers ---------- */
  function sbReady() { return !!_sb && _online; }

  function rowToLabel(r) {
    return {
      number: r.number, articleNumber: r.article_number,
      model: r.model, price: r.price, extra: r.extra || [],
      batchId: r.batch_id, batchName: r.batch_name,
      status: r.status, createdAt: r.created_at,
      stockedAt: r.stocked_at, soldAt: r.sold_at
    };
  }
  function labelToRow(l) {
    return {
      number: l.number, article_number: l.articleNumber,
      model: l.model, price: l.price, extra: l.extra || [],
      batch_id: l.batchId, batch_name: l.batchName,
      status: l.status, created_at: l.createdAt
    };
  }
  function rowToCat(r) {
    return { id: r.id, articleNumber: r.article_number, model: r.model, price: r.price, extra: r.extra || [] };
  }

  /* ---------- status events ---------- */
  function emit(status, pendingCount) {
    _listeners.forEach(fn => fn(status, pendingCount));
  }

  /* ========== PUBLIC API ========== */
  const api = {

    /* ----- lifecycle ----- */
    async init() {
      _idb = await openIDB();
      window.addEventListener("online",  () => { _online = true;  api.sync(); });
      window.addEventListener("offline", () => { _online = false; emit("offline", 0); });
    },

    onStatus(fn) { _listeners.push(fn); },

    isOnline() { return _online && !!_sb; },

    /* ----- connect ----- */
    async connect(url, key) {
      if (!window.supabase) throw new Error("Supabase не е зареден");
      _sb = window.supabase.createClient(url, key);
      // Test connection
      const { error } = await _sb.from("settings").select("id").limit(1);
      if (error) { _sb = null; throw error; }
      // Pull everything from server
      await api.pullFromServer();
      emit("ok", 0);
    },

    async pullFromServer() {
      if (!_sb) return;
      const [sRes, cRes, lRes] = await Promise.all([
        _sb.from("settings").select("*"),
        _sb.from("catalog").select("*").order("created_at", { ascending: true }),
        _sb.from("labels").select("*").order("created_at", { ascending: false })
      ]);
      if (sRes.data) await idbPutMany("settings", sRes.data);
      if (cRes.data) { await idbClear("catalog"); await idbPutMany("catalog", cRes.data.map(r => ({ id: r.id, article_number: r.article_number, model: r.model, price: r.price, extra: r.extra || [], created_at: r.created_at }))); }
      if (lRes.data) { await idbClear("labels"); await idbPutMany("labels", lRes.data); }
    },

    /* ----- sync queue ----- */
    async sync() {
      if (_syncing || !sbReady()) return;
      _syncing = true;
      const queue = await idbGetAll("syncQueue");
      let failed = 0;
      for (const op of queue) {
        try {
          if (op.op === "upsert-settings") {
            const { error } = await _sb.from("settings").upsert({ id: "main", data: op.data });
            if (error) throw error;
          } else if (op.op === "upsert-catalog") {
            const { error } = await _sb.from("catalog").upsert(op.data);
            if (error) throw error;
          } else if (op.op === "delete-catalog") {
            const { error } = await _sb.from("catalog").delete().eq("id", op.id);
            if (error) throw error;
          } else if (op.op === "insert-labels") {
            const { error } = await _sb.from("labels").insert(op.data);
            if (error && !/duplicate|unique/i.test(error.message)) throw error;
          } else if (op.op === "update-labels") {
            const { error } = await _sb.from("labels").update(op.patch).in("number", op.nums);
            if (error) throw error;
          } else if (op.op === "delete-labels") {
            const { error } = await _sb.from("labels").delete().in("number", op.nums);
            if (error) throw error;
          }
          await dequeue(op.id);
        } catch (e) {
          failed++;
        }
      }
      _syncing = false;
      const remaining = await idbGetAll("syncQueue");
      emit(remaining.length ? "pending" : "ok", remaining.length);
    },

    /* ----- settings ----- */
    async getSettings() {
      const row = await idbGet("settings", "main");
      return row ? row.data : null;
    },

    async saveSettings(obj) {
      await idbPut("settings", { id: "main", data: obj });
      if (sbReady()) {
        const { error } = await _sb.from("settings").upsert({ id: "main", data: obj });
        if (error) await enqueue({ op: "upsert-settings", data: obj });
      } else {
        await enqueue({ op: "upsert-settings", data: obj });
        emit("pending");
      }
    },

    /* ----- catalog ----- */
    async getCatalog() {
      const rows = await idbGetAll("catalog");
      return rows.map(r => ({ id: r.id, articleNumber: r.article_number, model: r.model, price: r.price, extra: r.extra || [] }));
    },

    async addCatalogItem(item) {
      const row = { id: item.id, article_number: item.articleNumber, model: item.model, price: item.price, extra: item.extra || [], created_at: new Date().toISOString() };
      await idbPut("catalog", row);
      if (sbReady()) {
        const { error } = await _sb.from("catalog").insert(row);
        if (error) await enqueue({ op: "upsert-catalog", data: row });
      } else {
        await enqueue({ op: "upsert-catalog", data: row });
        emit("pending");
      }
    },

    async deleteCatalogItem(id) {
      await idbDelete("catalog", id);
      if (sbReady()) {
        const { error } = await _sb.from("catalog").delete().eq("id", id);
        if (error) await enqueue({ op: "delete-catalog", id });
      } else {
        await enqueue({ op: "delete-catalog", id });
        emit("pending");
      }
    },

    /* ----- labels ----- */
    async getLabels() {
      const rows = await idbGetAll("labels");
      rows.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      return rows.map(rowToLabel);
    },

    async getLabelByNumber(num) {
      const row = await idbGet("labels", num);
      return row ? rowToLabel(row) : null;
    },

    async insertLabels(list) {
      const rows = list.map(labelToRow);
      await idbPutMany("labels", rows);
      if (sbReady()) {
        const { error } = await _sb.from("labels").insert(rows);
        if (error) await enqueue({ op: "insert-labels", data: rows });
      } else {
        await enqueue({ op: "insert-labels", data: rows });
        emit("pending");
      }
    },

    async setLabelsStatus(nums, status) {
      const now = new Date().toISOString();
      const patch = { status, updated_at: now };
      if (status === "in_stock") patch.stocked_at = now;
      if (status === "sold")     patch.sold_at    = now;
      // Update IDB
      for (const num of nums) {
        const row = await idbGet("labels", num);
        if (row) await idbPut("labels", { ...row, ...patch });
      }
      if (sbReady()) {
        const { error } = await _sb.from("labels").update(patch).in("number", nums);
        if (error) await enqueue({ op: "update-labels", nums, patch });
      } else {
        await enqueue({ op: "update-labels", nums, patch });
        emit("pending");
      }
      return now;
    },

    async deleteLabels(nums) {
      await idbDeleteMany("labels", nums);
      if (sbReady()) {
        const { error } = await _sb.from("labels").delete().in("number", nums);
        if (error) await enqueue({ op: "delete-labels", nums });
      } else {
        await enqueue({ op: "delete-labels", nums });
        emit("pending");
      }
    },

    async getCounts() {
      const all = await idbGetAll("labels");
      const c = { total: all.length, in_stock: 0, sold: 0, generated: 0 };
      all.forEach(l => { if (c[l.status] != null) c[l.status]++; });
      return c;
    },

    async getStatsLabels() {
      const rows = await idbGetAll("labels");
      return rows.map(r => ({
        model: r.model, articleNumber: r.article_number,
        price: r.price, status: r.status,
        createdAt: r.created_at, stockedAt: r.stocked_at,
        soldAt: r.sold_at, updatedAt: r.updated_at
      }));
    },

    getPendingCount() {
      return new Promise((res, rej) => {
        const r = tx("syncQueue").count();
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
      });
    }
  };

  return api;
})();
