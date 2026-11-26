/* دفتر البنزين: طبقة التشغيل المستقل (خارج Claude).
   توفّر نفس الواجهات التي يستخدمها البرنامج داخل Claude:
   db (تخزين على الجهاز)، assets (صور الفواتير على الجهاز)، sample (قراءة الصور عبر Claude API بمفتاح المستخدم). */
(function(){
"use strict";
if (window.claude) return;

var DBKEY = "fuelapp-db-v1", APIKEY = "fuelapp-key", MODELKEY = "fuelapp-model", DEF_MODEL = "claude-sonnet-5-5";
window.__savedLabel = "محفوظ على هذا الجهاز";
var VERSION = "74";
/* وضع التطبيق: fuel = دفتر البنزين (السيارة فقط)، budget = دفتر المصروف (مصروف البيت). يحدّده البناء. */
var APP_MODE = "budget";
/* خادم النسخ الاحتياطي واحد للتطبيقين حتى تبقى البيانات نفسها */
var SYNC_URL = APP_MODE === "budget" ? "../fuel/sync.php" : "sync.php";
(function(){
  var h = document.querySelector("h1");
  if (!h) return;
  var v = document.createElement("span");
  v.id = "app-version"; v.textContent = " نسخة " + VERSION;
  v.style.cssText = "font-size:.8rem;font-weight:500;color:var(--muted);white-space:nowrap";
  h.appendChild(v);
})();

/* ---------- المستندات: localStorage ---------- */
var store = {};
try { store = JSON.parse(localStorage.getItem(DBKEY) || "{}") || {}; } catch(e){ store = {}; }
var listeners = [];
function clone(o){ return JSON.parse(JSON.stringify(o)); }
/* طوابع زمنية لكل سجل وعلامات الحذف: أساس المزامنة بين الأجهزة */
var METAKEY = "fuelapp-sync-meta", SYNCKEY = "fuelapp-sync-key", meta = {t:{}, d:{}};
try { var m0 = JSON.parse(localStorage.getItem(METAKEY) || "{}") || {}; meta = {t:m0.t || {}, d:m0.d || {}}; } catch(e){}
var onDirty = null;
function touch(path){ meta.t[path] = Date.now(); delete meta.d[path]; if (onDirty) onDirty(); }
function tomb(path){ delete meta.t[path]; meta.d[path] = Date.now(); if (onDirty) onDirty(); }
function persist(){
  try { localStorage.setItem(METAKEY, JSON.stringify(meta)); } catch(e){}
  try { localStorage.setItem(DBKEY, JSON.stringify(store)); }
  catch(e){ throw {code:"quota_exceeded", message:"storage full"}; }
}
function notify(){ listeners.slice().forEach(function(fn){ try { fn(); } catch(e){} }); }
function newId(){
  var s = "", c = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (var i = 0; i < 20; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
var META = {fromCache:false, hasPendingWrites:false};
function docSnap(path){
  var d = store[path];
  return {id:path.split("/").pop(), exists:d !== undefined, data:function(){ return d === undefined ? undefined : clone(d); }, metadata:META};
}
function colSnap(col){
  var pre = col + "/";
  var docs = Object.keys(store).filter(function(p){ return p.indexOf(pre) === 0 && p.slice(pre.length).indexOf("/") < 0; }).sort().map(docSnap);
  return {docs:docs, size:docs.length, empty:!docs.length, docChanges:function(){ return []; }, metadata:META};
}
function subscribe(make, next){
  var fn = function(){ next(make()); };
  listeners.push(fn); setTimeout(fn, 0);
  return function(){ listeners = listeners.filter(function(x){ return x !== fn; }); };
}
function write(fn){
  return new Promise(function(resolve, reject){
    try { fn(); persist(); } catch(e){ reject(e && e.code ? e : {code:"unavailable", message:String(e)}); return; }
    notify(); resolve();
  });
}
function docRef(path){
  return {
    id:path.split("/").pop(), path:path,
    get:function(){ return Promise.resolve(docSnap(path)); },
    set:function(d){ return write(function(){ store[path] = clone(d); touch(path); }); },
    update:function(d){
      return write(function(){
        if (store[path] === undefined) throw {code:"invalid_argument", message:"missing document"};
        Object.assign(store[path], clone(d)); touch(path);
      });
    },
    delete:function(){ return write(function(){ if (store[path] !== undefined) tomb(path); delete store[path]; }); },
    onSnapshot:function(next){ return subscribe(function(){ return docSnap(path); }, next); },
    collection:function(p){ return colRef(path + "/" + p); }
  };
}
function colRef(col){
  return {
    path:col,
    doc:function(id){ return docRef(col + "/" + (id || newId())); },
    add:function(d){ var r = docRef(col + "/" + newId()); return r.set(d).then(function(){ return r; }); },
    get:function(){ return Promise.resolve(colSnap(col)); },
    onSnapshot:function(next){ return subscribe(function(){ return colSnap(col); }, next); }
  };
}
var db = {doc:docRef, collection:colRef};

/* ---------- صور الفواتير: IndexedDB ---------- */
var idbP = null;
function idb(){
  if (!idbP) idbP = new Promise(function(resolve, reject){
    var rq = indexedDB.open("fuelapp-blobs", 1);
    rq.onupgradeneeded = function(){ rq.result.createObjectStore("b"); };
    rq.onsuccess = function(){ resolve(rq.result); };
    rq.onerror = function(){ reject({code:"store_unavailable", message:"indexedDB"}); };
  });
  return idbP;
}
function tx(mode, fn){
  return idb().then(function(d){
    return new Promise(function(resolve, reject){
      var t = d.transaction("b", mode), rq = fn(t.objectStore("b"));
      t.oncomplete = function(){ resolve(rq && rq.result); };
      t.onerror = t.onabort = function(){ reject({code:"quota_or_state", message:"blob store"}); };
    });
  });
}
var urls = {};
var assets = {
  upload:function(blob){
    var id = newId() + newId().slice(0, 12);
    return tx("readwrite", function(s){ return s.put(blob, id); }).then(function(){
      return {id:id, url:(urls[id] = URL.createObjectURL(blob)), sizeBytes:blob.size, contentType:blob.type};
    });
  },
  delete:function(id){ return tx("readwrite", function(s){ return s.delete(id); }).then(function(){ return {deleted:true}; }); },
  list:function(){ return Promise.resolve({assets:[], usage:{files:0, bytes:0, maxFiles:0, maxBytes:0}}); }
};
window.__blobUrl = function(id){
  if (urls[id]) return Promise.resolve(urls[id]);
  return tx("readonly", function(s){ return s.get(id); }).then(function(b){
    if (!b) throw {code:"not_found"};
    return (urls[id] = URL.createObjectURL(b));
  });
};

/* ---------- قراءة الصور: Claude API بمفتاح المستخدم ---------- */
function toJpegB64(blob){
  return createImageBitmap(blob).then(function(bmp){
    var sc = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    var c = document.createElement("canvas");
    c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85).split(",")[1];
  }, function(){ throw {code:"image_rejected", message:"cannot decode image"}; });
}
function parseJson(text){
  var t = String(text || "").trim(), m;
  try { return JSON.parse(t); } catch(e){}
  m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m){ try { return JSON.parse(m[1]); } catch(e){} }
  var a = t.search(/[{\[]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && b > a){ try { return JSON.parse(t.slice(a, b + 1)); } catch(e){} }
  throw {code:"invalid_json", message:"no JSON in reply", text:t};
}
async function ask(input, opts){
  var key = "";
  try { key = localStorage.getItem(APIKEY) || ""; } catch(e){}
  if (!key) throw {code:"no_key", message:"no API key"};
  var model = DEF_MODEL;
  try { model = localStorage.getItem(MODELKEY) || DEF_MODEL; } catch(e){}
  var imgs = opts && opts.images ? [].slice.call(opts.images.length === undefined ? [opts.images] : opts.images) : [];
  var content = [];
  for (var i = 0; i < imgs.length; i++){
    content.push({type:"image", source:{type:"base64", media_type:"image/jpeg", data:await toJpegB64(imgs[i])}});
  }
  content.push({type:"text", text:String(input)});
  var res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"content-type":"application/json", "x-api-key":key, "anthropic-version":"2023-06-01", "anthropic-dangerous-direct-browser-access":"true"},
      body:JSON.stringify({model:model, max_tokens:1024, messages:[{role:"user", content:content}]})
    });
  } catch(e){ throw {code:"upstream_error", message:"network"}; }
  if (!res.ok){
    var code = res.status === 401 || res.status === 403 ? "bad_key" : res.status === 429 ? "rate_limited" : "upstream_error";
    throw {code:code, message:"HTTP " + res.status};
  }
  var j = await res.json();
  var text = (j.content || []).filter(function(c){ return c.type === "text"; }).map(function(c){ return c.text; }).join("");
  if (!text.trim()) throw {code:"empty_completion", message:"empty"};
  return text;
}
function sample(input, opts){ return ask(input, opts).then(function(t){ return {text:t, truncated:false, modelTierApplied:"default"}; }); }
/* ---------- قراءة الصور عبر Gemini بمفتاح المستخدم المجاني ---------- */
var GKEY = "fuelapp-gemini-key", GMODEL = "fuelapp-gemini-model", DEF_GMODEL = "gemini-3.8-flash";
function lsGet(k){ try { return localStorage.getItem(k) || ""; } catch(e){ return ""; } }
function toast(msg){
  var host = document.querySelector("dialog[open]") || document.body, t = document.createElement("div");
  t.setAttribute("role", "status"); t.textContent = msg;
  t.style.cssText = "position:sticky;bottom:8px;margin:10px 0 0;padding:10px 12px;border-radius:10px;background:var(--warn-soft);color:var(--warn);font-size:.9rem;font-weight:500;z-index:5;overflow-wrap:anywhere";
  host.appendChild(t);
  setTimeout(function(){ t.remove(); }, 30000);
}
async function jpegB64(blob, max){
  var bmp;
  try { bmp = await createImageBitmap(blob); } catch(e){ throw {code:"image_rejected", message:"cannot decode image"}; }
  var sc = Math.min(1, max / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
  c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9).split(",")[1];
}
/* موديلات مجانية بديلة تُجرَّب بالترتيب إذا كان الموديل المختار مزدحماً أو تجاوز حدّه */
var GEM_FALLBACK = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-flash-lite"], GOK = "fuelapp-gemini-ok";
async function geminiOnce(model, key, parts){
  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  async function post(withConfig){
    var body = {contents:[{parts:parts}]};
    if (withConfig) body.generationConfig = {temperature:0, responseMimeType:"application/json"};
    var ctl = new AbortController(), timer = setTimeout(function(){ ctl.abort(); }, 45000);
    try { return await fetch(url, {method:"POST", headers:{"content-type":"application/json", "x-goog-api-key":key}, body:JSON.stringify(body), signal:ctl.signal}); }
    catch(e){ throw {code:"upstream_error", next:true, message:(e && e.name === "AbortError") ? "timeout" : String(e && e.message || e).slice(0, 120)}; }
    finally { clearTimeout(timer); }
  }
  async function detail(r){
    var t = ""; try { t = await r.text(); } catch(e){}
    var msg = ""; try { msg = JSON.parse(t).error.message || ""; } catch(e){ msg = t; }
    return {raw:t, msg:"HTTP " + r.status + (msg ? ": " + String(msg).slice(0, 160) : "")};
  }
  var res = await post(true), d;
  if (!res.ok){
    d = await detail(res);
    if (/free tier is not available|FAILED_PRECONDITION/i.test(d.raw)) throw {code:"gemini_region", message:d.msg};
    if (/api key|API_KEY|UNAUTHENTICATED/i.test(d.raw) || res.status === 401) throw {code:"bad_gemini_key", message:d.msg};
    if (res.status === 403) throw {code:"bad_gemini_key", message:d.msg};
    if (res.status === 429) throw {code:"rate_limited", next:true, message:d.msg};
    if (res.status === 404) throw {code:"bad_gemini_model", next:true, message:d.msg};
    if (res.status === 400){ res = await post(false); if (!res.ok){ d = await detail(res); throw {code:"gemini_http", next:true, message:d.msg}; } }
    else throw {code:"gemini_http", next:true, message:d.msg};
  }
  var j = await res.json(), c = j.candidates && j.candidates[0];
  var text = ((c && c.content && c.content.parts) || []).filter(function(p){ return !p.thought; }).map(function(p){ return p.text || ""; }).join("");
  if (!text.trim()) throw {code:"empty_completion", next:true, message:"empty " + ((c && c.finishReason) || (j.promptFeedback && j.promptFeedback.blockReason) || "")};
  return text;
}
async function askGemini(input, opts){
  var key = lsGet(GKEY);
  if (!key) throw {code:"no_key", message:"no Gemini key"};
  var imgs = opts && opts.images ? [].slice.call(opts.images.length === undefined ? [opts.images] : opts.images) : [], parts = [];
  for (var i = 0; i < imgs.length; i++) parts.push({inline_data:{mime_type:"image/jpeg", data:await jpegB64(imgs[i], 1800)}});
  parts.push({text:String(input)});
  var models = [], last;
  [lsGet(GOK), lsGet(GMODEL) || DEF_GMODEL].concat(GEM_FALLBACK).forEach(function(m){ if (m && models.indexOf(m) < 0) models.push(m); });
  for (var k = 0; k < models.length; k++){
    try {
      var text = await geminiOnce(models[k], key, parts);
      try { localStorage.setItem(GOK, models[k]); } catch(e){}
      return text;
    } catch(e){
      last = e; if (e && e.message) e.message = models[k] + " " + e.message;
      if (!e || !e.next) throw e;
    }
  }
  throw last;
}
var GEM_MSG = {bad_gemini_key:"مفتاح Gemini غير صحيح أو غير مفعّل. راجعه من الإعدادات أسفل الصفحة.", rate_limited:"تم بلوغ الحد المجاني لـ Gemini الآن. حاول بعد قليل.",
  bad_gemini_model:"اسم موديل Gemini غير صحيح. راجعه من الإعدادات أسفل الصفحة.", upstream_error:"تعذّر الوصول إلى Gemini من هذا الجهاز.", gemini_http:"رفض Gemini الطلب.", gemini_region:"الباقة المجانية لـ Gemini غير متاحة لهذا الحساب أو البلد."};

/* ---------- القراءة المجانية على الجهاز: Tesseract.js (بدون مفتاح) ---------- */
var TESS = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
var tessP = null, workers = {};
function loadTess(){
  if (!tessP) tessP = new Promise(function(resolve, reject){
    if (window.Tesseract) return resolve();
    var s = document.createElement("script");
    s.src = (window.__ocr && window.__ocr.script) || TESS;
    s.onload = function(){ resolve(); };
    s.onerror = function(){ tessP = null; reject({code:"upstream_error", message:"ocr script"}); };
    document.head.appendChild(s);
  });
  return tessP;
}
function within(p, ms){
  return Promise.race([p, new Promise(function(_, reject){ setTimeout(function(){ reject({code:"upstream_error", message:"ocr timeout"}); }, ms); })]);
}
function getWorker(langs){
  var k = langs.join("+");
  if (!workers[k]){
    workers[k] = loadTess().then(function(){
      var o = {};
      if (window.__ocr){ o.workerPath = window.__ocr.workerPath; o.corePath = window.__ocr.corePath; o.langPath = window.__ocr.langPath; }
      return within(window.Tesseract.createWorker(langs, 1, o), 120000);
    }).catch(function(e){ delete workers[k]; throw e && e.code ? e : {code:"upstream_error", message:"ocr init"}; });
  }
  return workers[k];
}
async function prepImage(blob, opt){
  opt = opt || {};
  var bmp;
  try { bmp = await createImageBitmap(blob); } catch(e){ throw {code:"image_rejected", message:"cannot decode image"}; }
  var big = Math.max(bmp.width, bmp.height), mx = opt.max || 2200, sc = big > mx ? mx / big : big < 1100 && !opt.max ? Math.min(2, 1100 / big) : 1;
  var w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc), rot = opt.rot || 0;
  var c = document.createElement("canvas");
  c.width = rot % 180 ? h : w; c.height = rot % 180 ? w : h;
  var x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.drawImage(bmp, -w / 2, -h / 2, w, h);
  x.setTransform(1, 0, 0, 1, 0, 0);
  var W = c.width, H = c.height, im = x.getImageData(0, 0, W, H), d = im.data, n = W * H, g = new Uint8ClampedArray(n), sum = 0, i;
  for (i = 0; i < n; i++){ g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; sum += g[i]; }
  if (sum / n < 110) for (i = 0; i < n; i++) g[i] = 255 - g[i];
  if (opt.thresh){
    /* عتبة محلية (Bradley) لإزالة الخلفيات المنقوشة والظلال */
    var I = new Float64Array((W + 1) * (H + 1)), r = Math.max(8, Math.round(W / 24)), X, Y;
    for (Y = 1; Y <= H; Y++){ var row = 0; for (X = 1; X <= W; X++){ row += g[(Y - 1) * W + X - 1]; I[Y * (W + 1) + X] = I[(Y - 1) * (W + 1) + X] + row; } }
    var out = new Uint8ClampedArray(n);
    for (Y = 0; Y < H; Y++) for (X = 0; X < W; X++){
      var x0 = Math.max(0, X - r), x1 = Math.min(W, X + r + 1), y0 = Math.max(0, Y - r), y1 = Math.min(H, Y + r + 1);
      var m = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      out[Y * W + X] = g[Y * W + X] < m * 0.85 ? 0 : 255;
    }
    g = out;
  }
  for (i = 0; i < n; i++){ d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i]; d[i * 4 + 3] = 255; }
  x.putImageData(im, 0, 0);
  return {canvas:c, portrait:H > W * 1.15};
}
async function ocr(blob, langs, opt){
  var w = await getWorker(langs), p = await prepImage(blob, opt);
  var r = await within(w.recognize(p.canvas), 120000);
  return {text:normDigits((r && r.data && r.data.text) || ""), portrait:p.portrait};
}
function normDigits(t){
  return String(t).replace(/[٠-٩]/g, function(d){ return "٠١٢٣٤٥٦٧٨٩".indexOf(d); })
    .replace(/[۰-۹]/g, function(d){ return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); }).replace(/٫/g, ".").replace(/٬/g, ",")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
function toNum(s){ var n = Number(String(s).replace(/[,\s]/g, "")); return isFinite(n) ? n : null; }
function pad(n){ return String(n).padStart(2, "0"); }
function findDate(t, future){
  var m, y, mo, d;
  if ((m = t.match(/(20\d{2})\s?[-\/.]\s?(\d{1,2})\s?[-\/.]\s?(\d{1,2})/))){ y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = t.match(/(\d{1,2})\s?[-\/.]\s?(\d{1,2})\s?[-\/.]\s?(20\d{2})/))){ d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = t.match(/(?:^|[^\d])(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2})(?!\d)/))){ d = +m[1]; mo = +m[2]; y = 2000 + (+m[3]); }
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var s = y + "-" + pad(mo) + "-" + pad(d);
  if (!future && new Date(s + "T00:00") - Date.now() > 864e5) return null;
  return {date:s, raw:m[0]};
}
function findTime(t){
  var m = t.match(/(?:^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(AM|PM|ص|م)?/i);
  if (!m) return null;
  var h = +m[1], ap = (m[3] || "").toLowerCase();
  if ((ap === "pm" || ap === "م") && h < 12) h += 12;
  if ((ap === "am" || ap === "ص") && h === 12) h = 0;
  return pad(h) + ":" + m[2];
}
var CUR = "(?:SAR|S\\.?R\\.?|ر\\.?\\s?س|ريال)", NUM = "(\\d[\\d,]*(?:\\.\\d{1,2})?)";
function parseBank(t){
  var lines = t.split(/\n+/), best = null, first = null;
  var re = new RegExp(CUR + "\\s*:?\\s*" + NUM + "|" + NUM + "\\s*" + CUR, "gi");
  lines.forEach(function(line){
    if (/رصيد|المتاح|balance|avail/i.test(line) && !/مبلغ|amount|شراء|purchase/i.test(line)) return;
    var cut = line.split(/رصيد|المتاح|balance|avail/i)[0], m;
    re.lastIndex = 0;
    while ((m = re.exec(cut))){
      var v = toNum(m[1] || m[2]);
      if (!(v > 0)) continue;
      if (first == null) first = v;
      if (best == null && /مبلغ|amount|شراء|purchase|خصم|debit|بـ|paid|دفع/i.test(cut)) best = v;
    }
  });
  if (best == null) best = first;
  if (best == null){
    var m2 = t.match(/(?:مبلغ|amount)\D{0,12}(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (m2) best = toNum(m2[1]);
  }
  var d = findDate(t), tm = findTime(d ? t.replace(d.raw, " ") : t), now = new Date();
  return {amount_sar:best, datetime:d ? d.date + "T" + (tm || pad(now.getHours()) + ":" + pad(now.getMinutes())) : null};
}
function parseDash(t){
  var out = {odometer_km:null, range_km:null, avg_value:null, avg_unit:null}, m;
  if ((m = t.match(/(\d{1,2}[.,]\d)\s*(km\s*\/\s*l|l\s*\/\s*100\s*km)/i))){
    out.avg_value = Number(m[1].replace(",", ".")); out.avg_unit = /^l/i.test(m[2]) ? "l/100km" : "km/l";
    t = t.replace(m[0], " ");
  }
  t = t.replace(/\d{1,2}:\d{2}/g, " ");
  if ((m = t.match(/(?:odo|odometer|total)\D{0,10}(\d[\d,\s]{3,8}\d)/i))) out.odometer_km = toNum(m[1]);
  if (out.odometer_km == null){
    /* لا يُقبل إلا رقم ملتصق بوحدة km حتى لا تُلتقط أرقام عداد السرعة */
    var reO = /(?:^|[^\d,.])(\d[\d,]{3,7})\s*km(?!\s*\/)/gi, mo, all = [];
    while ((mo = reO.exec(t))){ var vo = toNum(mo[1]); if (vo >= 1000 && vo <= 999999) all.push(vo); }
    if (all.length) out.odometer_km = Math.max.apply(null, all);
  }
  if ((m = t.match(/(?:range|dte|empty|المدى)\D{0,15}(\d{2,4})(?!\d)/i))) out.range_km = toNum(m[1]);
  if (out.range_km == null){
    var re = /(?:^|[^\d,])(\d{2,4})\s*km(?!\s*\/)/gi, k;
    while ((k = re.exec(t))){ var v = toNum(k[1]); if (v !== out.odometer_km && v < 1500){ out.range_km = v; break; } }
  }
  return out;
}
function parseInv(t){
  var out = {date:null, total_sar:null, odometer_km:null, shop:null, items:null}, d = findDate(t), m, tot = [];
  if (d) out.date = d.date;
  t.split(/\n+/).forEach(function(line){
    if (/الإجمالي|الاجمالي|المجموع|الصافي|المستحق|total|net|amount due|grand/i.test(line))
      (line.match(/\d[\d,]*\.\d{1,2}|\d[\d,]{1,7}/g) || []).forEach(function(s){ var v = toNum(s); if (v > 0 && v < 1000000) tot.push(v); });
  });
  if (!tot.length) (t.match(/\d[\d,]*\.\d{2}(?!\d)/g) || []).forEach(function(s){ var v = toNum(s); if (v > 0 && v < 1000000) tot.push(v); });
  if (tot.length) out.total_sar = Math.max.apply(null, tot);
  if ((m = t.match(/(?:عداد|ممشى|الكيلومترات|odometer|mileage|\bkm\b)\D{0,12}(\d[\d,]{3,7})/i))) out.odometer_km = toNum(m[1]);
  var first = t.split(/\n+/).map(function(s){ return s.trim(); }).filter(function(s){ return /[A-Za-zء-ي]{3}/.test(s); })[0];
  if (first) out.shop = first.slice(0, 40);
  return out;
}
function parseStk(t){
  var out = {date:null, odometer_km:null, next_km:null, oil:null}, d = findDate(t), m;
  if (d){ out.date = d.date; t = t.replace(d.raw, " "); }
  if ((m = t.match(/\d{1,2}\s?W\s?-?\s?\d{2}/i))){ out.oil = m[0].replace(/\s/g, "").toUpperCase(); t = t.replace(m[0], " "); }
  var nums = (t.match(/\d[\d,]{3,7}/g) || []).map(toNum).filter(function(n){ return n >= 1000 && n <= 999999; }).sort(function(a, b){ return a - b; });
  for (var i = 0; i < nums.length && out.next_km == null; i++) for (var j = i + 1; j < nums.length; j++){
    var diff = nums[j] - nums[i];
    if (diff >= 1000 && diff <= 20000){ out.odometer_km = nums[i]; out.next_km = nums[j]; break; }
  }
  if (out.odometer_km == null && nums.length) out.odometer_km = nums[nums.length - 1];
  return out;
}
var MAKES = [["تويوتا","toyota"],["هيونداي","hyundai"],["نيسان","nissan"],["كيا","kia"],["فورد","ford"],["شفروليه","chevrolet"],["هوندا","honda"],
  ["لكزس","lexus"],["مازدا","mazda"],["ميتسوبيشي","mitsubishi"],["جي ام سي","gmc"],["مرسيدس","mercedes"],["بي ام دبليو","bmw"],["جيلي","geely"],
  ["شانجان","changan"],["ام جي","mg"],["هافال","haval"],["سوزوكي","suzuki"],["ايسوزو","isuzu"],["دودج","dodge"],["جيب","jeep"],["اودي","audi"],
  ["فولكس واجن","volkswagen"],["رينو","renault"],["جينيسيس","genesis"],["لاند روفر","land rover"],["شيري","chery"],["جاك","jac"],
  ["كاديلاك","cadillac"],["انفينيتي","infiniti"],["بورش","porsche"],["سوبارو","subaru"],["بيجو","peugeot"],["كرايسلر","chrysler"],["لينكولن","lincoln"],
  ["جاكوار","jaguar"],["فولفو","volvo"],["تسلا","tesla"],["بي واي دي","byd"],["جيتور","jetour"],["اكسيد","exeed"],["هونشي","hongqi"],["جي اي سي","gac"],
  ["بايك","baic"],["فوتون","foton"],["دايهاتسو","daihatsu"],["رام","ram"],["ميني","mini"],["فيات","fiat"],["ماهيندرا","mahindra"],["تاتا","tata"]];
var COLORS = ["ابيض","اسود","فضي","رمادي","رصاصي","احمر","ازرق","بني","ذهبي","اخضر","بيج","لؤلؤي","عنابي","كحلي","برتقالي","اصفر","برونزي","سماوي","شامبين","زيتي"];
var PLATE_EN = {A:"ا",B:"ب",J:"ح",D:"د",R:"ر",S:"س",X:"ص",T:"ط",E:"ع",G:"ق",K:"ك",L:"ل",Z:"م",N:"ن",H:"هـ",U:"و",V:"ي"};
function normAr(t){
  return String(t).replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
}
var NEXT_LABEL = /مارك[هت]|طراز|وزن|حمول[هت]|اللون|سن[هت]|نوع|رقم|هوي[هت]|المالك|المستخدم/;
function lineVal(t, label, drop){
  var ls = t.split(/\n+/);
  for (var i = 0; i < ls.length; i++){
    var m = ls[i].match(label);
    if (!m) continue;
    var after = ls[i].slice(m.index + m[0].length), before = ls[i].slice(0, m.index);
    var cut = after.replace(drop, " "), n = cut.search(NEXT_LABEL);
    if (n >= 0) cut = cut.slice(0, n);
    var v = cut.replace(/[:\-|.,،()]/g, " ").replace(/\s+/g, " ").trim();
    if (!v){ /* القيمة قبل العنوان في بعض القراءات */
      var bb = before.replace(drop, " "), k = -1, mm, re = new RegExp(NEXT_LABEL.source, "g");
      while ((mm = re.exec(bb))) k = mm.index + mm[0].length;
      v = (k >= 0 ? bb.slice(k) : bb).replace(/[:\-|.,،()]/g, " ").replace(/\s+/g, " ").trim();
    }
    if (v) return v;
  }
  return null;
}
function arWords(v){ return (v.match(/[ء-ي]{2,}/g) || []).join(" "); }
var WMI = [["KNA|KNB|KNC|KND|KNE|U5Y|U6Y|3KP|5XX|5XY","كيا"],["KMH|KMF|KMJ|KM8|TMA|NLH|MAL|5NP|5NM","هيونداي"],["JTH|JTJ|2T2|58A","لكزس"],
  ["JT|MR0|MR1|MHF|MHK|NMT|6T1|2T1|2T3|4T1|4T3|5TD|5TF|5YF|3TM|3TY|SB1|VNK","تويوتا"],["JNK|JNR|5N3","انفينيتي"],["JN|1N4|1N6|3N1|3N6|5N1|MNT|MDH|VSK|SJN","نيسان"],
  ["JH4|19U","اكيورا"],["JHM|JHL|1HG|2HG|2HK|5J6|5FN|19X|SHH|MRH|LVH","هوندا"],["1FA|1FM|1FT|1FD|2FM|3FA|3FM|MAJ|WF0|NM0","فورد"],
  ["1G1|1GC|1GN|2G1|3G1|3GN|KL1|KL7|KL8|LSG","شفروليه"],["1GT|1GK|2GT|3GT|3GK","جي ام سي"],["1GY|1G6","كاديلاك"],
  ["WDB|WDC|WDD|WDF|W1K|W1N|W1V|4JG|55S","مرسيدس"],["WBA|WBS|WBX|WBY|5UX|5UJ","بي ام دبليو"],["WAU|WA1|TRU","اودي"],["WVW|WVG|WV1|WV2|3VW|1VW","فولكس واجن"],
  ["WP0|WP1","بورش"],["JM|MM0|MM6|MM7|3MZ","مازدا"],["JA|JMB|JMY|MMB|MMA|ML3","ميتسوبيشي"],["JS|MA3|TSM","سوزوكي"],["JF","سوبارو"],["JAA|JAL|MPA","ايسوزو"],
  ["SAL","لاند روفر"],["SAJ","جاكوار"],["1C4|1J4|1J8|3C4","جيب"],["2C3|1C3|2B3","دودج"],["1C6|3C6|3D7","رام"],["5YJ|7SA|LRW|XP7","تسلا"],
  ["L6T|LB3|LJ1","جيلي"],["LS5|LS4|LDC","شانجان"],["LGW|LGX","هافال"],["LSJ","ام جي"],["LVV|LVT|LNN","شيري"],["LC0|LGX","بي واي دي"],
  ["LJD|LJX","جاك"],["LFP|LFB","هونشي"],["LMG|LMW","جي اي سي"],["VF1|VF2","رينو"],["VF3","بيجو"],["ZFA","فيات"],["YV1|YV4","فولفو"],["5LM|1LN","لينكولن"]];
var VIN_YEAR = "ABCDEFGHJKLMNPRSTVWXY123456789";
function fromVin(out){
  if (!out.vin) return;
  if (!out.make) for (var i = 0; i < WMI.length; i++) if (new RegExp("^(?:" + WMI[i][0] + ")").test(out.vin)){ out.make = WMI[i][1]; break; }
  if (!out.year){
    var k = VIN_YEAR.indexOf(out.vin.charAt(9)), now = new Date().getFullYear();
    if (k >= 0){ var y = 2010 + k; while (y > now + 1) y -= 30; if (y >= 1981) out.year = y; }
  }
}
function parseReg(raw){
  var out = {make:null, model:null, year:null, plate:null, color:null, vin:null, expiry:null}, m, t = normAr(raw), low = t.toLowerCase(), i;
  /* الماركة: من القائمة المعروفة ثم من عنوان الحقل */
  for (i = 0; i < MAKES.length; i++)
    if (new RegExp("(^|[^\\u0621-\\u064A])" + normAr(MAKES[i][0]) + "([^\\u0621-\\u064A]|$)").test(t) || new RegExp("\\b" + MAKES[i][1] + "\\b").test(low)){ out.make = MAKES[i][0]; break; }
  var v0, labelMake = null;
  if (!out.make && (v0 = lineVal(t, /مارك[هت]|(?:ال)?صانع/, /المركب[هت]/g)) && (v0 = arWords(v0)) && v0.length >= 3) labelMake = v0.slice(0, 22);
  /* الطراز */
  if ((v0 = lineVal(t, /(?:ال)?طراز|موديل/, /المركب[هت]/g))){
    var mv = arWords(v0) || (/^[A-Za-z0-9 ]{2,25}$/.test(v0) && !/^\d+$/.test(v0) ? v0 : "");
    if (mv) out.model = mv.slice(0, 25);
  }
  /* اللون */
  for (i = 0; i < COLORS.length && !out.color; i++) if (new RegExp("(^|[^\\u0621-\\u064A])" + COLORS[i] + "([^\\u0621-\\u064A]|$)").test(t)) out.color = COLORS[i];
  if (!out.color && (v0 = lineVal(t, /(?:ال)?لون/, /الاساسي|المركب[هت]|الفرعي/g)) && (m = v0.match(/[ء-ي]{3,10}/))) out.color = m[0];
  /* رقم الهيكل */
  var vinLine = (raw.split(/\n+/).filter(function(l){ return /هيكل|vin|chassis/i.test(l); })[0] || "").toUpperCase();
  var toks = (vinLine.match(/[A-Z0-9]{17}/g) || []).concat(raw.toUpperCase().match(/[A-Z0-9]{17}/g) || []);
  for (i = 0; i < toks.length && !out.vin; i++){
    var v = toks[i].replace(/[OQ]/g, "0").replace(/I/g, "1");
    if (/[A-Z]/.test(v) && /\d{4}$/.test(v)) out.vin = v;
  }
  if (!out.vin){
    /* رقم هيكل مقسوم إلى جزأين أو معكوس الترتيب في سطر عنوانه */
    var vl = raw.split(/\n+/).filter(function(l){ return /هيكل|vin|chassis/i.test(l); })[0] || "";
    var parts = vl.toUpperCase().match(/[A-Z0-9]{3,}/g) || [];
    for (i = 0; i + 1 < parts.length && !out.vin; i++) if (parts[i].length + parts[i + 1].length === 17){
      var c1 = parts[i] + parts[i + 1], c2 = parts[i + 1] + parts[i];
      var pick = /\d{4}$/.test(c1) && !/\d{4}$/.test(c2) ? c1 : /\d{4}$/.test(c2) && !/\d{4}$/.test(c1) ? c2 : /^[A-Z]/.test(c1) ? c1 : c2;
      pick = pick.replace(/[OQ]/g, "0").replace(/I/g, "1");
      if (/[A-Z]/.test(pick) && /\d{4}$/.test(pick)) out.vin = pick;
    }
  }
  /* سنة الصنع */
  if ((m = t.match(/(?:سن[هت]\s*الصنع|الصنع|year)\D{0,15}(19[89]\d|20[0-3]\d)(?!\d)/i))) out.year = +m[1];
  fromVin(out);
  if (!out.make && labelMake) out.make = labelMake;
  /* اللوحة: اللاتينية أولاً لأنها أدق في القراءة، ثم سطر عنوان اللوحة، ثم أي نمط عربي */
  var body = out.vin ? raw.toUpperCase().replace(out.vin, " ") : raw.toUpperCase();
  var L = "[ABJDRSXTEGKLZNHUV]", num, ls;
  var pm = body.match(new RegExp("(?:^|[^A-Z0-9])(" + L + ")\\s?(" + L + ")\\s?(" + L + ")\\s{0,3}(\\d{1,4})(?![A-Z0-9])"));
  if (pm){ ls = [pm[1], pm[2], pm[3]]; num = pm[4]; }
  else if ((pm = body.match(new RegExp("(?:^|[^A-Z0-9])(\\d{1,4})\\s{0,3}(" + L + ")\\s?(" + L + ")\\s?(" + L + ")(?![A-Z0-9])")))){ ls = [pm[2], pm[3], pm[4]]; num = pm[1]; }
  if (ls && ls.join("") !== "KSA") out.plate = ls.reverse().map(function(c){ return PLATE_EN[c]; }).join(" ") + " " + num;
  if (!out.plate && (m = (t.split(/\n+/).filter(function(l){ return /لوح/.test(l); })[0] || "").replace(/رقم|اللوح[هت]|لوح[هت]/g, " ").match(/^[^\d]*?((?:[ء-ي]\s*){3,4})\s*(\d{1,4})(?!\d)|(?:^|[^\d])(\d{1,4})\s*((?:[ء-ي]\s*){3,4})\s*$/))){
    var lt = (m[1] || m[4]).replace(/\s/g, "").split(""), dg = m[2] || m[3];
    if (lt.length === 4) lt = lt.filter(function(ch, k){ return k === 0 || ch !== lt[k - 1]; });
    if (lt.length === 3) out.plate = lt.join(" ") + " " + dg;
  }
  if (!out.plate){
    if ((m = t.match(/(?:^|[^\d])(\d{1,4})\s+([ء-ي])\s+([ء-ي])\s+([ء-ي])(?![ء-ي])/)))
      out.plate = m[2] + " " + m[3] + " " + m[4] + " " + m[1];
    else if ((m = t.match(/(?:^|[^ء-ي])([ء-ي])\s+([ء-ي])\s+([ء-ي])\s+(\d{1,4})(?!\d)/)))
      out.plate = m[1] + " " + m[2] + " " + m[3] + " " + m[4];
  }
  /* تاريخ الانتهاء بالميلادي */
  var el = t.split(/\n+/).filter(function(l){ return /انتهاء|expiry|expire/i.test(l); })[0];
  if (el){ var d = findDate(el, true); if (d) out.expiry = d.date; }
  return out;
}
function kindOf(input){
  var s = String(input);
  return s.indexOf('"make"') >= 0 ? "reg" : s.indexOf('"next_km"') >= 0 ? "stk" : s.indexOf('"total_sar"') >= 0 ? "inv"
    : s.indexOf('"amount_sar"') >= 0 ? "bank" : s.indexOf('"range_km"') >= 0 ? "dash" : null;
}
var PARSE = {reg:parseReg, stk:parseStk, inv:parseInv, bank:parseBank, dash:parseDash};
window.__ocrParse = PARSE;
function hasKey(){ try { return !!localStorage.getItem(APIKEY); } catch(e){ return false; } }
function filled(o){ var n = 0; for (var k in o) if (o[k] != null && o[k] !== "") n++; return n; }
function merge(a, b){ for (var k in b) if (a[k] == null || a[k] === "") a[k] = b[k]; return a; }
var REG_WORDS = /المركب|اللون|الصنع|الهيكل|اللوح|مارك|طراز|التسجيل|المالك|وزار|المملك|REGISTRATION|KINGDOM|MINISTRY|VEHICLE|INTERIOR/gi;
function regScore(t){ return (normAr(t).match(REG_WORDS) || []).length + (/[A-HJ-NPR-Z0-9]{13}\d{4}/.test(t.toUpperCase()) ? 2 : 0); }
async function readReg(img){
  var bmp, portrait = false;
  try { bmp = await createImageBitmap(img); portrait = bmp.height > bmp.width * 1.15; } catch(e){ throw {code:"image_rejected", message:"cannot decode image"}; }
  /* تحديد اتجاه البطاقة بقراءة سريعة مصغّرة، ثم القراءة الكاملة على الاتجاه الصحيح فقط */
  var order = portrait ? [90, 270, 0, 180] : [0, 180, 90, 270], best = null, log = [];
  for (var i = 0; i < order.length; i++){
    var q = await ocr(img, ["eng", "ara"], {rot:order[i], max:1400}), sc = regScore(q.text);
    log.push("rot " + order[i] + " score " + sc);
    if (!best || sc > best.sc) best = {rot:order[i], sc:sc};
    if (sc >= 3) break;
  }
  var r1 = await ocr(img, ["eng", "ara"], {rot:best.rot}), res = parseReg(r1.text);
  window.__ocrLast = log.join(", ") + "\n" + r1.text;
  if (!res.make || !res.model || !res.year || !res.plate || !res.color || !res.vin){
    var r2 = await ocr(img, ["eng", "ara"], {rot:best.rot, thresh:true});
    window.__ocrLast += "\n-----\n" + r2.text;
    res = merge(res, parseReg(r2.text));
  }
  if (!res.vin || !res.plate){
    var r3 = await ocr(img, ["eng"], {rot:best.rot}), e3 = parseReg(r3.text);
    window.__ocrLast += "\n-----\n" + r3.text;
    if (!res.vin && e3.vin) res.vin = e3.vin;
    if (!res.plate && e3.plate) res.plate = e3.plate;
    fromVin(res);
  }
  return res;
}
sample.json = async function(input, opts){
  if (lsGet(GKEY)){
    try { return parseJson(await askGemini(input, opts)); }
    catch(e){ toast((GEM_MSG[e && e.code] || "تعذّرت قراءة Gemini لهذه الصورة.") + " استُخدمت القراءة على الجهاز بدلاً منه." + (e && e.message ? " [" + e.message + "]" : "")); }
  }
  else if (hasKey()) return ask(input, opts).then(parseJson);
  var kind = kindOf(input), imgs = opts && opts.images ? [].slice.call(opts.images.length === undefined ? [opts.images] : opts.images) : [];
  if (!kind || !imgs.length) throw {code:"upstream_error", message:"nothing to read"};
  if (kind === "reg") return readReg(imgs[0]);
  var langs = kind === "dash" ? ["eng"] : ["eng", "ara"];
  var r = await ocr(imgs[0], langs), res = PARSE[kind](r.text);
  window.__ocrLast = r.text;
  /* محاولات إضافية عند فشل القراءة: عتبة محلية، ثم تدوير الصورة إن كانت بالطول */
  var tries = [{thresh:true}];
  if (r.portrait) tries.push({rot:90}, {rot:270});
  for (var i = 0; i < tries.length && filled(res) < 1; i++){
    var r2 = await ocr(imgs[0], langs, tries[i]);
    window.__ocrLast += "\n-----\n" + r2.text;
    res = merge(res, PARSE[kind](r2.text));
  }
  return res;
};
sample.limits = function(){
  return Promise.resolve({maxPromptBytes:262144, images:{maxCount:5, maxInputBytes:20971520, mediaTypes:["image/jpeg","image/png","image/webp","image/gif"]}});
};

window.claude = {
  use:function(name){
    return Promise.resolve(name === "db" ? db : name === "assets" ? assets : name === "sample" ? sample : null);
  }
};

/* ---------- بطاقة الإعدادات والنسخ الاحتياطي ---------- */
function blobToB64(b){
  return new Promise(function(resolve, reject){
    var r = new FileReader();
    r.onload = function(){ resolve(String(r.result)); }; r.onerror = reject; r.readAsDataURL(b);
  });
}
function b64ToBlob(dataUrl){ return fetch(dataUrl).then(function(r){ return r.blob(); }); }
function allBlobs(){
  return idb().then(function(d){
    return new Promise(function(resolve, reject){
      var out = {}, t = d.transaction("b", "readonly"), rq = t.objectStore("b").openCursor();
      rq.onsuccess = function(){ var c = rq.result; if (c){ out[c.key] = c.value; c.continue(); } };
      t.oncomplete = function(){ resolve(out); }; t.onerror = reject;
    });
  });
}
var main = document.querySelector("main");
if (main){
  var card = document.createElement("section");
  card.className = "card";
  card.innerHTML =
    '<details><summary>الإعدادات والنسخ الاحتياطي</summary><div class="grid">' +
    '<p class="hint f wide">بدون مفتاح تُقرأ الصور بأداة مجانية على الجهاز نفسه، وهي تقرأ الاستمارة والفواتير وخصم البنك لكنها لا تقرأ أرقام الطبلون الرقمية. راجع الأرقام دائماً قبل الحفظ.</p>' +
    '<div class="f wide"><label for="sa-gkey">مفتاح Gemini المجاني (لقراءة دقيقة لكل الصور ومنها الطبلون)</label>' +
    '<input type="text" id="sa-gkey" autocomplete="off" dir="ltr" placeholder="AIza...">' +
    '<div class="row" id="sa-gkey-lock" hidden><span class="hint" style="flex:1">✓ المفتاح محفوظ ومخفي</span>' +
    '<button type="button" class="btn sm" id="sa-gkey-edit">تغيير</button><button type="button" class="btn sm danger" id="sa-gkey-del">حذف</button></div></div>' +
    '<div class="f wide"><label for="sa-gmodel">موديل Gemini</label><input type="text" id="sa-gmodel" autocomplete="off" dir="ltr"></div>' +
    '<p class="hint f wide">يُنشأ المفتاح مجاناً من aistudio.google.com ثم Get API key. عند وجوده تُرسل الصورة إلى Google للقراءة، وقد تستخدمها Google لتحسين منتجاتها في الباقة المجانية.</p>' +
    '<div class="f wide"><label for="sa-key">مفتاح Claude API (بديل مدفوع، اختياري)</label>' +
    '<input type="text" id="sa-key" autocomplete="off" dir="ltr" placeholder="sk-ant-...">' +
    '<div class="row" id="sa-key-lock" hidden><span class="hint" style="flex:1">✓ المفتاح محفوظ ومخفي</span>' +
    '<button type="button" class="btn sm" id="sa-key-edit">تغيير</button><button type="button" class="btn sm danger" id="sa-key-del">حذف</button></div></div>' +
    '<div class="f wide"><label for="sa-model">الموديل</label><input type="text" id="sa-model" autocomplete="off" dir="ltr"></div>' +
    '<p class="hint f wide">المفتاح يُحفظ على هذا الجهاز فقط ويُرسل مباشرة إلى Anthropic عند قراءة صورة. بدون مفتاح تُستخدم القراءة المجانية.</p>' +
    '<div class="row f wide"><button type="button" class="btn" id="sa-save">حفظ الإعدادات</button><button type="button" class="btn" id="sa-gtest">اختبار مفتاح Gemini</button><button type="button" class="btn" id="sa-update">تحديث البرنامج</button><span class="hint" id="sa-msg" role="status"></span></div>' +
    '<div class="f wide" id="sa-sync-box"><label for="sa-sync">المزامنة التلقائية بين أجهزتك</label>' +
    '<input type="text" id="sa-sync" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" dir="ltr" placeholder="رمز المزامنة (8 خانات أو أكثر)">' +
    '<p class="hint" style="margin:6px 0 0">اختر رمزاً خاصاً بك واكتبه نفسه في كل جهاز (التطبيق، المتصفح، الكمبيوتر) فتتوحد البيانات تلقائياً. من يعرف الرمز يرى بياناتك، فاجعله صعب التخمين.</p></div>' +
    '<div class="row f wide"><button type="button" class="btn" id="sa-sync-on">تفعيل المزامنة</button><button type="button" class="btn" id="sa-sync-now" hidden>مزامنة الآن</button><button type="button" class="btn danger" id="sa-sync-off" hidden>إيقاف المزامنة</button></div>' +
    '<p class="hint f wide" id="sa-sync-msg" role="status"></p>' +
    '<p class="hint f wide">البيانات محفوظة على هذا الجهاز، ومع المزامنة تُحفظ نسخة منها على خادم الموقع. للتحديث استخدم زر «تحديث البرنامج» ولا تحذف أيقونة التطبيق، فحذفها يمسح البيانات. صدّر نسخة احتياطية دورياً. الاستيراد يدمج الملف مع بيانات هذا الجهاز ولا يحذف شيئاً ولا يكرر السجلات.</p>' +
    '<div class="row f wide"><button type="button" class="btn" id="sa-export">تصدير نسخة احتياطية</button>' +
    '<label class="btn" style="display:inline-flex;align-items:center;cursor:pointer">استيراد ودمج نسخة<input type="file" id="sa-import" accept="application/json,.json" hidden></label></div>' +
    '<p class="hint f wide" id="sa-bmsg" role="status"></p>' +
    '</div></details>';
  main.appendChild(card);
  var $ = function(id){ return document.getElementById(id); };
  /* المفتاح المحفوظ لا يُعرض: يظهر «محفوظ» مع تغيير أو حذف فقط */
  var KEYS = [["sa-gkey", GKEY], ["sa-key", APIKEY]];
  function lockKeys(){
    KEYS.forEach(function(k){
      var has = !!lsGet(k[1]);
      $(k[0]).value = ""; $(k[0]).hidden = has; $(k[0] + "-lock").hidden = !has;
    });
  }
  function modeMsg(pre){
    $("sa-msg").textContent = pre + (lsGet(GKEY) ? " القراءة الآن عبر Gemini." : lsGet(APIKEY) ? " القراءة الآن عبر Claude." : " القراءة الآن بالأداة المجانية على الجهاز.");
  }
  KEYS.forEach(function(k){
    $(k[0] + "-edit").addEventListener("click", function(){
      $(k[0] + "-lock").hidden = true; $(k[0]).hidden = false; $(k[0]).value = ""; $(k[0]).focus();
      $("sa-msg").textContent = "الصق المفتاح الجديد ثم اضغط حفظ الإعدادات.";
    });
    $(k[0] + "-del").addEventListener("click", function(){
      try { localStorage.removeItem(k[1]); localStorage.removeItem(GOK); } catch(e){}
      lockKeys(); modeMsg("تم حذف المفتاح.");
    });
  });
  try { $("sa-model").value = localStorage.getItem(MODELKEY) || DEF_MODEL; $("sa-gmodel").value = localStorage.getItem(GMODEL) || DEF_GMODEL; } catch(e){}
  lockKeys();
  $("sa-update").addEventListener("click", async function(){
    var btn = $("sa-update"), msg = $("sa-msg");
    btn.disabled = true; msg.textContent = "جارٍ البحث عن تحديث...";
    var latest = await latestVersion();
    if (!latest){ msg.textContent = "تعذّر الاتصال بالموقع. تحقق من الإنترنت ثم حاول."; btn.disabled = false; return; }
    if (latest === VERSION){ msg.textContent = "أنت على آخر نسخة (" + VERSION + ")."; btn.disabled = false; return; }
    msg.textContent = "جارٍ التحديث إلى النسخة " + latest + "... بياناتك محفوظة.";
    applyUpdate();
  });
  $("sa-gtest").addEventListener("click", async function(){
    var btn = $("sa-gtest"), msg = $("sa-msg");
    if ($("sa-gkey").value.trim()){ msg.textContent = "اضغط «حفظ الإعدادات» أولاً ثم اختبر."; return; }
    if (!lsGet(GKEY)){ msg.textContent = "لا يوجد مفتاح Gemini محفوظ."; return; }
    btn.disabled = true; msg.textContent = "جارٍ اختبار المفتاح...";
    try {
      await askGemini('Reply with exactly this JSON: {"ok": true}', {});
      msg.textContent = "✓ المفتاح يعمل. الموديل المستخدم: " + lsGet(GOK);
    } catch(e){
      msg.textContent = "✗ " + (GEM_MSG[e && e.code] || "لم ينجح الاختبار.") + (e && e.message ? " [" + e.message + "]" : "");
    }
    btn.disabled = false;
  });
  $("sa-save").addEventListener("click", function(){
    try {
      KEYS.forEach(function(k){ var v = $(k[0]).value.trim(); if (v) localStorage.setItem(k[1], v); });
      var m = $("sa-model").value.trim() || DEF_MODEL, gm = $("sa-gmodel").value.trim() || DEF_GMODEL;
      localStorage.setItem(MODELKEY, m); $("sa-model").value = m;
      localStorage.setItem(GMODEL, gm); $("sa-gmodel").value = gm;
      lockKeys(); modeMsg("تم الحفظ.");
    } catch(e){ $("sa-msg").textContent = "تعذّر الحفظ على هذا الجهاز."; }
  });
  /* ---------- واجهة المزامنة ---------- */
  var newCode = null;
  function syncUi(){
    var on = !!lsGet(SYNCKEY);
    $("sa-sync-box").hidden = on; $("sa-sync-on").hidden = on; $("sa-sync-now").hidden = !on; $("sa-sync-off").hidden = !on;
    if (on && !$("sa-sync-msg").textContent) $("sa-sync-msg").textContent = "المزامنة مفعّلة.";
  }
  syncStatus = function(t){ $("sa-sync-msg").textContent = t; };
  $("sa-sync-on").addEventListener("click", async function(){
    var code = $("sa-sync").value.trim(), btn = this;
    if (code.length < 8) return syncStatus("اكتب رمزاً من 8 خانات أو أكثر.");
    btn.disabled = true;
    try {
      var key = await sha256hex("fuel-sync-code|" + code), create = newCode === code;
      var r = await syncCall(key, {docs:{}, dels:{}, create:create});
      if (r.status === 404){ newCode = code; btn.textContent = "تأكيد إنشاء رمز جديد"; syncStatus("هذا الرمز غير مستخدم من قبل. إن كان أول جهاز اضغط «تأكيد إنشاء رمز جديد»، وإن كان لديك رمز سابق فتأكد من كتابته."); btn.disabled = false; return; }
      if (!r.ok) throw 0;
      var o = await r.json();
      adoptRemote(o);
      localStorage.setItem(SYNCKEY, key);
      $("sa-sync").value = ""; newCode = null; btn.textContent = "تفعيل المزامنة";
      syncStatus("تم تفعيل المزامنة."); syncUi(); syncNow();
    } catch(e){ syncStatus("تعذّر الاتصال بخادم المزامنة. تأكد من الإنترنت وحاول مرة أخرى."); }
    btn.disabled = false;
  });
  $("sa-sync").addEventListener("input", function(){ if (newCode){ newCode = null; $("sa-sync-on").textContent = "تفعيل المزامنة"; } });
  $("sa-sync-now").addEventListener("click", function(){ syncNow(true); });
  $("sa-sync-off").addEventListener("click", function(){
    if (!this.dataset.sure){ this.dataset.sure = "1"; this.textContent = "تأكيد الإيقاف"; return; }
    delete this.dataset.sure; this.textContent = "إيقاف المزامنة";
    try { localStorage.removeItem(SYNCKEY); } catch(e){}
    $("sa-sync-msg").textContent = "أُوقفت المزامنة على هذا الجهاز. البيانات باقية عليه.";
    syncUi();
  });
  syncUi();
  $("sa-export").addEventListener("click", async function(){
    var msg = $("sa-bmsg");
    try {
      var blobs = await allBlobs(), enc = {};
      for (var id in blobs) enc[id] = await blobToB64(blobs[id]);
      var file = new Blob([JSON.stringify({app:"fuel-log", version:1, exported:new Date().toISOString(), docs:store, blobs:enc})], {type:"application/json"});
      var a = document.createElement("a");
      a.href = URL.createObjectURL(file); a.download = "fuel-backup-" + new Date().toISOString().slice(0,10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      msg.textContent = "تم تجهيز ملف النسخة الاحتياطية.";
    } catch(e){ msg.textContent = "تعذّر تصدير النسخة الاحتياطية."; }
  });
  $("sa-import").addEventListener("change", async function(){
    var msg = $("sa-bmsg"), f = this.files && this.files[0]; if (!f) return;
    try {
      var o = JSON.parse(await f.text());
      if (!o || o.app !== "fuel-log" || typeof o.docs !== "object") throw 0;
      var before = clone(store), rep = mergeDocs(o.docs); stampChanges(before); persist(); if (!lsGet(MSKEY)) msPull();
      var ids = Object.keys(o.blobs || {});
      for (var i = 0; i < ids.length; i++){
        var b = await b64ToBlob(o.blobs[ids[i]]);
        await tx("readwrite", (function(blob, id){ return function(s){ return s.put(blob, id); }; })(b, ids[i]));
      }
      msg.textContent = "تم الدمج: أُضيف " + rep.cars + " سيارة، " + rep.fills + " تعبئة، " + rep.services + " سجل صيانة، " + rep.odo + " قراءة عداد. تُجوهل " + rep.skipped + " سجل مكرر. جارٍ إعادة التحميل…";
      setTimeout(function(){ location.reload(); }, 3500);
    } catch(e){ msg.textContent = "ملف النسخة الاحتياطية غير صالح."; }
    this.value = "";
  });
}

/* ---------- المزامنة التلقائية: آخر تعديل يفوز لكل سجل، والحذف ينتقل بين الأجهزة ---------- */
var SYNCPATH = /^(cars|fills|services|items|settings)\/[A-Za-z0-9_-]{1,64}$/, syncStatus = syncStatus || function(){}, syncing = false, syncAgain = false, syncTimer = null;
function sha256hex(s){
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function(h){
    return Array.from(new Uint8Array(h)).map(function(b){ return b.toString(16).padStart(2, "0"); }).join("");
  });
}
function syncCall(key, body){
  return fetch(SYNC_URL + "?a=sync", {method:"POST", cache:"no-store", headers:{"Content-Type":"application/json", "X-Sync-Key":key}, body:JSON.stringify(body)});
}
function stampChanges(before){
  var now = Date.now();
  Object.keys(store).forEach(function(p){ if (before[p] === undefined || JSON.stringify(before[p]) !== JSON.stringify(store[p])){ meta.t[p] = now; delete meta.d[p]; } });
}
/* أول ربط للجهاز: بيانات الخادم هي الأساس، وتُدمج فيها بيانات الجهاز دون تكرار */
function adoptRemote(o){
  var rd = o.docs || {}, paths = Object.keys(rd);
  if (!paths.length) return;
  var local = store, base = {};
  store = {}; meta = {t:{}, d:{}};
  paths.forEach(function(p){ store[p] = rd[p].d; base[p] = clone(rd[p].d); meta.t[p] = Number(rd[p].t) || 1; });
  Object.keys(o.dels || {}).forEach(function(p){ meta.d[p] = Number(o.dels[p]) || 1; });
  mergeDocs(local); stampChanges(base); persist(); notify(); msPull();
}
function applyRemote(o){
  var ch = false;
  Object.keys(o.dels || {}).forEach(function(p){
    var t = Number(o.dels[p]) || 0;
    if (store[p] !== undefined && (meta.t[p] || 1) <= t){ delete store[p]; delete meta.t[p]; ch = true; }
    if (store[p] === undefined) meta.d[p] = Math.max(meta.d[p] || 0, t);
  });
  Object.keys(o.docs || {}).forEach(function(p){
    var rec = o.docs[p], t = Number(rec.t) || 0, mine = store[p] !== undefined ? (meta.t[p] || 1) : (meta.d[p] || 0);
    if (t > mine){ store[p] = rec.d; meta.t[p] = t; delete meta.d[p]; ch = true; }
  });
  return ch;
}
async function syncBlobs(key, remote){
  var need = {}; Object.keys(store).forEach(function(p){ if (p.indexOf("services/") === 0 && store[p] && store[p].invoice) need[store[p].invoice] = 1; });
  var local = await allBlobs(), h = {"X-Sync-Key":key};
  for (var id in need){
    if (!/^[a-z0-9]{8,64}$/.test(id)) continue;
    if (local[id] && remote.indexOf(id) < 0){
      await fetch(SYNC_URL + "?a=blobput&id=" + id, {method:"POST", cache:"no-store", headers:h, body:await blobToB64(local[id])});
    } else if (!local[id] && remote.indexOf(id) >= 0){
      var r = await fetch(SYNC_URL + "?a=blobget&id=" + id, {method:"POST", cache:"no-store", headers:h});
      if (r.ok){
        var b = await b64ToBlob((await r.json()).data);
        await tx("readwrite", (function(blob, k){ return function(s){ return s.put(blob, k); }; })(b, id));
      }
    }
  }
}
async function syncNow(loud){
  var key = null; try { key = localStorage.getItem(SYNCKEY); } catch(e){}
  if (!key) return;
  if (syncing){ syncAgain = true; return; }
  syncing = true;
  if (loud) syncStatus("جارٍ المزامنة…");
  try {
    var docs = {};
    Object.keys(store).forEach(function(p){ if (SYNCPATH.test(p)) docs[p] = {t:meta.t[p] || 1, d:store[p]}; });
    var r = await syncCall(key, {docs:docs, dels:meta.d});
    if (r.status === 404){ try { localStorage.removeItem(SYNCKEY); } catch(e){} throw {gone:true}; }
    if (!r.ok) throw 0;
    var o = await r.json(), ch = applyRemote(o);
    persist(); if (ch){ msPull(); notify(); }
    await syncBlobs(key, o.blobs || []);
    var tf = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {hour:"numeric", minute:"2-digit"});
    syncStatus("المزامنة مفعّلة · آخر مزامنة " + tf.format(new Date()) + (ch ? " · وصلت بيانات جديدة" : ""));
  } catch(e){
    syncStatus(e && e.gone ? "رمز المزامنة لم يعد موجوداً على الخادم. فعّل المزامنة من جديد." : "المزامنة مؤجلة: لا يوجد اتصال الآن. ستُعاد المحاولة تلقائياً.");
  }
  syncing = false;
  if (syncAgain){ syncAgain = false; syncNow(); }
}
onDirty = function(){ clearTimeout(syncTimer); syncTimer = setTimeout(function(){ syncNow(); }, 2500); };
setTimeout(function(){ syncNow(); }, 1500);
setInterval(function(){ if (!document.hidden) syncNow(); }, 60000);
document.addEventListener("visibilitychange", function(){ if (!document.hidden) syncNow(); });
window.addEventListener("online", function(){ syncNow(); });

/* ---------- دمج نسخة احتياطية مع بيانات الجهاز: لا حذف ولا تكرار ---------- */
function mergeDocs(docs){
  var rep = {cars:0, fills:0, services:0, odo:0, skipped:0};
  function col(src, name){ var pre = name + "/", out = []; Object.keys(src).forEach(function(p){ if (p.indexOf(pre) === 0 && p.slice(pre.length).indexOf("/") < 0 && src[p] && typeof src[p] === "object") out.push({id:p.slice(pre.length), d:src[p]}); }); return out; }
  function norm(v){ return String(v == null ? "" : v).replace(/\s+/g, "").toLowerCase(); }
  function put(name, id, d){ var path = name + "/" + id; if (store[path] !== undefined) path = name + "/" + newId(); store[path] = clone(d); return path.split("/").pop(); }
  var map = {}, mine = col(store, "cars");
  col(docs, "cars").forEach(function(c){
    var hit = null;
    mine.forEach(function(m){
      if (hit) return;
      if ((m.id === c.id && !(norm(c.d.plate) && norm(m.d.plate) && norm(c.d.plate) !== norm(m.d.plate))) || (norm(c.d.vin) && norm(c.d.vin) === norm(m.d.vin)) || (norm(c.d.plate) && norm(c.d.plate) === norm(m.d.plate))) hit = m;
    });
    if (!hit){ var nid = put("cars", c.id, c.d); map[c.id] = nid; mine.push({id:nid, d:store["cars/" + nid]}); rep.cars++; rep.odo += (c.d.odoLog || []).length; return; }
    map[c.id] = hit.id;
    var t = store["cars/" + hit.id];
    ["make","model","year","color","vin","expiry","plate"].forEach(function(k){ if ((t[k] == null || t[k] === "") && c.d[k] != null && c.d[k] !== "") t[k] = c.d[k]; });
    var log = Array.isArray(t.odoLog) ? t.odoLog.slice() : [];
    (Array.isArray(c.d.odoLog) ? c.d.odoLog : []).forEach(function(p){
      if (!p || !(Number(p.o) > 0) || !p.t) return;
      if (log.some(function(q){ return Number(q.o) === Number(p.o) && String(q.t) === String(p.t); })) return;
      log.push({o:Number(p.o), t:String(p.t)}); rep.odo++;
    });
    log.sort(function(a, b){ return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
    if (log.length) t.odoLog = log.slice(-400);
    if (Number(c.d.odoNow) > 0 && !(Number(t.odoNow) >= Number(c.d.odoNow))){ t.odoNow = Number(c.d.odoNow); t.odoAt = c.d.odoAt || null; }
  });
  function carOf(d){ return d.carId ? (map[d.carId] || d.carId) : null; }
  var fl = col(store, "fills").map(function(x){ return x.d; });
  col(docs, "fills").forEach(function(f){
    var d = clone(f.d); d.carId = carOf(d);
    if (fl.some(function(x){ return (x.carId || null) === d.carId && ((d.odo != null && x.odo === d.odo) || (x.ts === d.ts && x.amount === d.amount)); })){ rep.skipped++; return; }
    put("fills", f.id, d); fl.push(d); rep.fills++;
  });
  var sv = col(store, "services");
  col(docs, "services").forEach(function(s){
    var d = clone(s.d); d.carId = carOf(d);
    var hit = null; sv.forEach(function(x){ if (!hit && (x.d.carId || null) === d.carId && x.d.itemId === d.itemId && x.d.odo === d.odo) hit = x; });
    if (hit){
      var t = store["services/" + hit.id];
      if (!t.invoice && d.invoice) t.invoice = d.invoice;
      if (t.cost == null && d.cost != null) t.cost = d.cost;
      rep.skipped++; return;
    }
    var nid = put("services", s.id, d); sv.push({id:nid, d:d}); rep.services++;
  });
  ["items", "settings"].forEach(function(name){
    col(docs, name).forEach(function(x){ if (store[name + "/" + x.id] === undefined) store[name + "/" + x.id] = clone(x.d); });
  });
  return rep;
}

/* ---------- التحديث من داخل البرنامج: لا يمسّ البيانات (localStorage و IndexedDB) ---------- */
async function latestVersion(){
  try {
    var t = await fetch("standalone.js?check=" + Date.now(), {cache:"no-store"}).then(function(r){ return r.ok ? r.text() : ""; });
    var m = t.match(/var VERSION = "([^"]+)"/);
    return m ? m[1] : "";
  } catch(e){ return ""; }
}
async function applyUpdate(){
  try {
    if (window.caches){ var ks = await caches.keys(); await Promise.all(ks.map(function(k){ return caches.delete(k); })); }
    if (navigator.serviceWorker){
      var regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(function(r){ return r.update().catch(function(){}); }));
    }
  } catch(e){}
  location.replace(location.pathname + "?u=" + Date.now());
}
function offerUpdate(latest){
  if (document.getElementById("upd-bar")) return;
  var bar = document.createElement("div"); bar.id = "upd-bar"; bar.setAttribute("role", "status");
  bar.style.cssText = "position:fixed;inset-inline:12px;bottom:12px;z-index:50;display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:500;box-shadow:0 6px 20px rgba(0,0,0,.25)";
  var sp = document.createElement("span"); sp.style.flex = "1"; sp.textContent = "نسخة جديدة متاحة (" + latest + "). بياناتك تبقى كما هي.";
  var b = document.createElement("button"); b.type = "button"; b.className = "btn sm"; b.textContent = "تحديث الآن";
  b.addEventListener("click", function(){ b.disabled = true; applyUpdate(); });
  bar.appendChild(sp); bar.appendChild(b); document.body.appendChild(bar);
}
/* تحديث تلقائي: عند فتح البرنامج أو العودة إليه تُحمَّل النسخة الأحدث مباشرة دون إعادة تثبيت. البيانات لا تتأثر.
   لا يُقاطَع إدخال جارٍ: إن كانت نافذة مفتوحة يُعرض شريط التحديث بدل ذلك */
async function checkUpdate(){
  var latest = await latestVersion();
  if (!latest || latest === VERSION) return;
  var tried = "", busy = document.querySelector("dialog[open]");
  try { var fr = document.querySelector("#exp-view iframe"); if (!busy && fr && fr.contentDocument) busy = fr.contentDocument.querySelector("dialog[open]"); } catch(e){}
  try { tried = sessionStorage.getItem("fuelapp-upd") || ""; } catch(e){}
  if (tried !== latest && !busy){ try { sessionStorage.setItem("fuelapp-upd", latest); } catch(e){} applyUpdate(); return; }
  offerUpdate(latest);
}
setTimeout(checkUpdate, 3000);
document.addEventListener("visibilitychange", function(){ if (!document.hidden) checkUpdate(); });
/* طلب تخزين دائم حتى لا يمسح النظام البيانات تلقائياً عند امتلاء الجهاز */
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function(){}); } catch(e){}

/* ---------- مصروفات المنزل ضمن المزامنة والنسخة الاحتياطية: تُحفظ نسخة منها كمستند واحد settings/masroof ----------
   صفحة مصروف البيت تحفظ بياناتها في هذا المتصفح، وهنا تُنسخ إلى مخزن البرنامج فترافق بيانات السيارة في المزامنة والتصدير، وتعود معها عند الاستعادة */
var MSKEY = "masroof-v1", MSPATH = "settings/masroof";
function msPush(){
  var raw = lsGet(MSKEY); if (!raw) return;
  if (store[MSPATH] && store[MSPATH].raw === raw) return;
  write(function(){ store[MSPATH] = {raw:raw}; touch(MSPATH); });
}
function msPull(){
  var d = store[MSPATH]; if (!d || typeof d.raw !== "string" || d.raw === lsGet(MSKEY)) return;
  try { localStorage.setItem(MSKEY, d.raw); } catch(e){}
}
window.addEventListener("storage", function(ev){ if (ev.key === MSKEY) msPush(); });
msPush();

/* ---------- برنامج واحد باسم «دفتر المصروف»: صفحة رئيسية بخيارين، «مصروفات السيارة» (هذا البرنامج ببياناته كما هي) و«مصروفات المنزل» (صفحة مصروف البيت) ----------
   لا يعمل عندما يكون هذا البرنامج نفسه معروضاً داخل صفحة أخرى، حتى لا يتداخل القسمان */
(function(){
  if (window.self !== window.top) return;
  try { document.title = APP_MODE === "budget" ? "دفتر المصروف" : "دفتر البنزين"; } catch(e){}
  try { var h1 = document.querySelector("h1"); if (APP_MODE === "budget" && h1 && h1.firstChild && h1.firstChild.nodeType === 3) h1.firstChild.nodeValue = "مصروفات السيارة"; } catch(e){}
  var css = document.createElement("style");
  css.textContent = "#app-tabs{position:fixed;left:0;right:0;bottom:0;display:grid;grid-template-columns:1fr 1fr 1fr;background:var(--surface);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom);z-index:5}" +
    "#app-tabs button{border:0;background:transparent;min-height:56px;font:inherit;font-weight:600;font-size:.95rem;color:var(--muted);cursor:pointer}" +
    "#app-tabs button[aria-current=page]{color:var(--accent);box-shadow:inset 0 3px 0 var(--accent)}" +
    "#exp-view,#app-home{position:fixed;top:0;left:0;right:0;bottom:calc(56px + env(safe-area-inset-bottom));background:var(--bg);z-index:4}" +
    "#exp-view iframe{width:100%;height:100%;border:0;display:block}" +
    "#app-home{overflow:auto;padding:28px 16px}" +
    "#app-home .in{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:14px}" +
    "#app-home h2{margin:0;font-size:1.9rem;line-height:1.3;color:var(--ink)}" +
    "#app-home p{margin:0;color:var(--muted)}" +
    "#app-home button{display:flex;flex-direction:column;gap:4px;text-align:start;font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px 18px;cursor:pointer;width:100%}" +
    "#app-home button b{font-size:1.3rem;color:var(--accent)}" +
    "#app-home button span{color:var(--muted);font-size:.95rem}" +
    "#home-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    "#home-stats .st{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:2px;min-width:0}" +
    "#home-stats .st.wide{grid-column:1 / -1}" +
    "#home-stats .st .k{color:var(--muted);font-size:.85rem}" +
    "#home-stats .st .v{font-size:1.55rem;font-weight:700;color:var(--ink);line-height:1.3;font-variant-numeric:tabular-nums}" +
    "#home-stats .st .v small{font-size:.8rem;font-weight:500;color:var(--muted)}" +
    "#home-stats .st .v.neg{color:var(--warn)}" +
    "#home-stats .st .u{color:var(--muted);font-size:.78rem}" +
    "#home-month{font-weight:600}" +
    ".hbar{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px}" +
    ".hbar .top{display:flex;justify-content:space-between;align-items:baseline;gap:10px}" +
    ".hbar .k{color:var(--muted);font-size:.85rem}" +
    ".hbar .lim{font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}" +
    ".hbar .track{height:14px;border-radius:999px;background:var(--line);overflow:hidden}" +
    ".hbar .fill{height:100%;width:0;border-radius:999px;background:var(--accent);transition:width .3s}" +
    ".hbar.over .fill{background:var(--warn)}" +
    ".hbar .ends{display:flex;justify-content:space-between;gap:10px;font-size:.92rem;font-variant-numeric:tabular-nums}" +
    ".hbar .ends b{color:var(--ink)}" +
    ".hbar.over .left b{color:var(--warn)}" +
    ".hbar .u{color:var(--muted);font-size:.78rem}" +
    "#app-home .adds{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    "#app-home .adds button{background:var(--accent);border-color:var(--accent);padding:16px 12px;align-items:center;text-align:center}" +
    "#app-home .adds button b{color:var(--accent-ink);font-size:1.05rem}" +
    "#app-home .adds button span{color:var(--accent-ink);opacity:.85;font-size:.8rem}" +
    "#app-home [data-det]{cursor:pointer}" +
    "#app-home [data-det]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}" +
    "#home-det-dlg{border:1px solid var(--line);border-radius:16px;padding:18px;background:var(--surface);color:var(--ink);width:min(94vw,460px);max-height:86vh}" +
    "#home-det-dlg::backdrop{background:rgba(0,0,0,.45)}" +
    "#home-det-dlg li.sb{padding-inline-start:14px;font-size:.92em;opacity:.9}" +
    "#home-det-dlg details.pd{margin:4px 0 0;border:1px solid var(--line);border-radius:12px;padding:4px 12px}#home-det-dlg details.pd summary{cursor:pointer;font-weight:600;padding:8px 0;color:var(--accent,inherit)}#home-det-dlg details.pd li:last-child{border-bottom:0}" +
    "#home-det-dlg h2{margin:0 0 10px;font-size:1.2rem}" +
    "#home-det-dlg ul{list-style:none;margin:0;padding:0;display:grid;gap:0}" +
    "#home-det-dlg li{display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--line)}" +
    "#home-det-dlg li:last-child{border-bottom:0}" +
    "#home-det-dlg li span{min-width:0}" +
    "#home-det-dlg li small{display:block;color:var(--muted);font-size:.82rem}" +
    "#home-det-dlg li b{white-space:nowrap;font-variant-numeric:tabular-nums}" +
    "#home-det-dlg li.sum{font-weight:700}" +
    "#home-det-dlg li{align-items:center}" +
    "#home-det-dlg .bb{display:flex;flex-direction:column;gap:5px;flex:none}" +
    "#home-det-dlg .buy.alt{background:var(--bg);color:var(--accent)}" +
    "#home-det-dlg .buy{flex:none;font:inherit;font-size:.85rem;font-weight:600;padding:7px 12px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer}" +
    "#home-det-dlg li.bad b{color:var(--warn)}" +
    "#home-det-dlg p{margin:10px 0 0;color:var(--muted);font-size:.86rem}" +
    "#home-det-dlg .x{margin-top:14px;width:100%;font:inherit;font-weight:600;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}" +
    "#home-add-dlg{border:1px solid var(--line);border-radius:16px;padding:18px;background:var(--surface);color:var(--ink);width:min(92vw,420px)}" +
    "#home-add-dlg::backdrop{background:rgba(0,0,0,.45)}" +
    "#home-add-dlg h2{margin:0 0 4px;font-size:1.2rem}" +
    "#home-add-dlg p{margin:0 0 12px;color:var(--muted);font-size:.9rem}" +
    "#home-add-dlg .opts{display:grid;gap:10px}" +
    "#home-add-dlg button{font:inherit;text-align:start;display:flex;flex-direction:column;gap:2px;width:100%;padding:14px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}" +
    "#home-add-dlg button b{color:var(--accent)}" +
    "#home-add-dlg button span{color:var(--muted);font-size:.85rem}" +
    "#home-add-dlg button.x{align-items:center;font-weight:600}" +
    "#app-home .secs{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
    "#app-home .secs button{padding:14px}" +
    "#app-home .secs button b{font-size:1.05rem}" +
    "#app-home .secs button span{font-size:.82rem}" +
    "#home-sync{border-radius:14px;padding:14px 16px;font-size:.92rem;line-height:1.6;border:1px solid var(--line);color:var(--ink);background:var(--surface)}" +
    "#home-sync.warn{background:var(--warn-soft);border-color:var(--warn)}" +
    "#app-home #home-sync button{display:inline-block;width:auto;margin-top:8px;padding:8px 14px;border-radius:10px;font-weight:600;font-size:.92rem;color:var(--accent)}" +
    "body{padding-bottom:calc(72px + env(safe-area-inset-bottom))}";
  document.head.appendChild(css);
  var home = document.createElement("div"), view = document.createElement("div"), frame = document.createElement("iframe"), nav = document.createElement("nav");
  home.id = "app-home";
  home.innerHTML = '<div class="in"><h2>دفتر المصروف</h2><div class="adds">' +
    '<button type="button" id="home-add-car"><b>إضافة مصروف السيارة</b><span>العداد ثم نوع المصروف</span></button>' +
    '<button type="button" id="home-add-exp"><b>إضافة مصروف المنزل</b><span>اختر نوع المصروف</span></button></div>' +
    '<div id="home-day" class="hbar" data-det="day" role="button" tabindex="0"><div class="top"><span class="k">الحد اليومي بعد التوزيع (المنزل + السيارة)</span><span class="lim" id="hd-lim">—</span></div>' +
    '<div class="track" id="hd-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="المصروف من الحد اليومي"><div class="fill" id="hd-fill"></div></div>' +
    '<div class="ends"><span id="hd-spent">المحسوب على اليوم <b>—</b></span><span id="hd-left" class="left">الباقي <b>—</b></span></div><span class="u" id="hd-u"></span></div>' +
    '<div id="home-act" class="hbar" data-det="day" role="button" tabindex="0"><div class="top"><span class="k">المدفوع الفعلي اليوم (المنزل + السيارة)</span><span class="lim" id="ha-lim">—</span></div>' +
    '<div class="track" id="ha-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="المدفوع فعلياً من الحد اليومي"><div class="fill" id="ha-fill"></div></div>' +
    '<div class="ends"><span id="hd-paid">المدفوع فعلياً <b>—</b></span><span id="hd-aleft" class="left">المتبقي الفعلي <b>—</b></span></div><span class="u">ما خرج من الجيب اليوم مقارنةً بالحد اليومي، بلا توزيع على الأيام</span></div>' +
    '<div id="home-mon" class="hbar" data-det="mon" role="button" tabindex="0"><div class="top"><span class="k">حد الشهر (المنزل + السيارة)</span><span class="lim" id="hm-lim">—</span></div>' +
    '<div class="track" id="hm-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="المصروف من حد الشهر"><div class="fill" id="hm-fill"></div></div>' +
    '<div class="ends"><span id="hm-spent">مصروف الشهر <b>—</b></span><span id="hm-left" class="left">الباقي <b>—</b></span></div><span class="u" id="hm-u"></span></div>' +
    '<p id="home-month"></p>' +
    '<div id="home-stats">' +
    '<div class="st wide" data-det="stock" role="button" tabindex="0"><span class="k">مدة كفاية المشتريات</span><span class="v" id="hs-stock">—</span><span class="u" id="hs-stock-u">اضغط لعرض الأصناف</span></div>' +
    '<div class="st" data-det="fuel" role="button" tabindex="0"><span class="k">بنزين الشهر</span><span class="v" id="hs-fuel">—</span><span class="u" id="hs-fuel-u">ريال</span></div>' +
    '<div class="st" data-det="km" role="button" tabindex="0"><span class="k">الممشى خلال الشهر</span><span class="v" id="hs-km">—</span><span class="u" id="hs-km-u">كم</span></div>' +
    '<div class="st wide" data-det="since" role="button" tabindex="0"><span class="k">الممشى منذ آخر تعبئة بنزين</span><span class="v" id="hs-since">—</span><span class="u" id="hs-since-u">كم</span></div>' +
    '</div><div class="secs">' +
    '<button type="button" id="home-car"><b>مصروفات السيارة</b><span>البنزين والصيانة والعداد</span></button>' +
    '<button type="button" id="home-exp"><b>مصروفات المنزل</b><span>البنود وحدودها الشهرية</span></button></div><div id="home-sync" role="status"></div></div>';
  view.id = "exp-view"; view.hidden = true; frame.title = "مصروفات المنزل"; view.appendChild(frame);
  nav.id = "app-tabs"; nav.setAttribute("aria-label", "أقسام البرنامج");
  nav.innerHTML = '<button type="button" id="tab-home">الرئيسية</button><button type="button" id="tab-car">السيارة</button><button type="button" id="tab-exp">المنزل</button>';
  document.body.appendChild(home); document.body.appendChild(view); document.body.appendChild(nav);
  function show(v){
    if (v === "exp" && !frame.getAttribute("src")) frame.setAttribute("src", "../masroof/");
    home.hidden = v !== "home"; view.hidden = v !== "exp";
    if (v === "home"){ syncCard(); stats(); }
    ["home", "car", "exp"].forEach(function(k){ document.getElementById("tab-" + k).setAttribute("aria-current", k === v ? "page" : "false"); });
    if (v === "car") window.scrollTo(0, 0);
    if (window.__shellHook) window.__shellHook(v);
  }
  ["home", "car", "exp"].forEach(function(k){ document.getElementById("tab-" + k).addEventListener("click", function(){ show(k); }); });
  document.getElementById("home-car").addEventListener("click", function(){ show("car"); });
  document.getElementById("home-exp").addEventListener("click", function(){ show("exp"); });
  /* حالة النسخ التلقائي على الخادم: تنبيه واضح ما دامت البيانات على هذا الجهاز فقط */
  function syncCard(){
    var box = document.getElementById("home-sync"), on = !!lsGet(SYNCKEY);
    box.className = on ? "" : "warn";
    box.innerHTML = on ? "النسخ التلقائي مفعّل: بيانات السيارة والمنزل تُحفظ أيضاً على خادم الموقع، وتعود برمزك إن حُذف التطبيق."
      : 'بياناتك محفوظة على هذا الجهاز فقط، وتضيع إن حُذف التطبيق. فعّل النسخ التلقائي برمز خاص بك لتُحفظ على خادم الموقع.<br><button type="button" id="home-sync-go">تفعيل النسخ التلقائي</button>';
    var go = document.getElementById("home-sync-go");
    if (go) go.addEventListener("click", function(){
      show("car");
      try { var f = document.getElementById("sa-sync"); f.closest("details").open = true; f.scrollIntoView({block:"center"}); f.focus(); } catch(e){}
    });
  }
  /* إحصاءات الصفحة الرئيسية: مصروف الشهر والباقي (من قسم المنزل)، وبنزين الشهر والممشى (من قسم السيارة) */
  var MSSUM = "masroof-summary";
  function el(id){ return document.getElementById(id); }
  function n0(x){ return Number(x).toLocaleString("en-US", {maximumFractionDigits:0}); }
  var det = {};
  function dm(d){ return Number(String(d).slice(8,10)) + "/" + Number(String(d).slice(5,7)); }
  function n2(x){ return Number(x).toLocaleString("en-US", {minimumFractionDigits:0, maximumFractionDigits:2}); }
  function stats(){
    try {
      det = {};
      var now = new Date(), ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      try { el("home-month").textContent = "إحصاءات " + new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {month:"long", year:"numeric"}).format(now); } catch(e){}
      var s = null; try { s = JSON.parse(lsGet(MSSUM) || "null"); } catch(e){}
      var tdy = ym + "-" + String(now.getDate()).padStart(2, "0"), box = el("home-day");
      if (s && s.d === tdy && s.dayLimit != null){
        var L = Number(s.dayLimit), sp = Number(s.daySpent) || 0, lf = L - sp, pc = L > 0 ? Math.min(100, sp / L * 100) : (sp > 0 ? 100 : 0);
        el("hd-lim").textContent = n0(L) + " ريال";
        el("hd-fill").style.width = pc + "%"; el("hd-track").setAttribute("aria-valuenow", String(Math.round(pc)));
        box.className = lf < -0.005 ? "hbar over" : "hbar";
        el("hd-spent").innerHTML = "المحسوب على اليوم <b>" + n0(sp) + "</b>";
        var pd = Number(s.dayPaid) || 0, al = L - pd;
        var apc = L > 0 ? Math.min(100, pd / L * 100) : (pd > 0 ? 100 : 0);
        el("ha-lim").textContent = n0(L) + " ريال"; el("ha-fill").style.width = apc + "%"; el("ha-track").setAttribute("aria-valuenow", String(Math.round(apc)));
        el("home-act").className = al < -0.005 ? "hbar over" : "hbar";
        el("hd-paid").innerHTML = "المدفوع فعلياً <b>" + n0(pd) + "</b>";
        el("hd-aleft").innerHTML = al < -0.005 ? "تجاوز فعلي <b>" + n0(-al) + "</b>" : "المتبقي الفعلي <b>" + n0(al) + "</b>";
        el("hd-left").innerHTML = lf < -0.005 ? "تجاوز <b>" + n0(-lf) + "</b>" : "الباقي <b>" + n0(lf) + "</b>";
        el("hd-u").textContent = "الباقي من ميزانية الشهر مقسوماً على " + s.daysLeft + (s.daysLeft > 10 ? " يوماً" : s.daysLeft > 2 ? " أيام" : s.daysLeft === 2 ? " يومين" : " يوم") + " باقية";
      } else {
        el("hd-lim").textContent = "—"; el("hd-fill").style.width = "0"; box.className = "hbar";
        el("hd-spent").innerHTML = "المحسوب على اليوم <b>—</b>"; el("hd-paid").innerHTML = "المدفوع فعلياً <b>—</b>"; el("hd-aleft").innerHTML = "المتبقي الفعلي <b>—</b>"; el("ha-lim").textContent = "—"; el("ha-fill").style.width = "0"; el("home-act").className = "hbar"; el("hd-left").innerHTML = "الباقي <b>—</b>"; el("hd-u").textContent = "يظهر بعد تحميل قسم المنزل";
      }
      det.s = s && s.m === ym ? s : null; det.today = tdy;
      var stk = det.s && det.s.d === tdy && det.s.stock ? det.s.stock : null;
      if (stk){
        var ended = stk.filter(function(x){ return x.left <= 0; }).length, soon = stk.filter(function(x){ return x.left > 0 && x.left <= 2; }).length;
        var hv = stk.filter(function(x){ return x.left > 0; }).length;
        el("hs-stock").innerHTML = stk.length ? n0(hv) + ' <small>متوفر</small> · ' + n0(ended) + ' <small>ناقص</small>' : "—";
        el("hs-stock").className = "v" + (ended || soon ? " neg" : "");
        el("hs-stock-u").textContent = !stk.length ? "يظهر بعد تسجيل مشتريات بكمياتها" : (soon ? soon + " ينتهي خلال يومين" : ended ? "يوجد ناقص للشراء" : "كلها كافية حالياً") + " · اضغط للتفاصيل";
      } else { el("hs-stock").textContent = "—"; el("hs-stock").className = "v"; el("hs-stock-u").textContent = "يظهر بعد تحميل قسم المنزل"; }
      var mb = el("home-mon");
      if (s && s.m === ym){
        var ML = Number(s.income) || 0, msp = Number(s.spent) || 0, mlf = ML - msp, mpc = ML > 0 ? Math.min(100, msp / ML * 100) : (msp > 0 ? 100 : 0);
        el("hm-lim").textContent = n0(ML) + " ريال";
        el("hm-fill").style.width = mpc + "%"; el("hm-track").setAttribute("aria-valuenow", String(Math.round(mpc)));
        mb.className = mlf < -0.005 ? "hbar over" : "hbar";
        el("hm-spent").innerHTML = "مصروف الشهر <b>" + n0(msp) + "</b>";
        el("hm-left").innerHTML = mlf < -0.005 ? "تجاوز <b>" + n0(-mlf) + "</b>" : "الباقي <b>" + n0(mlf) + "</b>";
        el("hm-u").textContent = s.from ? "يُحسب من " + Number(s.from.slice(8)) + "/" + Number(s.from.slice(5,7)) + " إلى نهاية الشهر" : "";
      } else {
        el("hm-lim").textContent = "—"; el("hm-fill").style.width = "0"; mb.className = "hbar";
        el("hm-spent").innerHTML = "مصروف الشهر <b>—</b>"; el("hm-left").innerHTML = "الباقي <b>—</b>"; el("hm-u").textContent = "يظهر بعد تحميل قسم المنزل";
      }
      /* بيانات السيارة تُقرأ من المخزن مباشرة: التعبئات والصيانة وقراءات العداد للسيارة الحالية */
      var fills = [], svcs = [], carIds = [];
      Object.keys(store).forEach(function(k){
        var v = store[k]; if (!v || typeof v !== "object") return;
        if (k.indexOf("fills/") === 0) fills.push(v); else if (k.indexOf("services/") === 0) svcs.push(v); else if (k.indexOf("cars/") === 0) carIds.push(k.slice(5));
      });
      var fm = 0, fc = 0; fills.forEach(function(f){ if (String(f.ts).slice(0,7) === ym){ fm += Number(f.amount) || 0; fc++; } });
      det.fills = fills.filter(function(f){ return String(f.ts).slice(0,7) === ym; }).sort(function(a, b){ return String(a.ts) < String(b.ts) ? 1 : -1; });
      det.carName = function(id){ var c = store["cars/" + id]; return c ? ([c.make, c.model].filter(Boolean).join(" ") || "سيارة") : ""; }; det.manyCars = carIds.length > 1;
      el("hs-fuel").textContent = n0(fm); el("hs-fuel-u").textContent = "ريال · " + (fc ? fc + (fc === 1 ? " تعبئة" : " تعبئات") : "لا تعبئات بعد");
      var cur = lsGet("fuel-cur-car"); if (carIds.indexOf(cur) < 0) cur = carIds.sort()[0] || null;
      var car = cur ? store["cars/" + cur] : null, tag = car && carIds.length > 1 ? " · " + ([car.make, car.model].filter(Boolean).join(" ") || "سيارة") : "";
      var mine = function(x){ return x.carId === cur && x.odo != null && isFinite(Number(x.odo)); }, raw = [];
      fills.filter(mine).forEach(function(f){ raw.push({d:String(f.ts).slice(0,10), o:Number(f.odo), ts:String(f.ts)}); });
      svcs.filter(mine).forEach(function(x){ raw.push({d:String(x.ts).slice(0,10), o:Number(x.odo), ts:String(x.ts)}); });
      if (car){
        (car.odoLog || []).forEach(function(q){ raw.push({d:String(q.t).slice(0,10), o:Number(q.o), ts:String(q.t)}); });
        if (car.odoNow != null && car.odoAt) raw.push({d:String(car.odoAt).slice(0,10), o:Number(car.odoNow), ts:String(car.odoAt)});
      }
      det.hasCar = !!car;
      var byDay = {}; raw.forEach(function(q){ if (/^\d{4}-\d\d-\d\d$/.test(q.d) && (byDay[q.d] == null || q.o > byDay[q.d])) byDay[q.d] = q.o; });
      det.odoToday = byDay[tdy] != null;
      /* أوقات قراءات اليوم بالدقائق من منتصف الليل (القراءة بلا وقت تُعدّ صباحية) */
      det.odoMins = raw.map(function(q){ if (q.ts.length <= 10) return q.d === tdy ? 0 : -1; var dt = new Date(q.ts); if (isNaN(dt.getTime())) return q.d === tdy ? 0 : -1;
        var ld = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0"); return ld === tdy ? dt.getHours() * 60 + dt.getMinutes() : -1; }).filter(function(x){ return x >= 0; });
      var pts = []; Object.keys(byDay).sort().forEach(function(d){ if (!pts.length || byDay[d] >= pts[pts.length - 1].o) pts.push({d:d, o:byDay[d], t:new Date(d + "T12:00").getTime()}); });
      function odoAt(t){
        if (t <= pts[0].t) return pts[0].o;
        for (var i = 1; i < pts.length; i++){ if (t <= pts[i].t){ var A = pts[i - 1], B = pts[i]; return A.o + (B.o - A.o) * (t - A.t) / (B.t - A.t); } }
        return pts[pts.length - 1].o;
      }
      var m0 = new Date(now.getFullYear(), now.getMonth(), 1, 12).getTime(), km = null, est = false, fromDay = null;
      if (pts.length){
        var last = pts[pts.length - 1];
        if (last.t < m0) km = 0;
        else if (pts[0].t >= m0){ km = last.o - pts[0].o; fromDay = pts[0].d; }
        else { km = last.o - odoAt(m0); est = !pts.some(function(q){ return q.t === m0; }); }
      }
      det.km = {pts:pts, m0:m0, km:km, est:est, fromDay:fromDay, base:pts.length && km != null ? pts[pts.length - 1].o - km : null, tag:tag};
      el("hs-km").textContent = km != null ? n0(Math.max(0, km)) : "—";
      el("hs-km-u").textContent = (km == null ? "كم · يظهر بعد تسجيل العداد" : est ? "كم · تقديري من قراءات العداد" : fromDay ? "كم · منذ " + Number(fromDay.slice(8)) + "/" + Number(fromDay.slice(5,7)) : "كم") + tag;
      var lastF = null; fills.filter(mine).forEach(function(f){ if (!lastF || String(f.ts) > String(lastF.ts)) lastF = f; });
      var top = pts.length ? pts[pts.length - 1].o : null; raw.forEach(function(q){ if (top == null || q.o > top) top = q.o; });
      var since = lastF && top != null ? Math.max(0, top - Number(lastF.odo)) : null;
      det.since = {f:lastF, top:top, since:since, topDay:pts.length ? pts[pts.length - 1].d : null, tag:tag};
      el("hs-since").textContent = since != null ? n0(since) : "—";
      el("hs-since-u").textContent = (lastF ? "كم · العداد الآن " + n0(top) + "، وعند آخر تعبئة " + n0(lastF.odo) : "كم · يظهر بعد أول تعبئة") + tag;
    } catch(e){}
  }
  window.addEventListener("storage", function(ev){ if (ev.key === MSSUM) stats(); });
  /* إضافة مصروف من الصفحة الرئيسية.
     السيارة: تُسجَّل قراءة العداد أولاً (بالكاميرا أو صورة من الاستوديو أو يدوياً) ثم يُختار نوع المصروف: تعبئة بنزين أو صيانة.
     المنزل: تُفتح نافذة تسجيل المصروف في قسم المنزل وفيها اختيار البند. */
  /* نافذة تفاصيل كل إحصائية في الصفحة الرئيسية */
  var detDlg = document.createElement("dialog"); detDlg.id = "home-det-dlg"; detDlg.setAttribute("aria-labelledby", "home-det-h");
  detDlg.innerHTML = '<h2 id="home-det-h"></h2><div id="home-det-b"></div><button type="button" class="x" id="home-det-x">إغلاق</button>';
  document.body.appendChild(detDlg);
  el("home-det-x").addEventListener("click", function(){ detDlg.close(); });
  /* «تسجيل شراء» لصنف ناقص: يفتح نافذة المصروف في قسم المنزل والصنف مختار */
  detDlg.addEventListener("click", function(ev){
    var hb = ev.target.closest("button[data-have]");
    if (hb){
      /* «متوفر عندي»: تُفتح نافذته في قسم المنزل للسلعة نفسها */
      var hid = hb.dataset.have, n = 0; detDlg.close(); show("exp");
      (function goH(){
        var d = null; try { d = frame.contentWindow.document; } catch(e){}
        var o = d && d.readyState === "complete" ? d.querySelector('#stock button[data-have="' + hid + '"]') : null;
        if (!o){ if (++n < 40) setTimeout(goH, 150); return; }
        o.click();
      })();
      return;
    }
    var b = ev.target.closest("button[data-buy]"); if (!b) return;
    var id = b.dataset.buy; detDlg.close(); show("exp");
    var tries = 0;
    (function go(){
      var d = null; try { d = frame.contentWindow.document; } catch(e){}
      var o = d && d.readyState === "complete" ? d.getElementById("add-open") : null;
      if (!o){ if (++tries < 40) setTimeout(go, 150); return; }
      o.click();
      try {
        var W = frame.contentWindow, c = d.getElementById("a-cat"), it = d.getElementById("a-item");
        c.value = "food"; c.dispatchEvent(new W.Event("change", {bubbles:true}));
        it.value = id; it.dispatchEvent(new W.Event("change", {bubbles:true}));
      } catch(e){}
    })();
  });
  function li(a, sub, v, cls){ return '<li' + (cls ? ' class="' + cls + '"' : '') + '><span>' + esc(a) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span><b>' + esc(v) + '</b></li>'; }
  function esc(x){ return String(x).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  /* المتاح لكل يوم من الأيام السبعة القادمة: الحد اليومي ناقص نصيب ذلك اليوم من المشتريات الموزّعة */
  function weekHtml(s){
    var w = s.week; if (!w || !w.length) return "";
    var L = Number(s.dayLimit) || 0, tot = 0, b = new Date(s.d + "T12:00"), wd = ["الأحد","الإثنين","الثلاثاء","الأربعاء","الخميس","الجمعة","السبت"];
    var h = '<h2 style="margin-top:16px;font-size:1.05rem">المتاح خلال ' + (w.length === 7 ? "أسبوع" : w.length === 1 ? "آخر يوم في الشهر" : w.length === 2 ? "يومين" : w.length + " أيام") + '</h2><ul>' + w.map(function(c, j){
      var d = new Date(b.getTime() + j * 86400000), a = L - c; tot += a;
      return li(j === 0 ? "اليوم" : j === 1 ? "غداً" : wd[d.getDay()] + " " + d.getDate() + "/" + (d.getMonth() + 1), c > 0.005 ? "محجوز " + n2(c) + " من مصروفات موزّعة" : "لا شيء محجوز", n2(Math.abs(a)) + (a < -0.005 ? " تجاوز" : ""), a < -0.005 ? "bad" : ""); }).join("") +
      li("مجموع المتاح", "", n2(tot) + " ريال", tot < 0 ? "sum bad" : "sum") + '</ul><p>الحد يبقى ' + n2(L) + ' كل يوم إن صرفت بقدره؛ يرتفع إن وفّرت وينخفض إن تجاوزت.' + (w.length < 7 ? " بقية الأسبوع في الشهر القادم." : "") + '</p>';
    return h;
  }
  function showDet(kind){
    stats();
    var t = "", h = "", s = det.s, none = '<p>لا توجد بيانات بعد.</p>';
    if (kind === "day"){
      t = "تفاصيل الحد اليومي";
      if (s && s.d === det.today && s.dayLimit != null){
        var rows = (s.dayRows || []).slice().sort(function(a, b){ return b.s - a.s; }), cl = s.cashLimit != null ? Number(s.cashLimit) : Number(s.dayLimit);
        h = '<ul>' + li("ميزانية الشهر", "", n2(s.income) + " ريال") + li("المحسوب على الأيام السابقة", "", n2(s.before || 0) + " ريال") + (s.swept > 0 ? li("المتبقي الفعلي للأيام السابقة", "حُوّل إلى «" + s.sweepN + "» وحُسب كأنه صُرف", n2(s.swept) + " ريال") : "") + li("الأيام الباقية ومنها اليوم", "", String(s.daysLeft)) + li("الحد اليومي", "(الميزانية − السابق) ÷ الأيام الباقية", n2(s.dayLimit) + " ريال", "sum") + '</ul>' + weekHtml(s) +
          '<h2 style="margin-top:16px;font-size:1.05rem">المحسوب على اليوم</h2>' + (rows.length ? '<ul>' + rows.map(function(r){
            return li(r.n, r.k > 1 ? "من " + n2(r.a) + " ريال بتاريخ " + dm(r.d) + " · اليوم " + r.i + " من " + r.k : "مدفوع اليوم", n2(r.s)); }).join("") +
            li("المجموع", "", n2(s.daySpent) + " ريال", "sum") + li(s.dayLimit - s.daySpent < 0 ? "تجاوز" : "الباقي لليوم", "", n2(Math.abs(s.dayLimit - s.daySpent)) + " ريال", s.dayLimit - s.daySpent < 0 ? "sum bad" : "sum") + '</ul>' : '<p>لا شيء محسوب على اليوم.</p>') +
          '<h2 style="margin-top:16px;font-size:1.05rem">المدفوع فعلياً اليوم</h2><ul>' + rows.filter(function(r){ return r.d === det.today; }).map(function(r){ return li(r.n, r.k > 1 ? "يكفي " + (r.k === 2 ? "يومين" : r.k + (r.k > 10 ? " يوماً" : " أيام")) + " من الشهر" : "", n2(r.a)); }).join("") + li("المجموع", "ما خرج من الجيب بتاريخ اليوم", n2(s.dayPaid || 0) + " ريال", "sum") + li("الحد النقدي لليوم", "(الميزانية − المدفوع قبل اليوم − المحوَّل) ÷ الأيام الباقية", n2(cl) + " ريال") + li(cl - (s.dayPaid || 0) < 0 ? "تجاوز فعلي" : "المتبقي الفعلي", "الحد النقدي − المدفوع فعلياً" + (s.sweepN && cl - (s.dayPaid || 0) > 0 ? " · يتحول في نهاية اليوم إلى «" + s.sweepN + "»" : ""), n2(Math.abs(cl - (s.dayPaid || 0))) + " ريال", cl - (s.dayPaid || 0) < 0 ? "sum bad" : "sum") + '</ul>' +
          '<p>المشتريات التي تكفي أكثر من يوم يُحسب منها نصيب كل يوم فقط.</p>';
      } else h = none;
    } else if (kind === "mon"){
      t = "تفاصيل المتاح هذا الشهر";
      if (s){
        var rs = s.res || [], held = rs.reduce(function(a, r){ return a + (Number(r.per) || 0); }, 0) + (Number(s.rmv) || 0), H2 = function(x){ return '<h2 style="margin-top:16px;font-size:1.05rem">' + x + '</h2>'; };
        var cs = (s.cats || []).filter(function(c){ return c.s > 0 || c.l > 0; }), paid = s.spent - (Number(s.swept) || 0), restSum = cs.reduce(function(a, c){ return a + (c.l - c.s); }, 0), free = s.left - restSum, pr = (s.rows || []).filter(function(r){ return !r.r; });
        /* أولاً: المدفوع فعلياً، ثم توزيع الباقي على البنود ومبلغ كل بند */
        h = '<ul>' + li("المدفوع فعلياً هذا الشهر", "ما خرج من الجيب منذ بداية الشهر", n2(paid) + " ريال", "sum") +
          (s.swept > 0 ? li("المتبقي الفعلي المحوَّل", "إلى «" + s.sweepN + "» ويُحسب كأنه صُرف", n2(s.swept) + " ريال") : "") + '</ul>' +
          /* تفاصيل المدفوع فعلياً: كل عملية بتاريخها وبندها ومبلغها */
          (pr.length ? '<details class="pd"' + (pr.length <= 6 ? " open" : "") + '><summary>تفاصيل المدفوع (' + (pr.length === 1 ? "عملية واحدة" : pr.length === 2 ? "عمليتان" : pr.length + (pr.length > 10 ? " عملية" : " عمليات")) + ')</summary><ul>' +
            pr.map(function(r){ return li(r.n, dm(r.d) + " · " + (r.x ? "السيارة" : r.c) + (r.f ? " · من أصل " + n2(r.f) : ""), n2(r.a)); }).join("") + li("المجموع", "", n2(pr.reduce(function(a, r){ return a + r.a; }, 0)) + " ريال", "sum") + '</ul></details>' : '<p>لا توجد مدفوعات مسجّلة هذا الشهر.</p>') +
          H2("الباقي موزّع على البنود") + '<ul>' + cs.map(function(c){ var r = c.l - c.s, over = r < -0.005; return li(c.n, "الحد " + n2(c.l) + " · صُرف " + n2(c.s), (over ? "تجاوز " : "") + n2(Math.abs(r)), over ? "bad" : "") +
            /* فروع البند (طعام، مستلزمات، بقالة): باقي كل فرع */
            (c.sub || []).map(function(x){ var xr = x.l - x.s, xo = xr < -0.005; return li("↳ " + x.n, "الحد " + n2(x.l) + " · صُرف " + n2(x.s), (xo ? "تجاوز " : "") + n2(Math.abs(xr)), xo ? "sb bad" : "sb"); }).join(""); }).join("") +
          (Math.abs(free) > 0.5 ? li(free > 0 ? "غير موزّع على بند" : "حدود البنود تزيد على المتاح", free > 0 ? "متاح في الشهر خارج حدود البنود" : "مجموع الحدود أكبر من ميزانية الشهر", n2(Math.abs(free)), free > 0 ? "" : "bad") : "") +
          li(s.left < 0 ? "تجاوز ميزانية الشهر" : "المتاح هذا الشهر", "ميزانية الشهر " + n2(s.income) + " − المصروف " + n2(s.spent), n2(Math.abs(s.left)) + " ريال", s.left < 0 ? "sum bad" : "sum") + '</ul>' +
          /* بنود المبلغ المحجوز: كم خُصم لكل حجز هذا الشهر، وكم تجمّع له */
          (rs.length ? H2("المحجوز من دخل الشهر") + '<ul>' + li("الدخل قبل الحجز", "", n2(s.income + held) + " ريال") + rs.map(function(r){
            var du = r.due ? " · يحل " + dm(r.due) : "", sub = r.per > 0 || r.saved > 0 ? "المتجمع " + n2(r.saved) + (r.e === 1 ? "" : " من " + n2(r.a)) + du + (r.sw && s.swept > 0 ? " · منه فائض الأيام " + n2(s.swept) : "") + (r.pre > 0 ? " · منه " + n2(r.pre) + " مدّخر خارج البرنامج" : "") : "يبدأ الحجز في شهر " + Number(String(r.st).slice(5,7)) + du;
            return li(r.n, sub, r.per > 0 ? "− " + n2(r.per) : "—"); }).join("") +
            (s.rmv > 0 ? li("محوَّل من باقي البنود", "تحويلات هذا الشهر إلى المحجوز", "− " + n2(s.rmv)) : "") +
            li("مجموع المحجوز هذا الشهر", "", n2(held) + " ريال", "sum") + li("ميزانية الشهر", "الدخل − المحجوز" + (s.from ? " · تُحسب من " + dm(s.from) : ""), n2(s.income) + " ريال", "sum") + '</ul>' : "");
      } else h = none;
    } else if (kind === "stock"){
      t = "مدة كفاية المشتريات";
      var st = s && s.d === det.today && s.stock ? s.stock : [];
      var row = function(x, buy){
        var w = x.left <= 0 ? (x.left === 0 ? "انتهى أمس" : "انتهى منذ " + (-x.left + 1 === 2 ? "يومين" : (-x.left + 1) + (-x.left + 1 > 10 ? " يوماً" : " أيام"))) : x.left === 1 ? "آخر يوم" : x.left === 2 ? "باقي يومان" : "باقي " + x.left + (x.left > 10 ? " يوماً" : " أيام");
        return '<li' + (x.left <= 2 ? ' class="bad"' : '') + '><span>' + esc(x.n + (x.q ? " " + x.q : "")) + '<small>' + esc(x.nv ? "سلعة رئيسية · لم يُسجَّل شراؤها" : (x.car ? "بتاريخ " : x.hv ? "متوفر من قبل · سُجّل " : "اشتُري ") + dm(x.d) + (x.car ? " · تقديراً حتى " : " · يكفي حتى ") + dm(x.end)) + '</small></span>' +
          (buy && x.id ? '<span class="bb">' + (x.nv && x.once ? '<button type="button" class="buy alt" data-have="' + esc(x.id) + '">متوفر عندي</button>' : '') + '<button type="button" class="buy" data-buy="' + esc(x.id) + '">تسجيل شراء</button></span>' : '<b>' + esc(w) + '</b>') + '</li>';
      };
      var have = st.filter(function(x){ return x.left > 0; }), miss = st.filter(function(x){ return x.left <= 0; }).sort(function(a, b){ return b.left - a.left; });
      h = st.length ? '<h2 style="font-size:1.05rem">المتوفر (' + have.length + ')</h2>' + (have.length ? '<ul>' + have.map(function(x){ return row(x, false); }).join("") + '</ul>' : '<p>لا يوجد صنف متوفر حالياً.</p>') +
        '<h2 style="margin-top:16px;font-size:1.05rem">الناقص — قائمة الشراء (' + miss.length + ')</h2>' + (miss.length ? '<ul>' + miss.map(function(x){ return row(x, true); }).join("") + '</ul>' : '<p>لا يوجد صنف ناقص.</p>') +
        '<p>الصنف ينزل إلى قائمة الناقص عند انتهاء مدة كفايته، ويعود إلى المتوفر عند تسجيل شرائه. البنزين والصيانة تقديرية.</p>' : '<p>لا توجد مشتريات مسجّلة بكمياتها بعد. سجّل مصروفاً في «الطعام ومستلزمات البيت» واختر الصنف والكمية.</p>';
    } else if (kind === "fuel"){
      t = "تعبئات البنزين هذا الشهر";
      var f = det.fills || [], tot = 0, lit = 0;
      h = f.length ? '<ul>' + f.map(function(x){
        var a = Number(x.amount) || 0, L = Number(x.liters) > 0 ? Number(x.liters) : (Number(x.price) > 0 ? a / Number(x.price) : 0); tot += a; lit += L;
        return li(dm(x.ts) + (det.manyCars ? " · " + det.carName(x.carId) : ""), (L > 0 ? n2(Math.round(L * 10) / 10) + " لتر" : "") + (x.odo != null ? (L > 0 ? " · " : "") + "العداد " + n0(x.odo) : ""), n2(a)); }).join("") +
        li("المجموع", (f.length === 1 ? "تعبئة واحدة" : f.length === 2 ? "تعبئتان" : f.length + " تعبئات") + (lit > 0 ? " · " + n2(Math.round(lit * 10) / 10) + " لتر" : ""), n2(tot) + " ريال", "sum") + '</ul>' : '<p>لا توجد تعبئات مسجّلة هذا الشهر.</p>';
    } else if (kind === "km"){
      t = "تفاصيل الممشى خلال الشهر"; var k = det.km;
      if (k && k.km != null && k.pts.length){
        var inM = k.pts.filter(function(p){ return p.t >= k.m0; }), last = k.pts[k.pts.length - 1];
        h = '<ul>' + li(k.fromDay ? "أول قراءة في الشهر" : "العداد أول الشهر", k.fromDay ? dm(k.fromDay) : (k.est ? "تقديري بين أقرب قراءتين" : "قراءة مسجّلة"), n0(k.base)) +
          inM.filter(function(p){ return !(k.fromDay && p.d === k.fromDay); }).map(function(p){ return li("قراءة " + dm(p.d), "", n0(p.o)); }).join("") +
          li("الممشى خلال الشهر", "آخر قراءة − " + (k.fromDay ? "أول قراءة" : "عداد أول الشهر"), n0(Math.max(0, k.km)) + " كم", "sum") + '</ul>' +
          (k.tag ? '<p>السيارة' + esc(k.tag.replace(" ·", ":")) + '</p>' : '') + (k.est ? '<p>لا توجد قراءة في أول يوم من الشهر، فقُدّر العداد حينها من القراءتين قبله وبعده.</p>' : '');
      } else h = '<p>يظهر بعد تسجيل قراءات العداد.</p>';
    } else if (kind === "since"){
      t = "الممشى منذ آخر تعبئة"; var q = det.since;
      if (q && q.f && q.since != null){
        var days = q.topDay ? Math.max(0, Math.round((new Date(q.topDay + "T12:00") - new Date(String(q.f.ts).slice(0,10) + "T12:00")) / 86400000)) : 0;
        h = '<ul>' + li("آخر تعبئة", dm(q.f.ts) + (Number(q.f.amount) > 0 ? " · " + n2(q.f.amount) + " ريال" : ""), n0(q.f.odo)) + li("العداد الآن", q.topDay ? "آخر قراءة " + dm(q.topDay) : "", n0(q.top)) +
          li("الممشى منذ التعبئة", "", n0(q.since) + " كم", "sum") + (days > 0 ? li("المعدل اليومي", "على " + days + (days > 10 ? " يوماً" : days > 2 ? " أيام" : days === 2 ? " يومين" : " يوم"), n0(q.since / days) + " كم") : "") + '</ul>' +
          (q.tag ? '<p>السيارة' + esc(q.tag.replace(" ·", ":")) + '</p>' : '');
      } else h = '<p>يظهر بعد أول تعبئة مسجّلة بقراءة العداد.</p>';
    } else return;
    el("home-det-h").textContent = t; el("home-det-b").innerHTML = h;
    try { detDlg.showModal(); } catch(e){ detDlg.setAttribute("open", ""); }
    /* التركيز التلقائي على زر الإغلاق ينزل بالنافذة إلى آخرها: نعيدها إلى أولها */
    detDlg.scrollTop = 0; try { el("home-det-b").scrollTop = 0; } catch(e){}
  }
  home.addEventListener("click", function(ev){ var b = ev.target.closest("[data-det]"); if (b) showDet(b.dataset.det); });
  home.addEventListener("keydown", function(ev){ if (ev.key !== "Enter" && ev.key !== " ") return; var b = ev.target.closest("[data-det]"); if (b && ev.target === b){ ev.preventDefault(); showDet(b.dataset.det); } });
  var addDlg = document.createElement("dialog"); addDlg.id = "home-add-dlg"; addDlg.setAttribute("aria-labelledby", "home-add-h");
  addDlg.innerHTML = '<h2 id="home-add-h">إضافة مصروف السيارة</h2><p>سجّل قراءة العداد أولاً، ثم اختر نوع المصروف (تعبئة بنزين أو صيانة).</p><div class="opts">' +
    '<button type="button" id="ha-cam"><b>تصوير العداد بالكاميرا</b><span>تُقرأ القراءة من الصورة</span></button>' +
    '<button type="button" id="ha-gal"><b>صورة من الاستوديو</b><span>اختر صورة العداد من صور الجهاز</span></button>' +
    '<button type="button" id="ha-man"><b>إدخال العداد يدوياً</b><span>اكتب القراءة بالكيلومتر</span></button>' +
    '<button type="button" class="x" id="ha-x">إلغاء</button></div>' +
    '<input type="file" id="ha-cam-f" accept="image/*" capture="environment" hidden><input type="file" id="ha-gal-f" accept="image/*" hidden>';
  document.body.appendChild(addDlg);
  function hasCar(){ return Object.keys(store).some(function(k){ return k.indexOf("cars/") === 0; }); }
  function toCar(){ try { addDlg.close(); } catch(e){} show("car"); }
  el("home-add-car").addEventListener("click", function(){
    if (!hasCar()){ show("car"); try { el("fill-open").click(); } catch(e){} return; }
    try { addDlg.showModal(); } catch(e){ addDlg.setAttribute("open", ""); }
  });
  el("ha-x").addEventListener("click", function(){ addDlg.close(); });
  el("ha-cam").addEventListener("click", function(){ el("ha-cam-f").click(); });
  el("ha-gal").addEventListener("click", function(){ el("ha-gal-f").click(); });
  ["ha-cam-f", "ha-gal-f"].forEach(function(id){
    el(id).addEventListener("change", function(){
      var f = this.files && this.files[0]; this.value = ""; if (!f) return;
      toCar();
      try { var dt = new DataTransfer(); dt.items.add(f); var t = el("snap-file"); t.files = dt.files; t.dispatchEvent(new Event("change", {bubbles:true})); }
      catch(e){ el("snap-dlg").dispatchEvent(new Event("snap-manual")); }
    });
  });
  el("ha-man").addEventListener("click", function(){ toCar(); el("snap-dlg").dispatchEvent(new Event("snap-manual")); });
  el("home-add-exp").addEventListener("click", function(){
    show("exp");
    var tries = 0;
    (function openAdd(){
      var b = null; try { b = frame.contentWindow.document.getElementById("add-open"); } catch(e){}
      if (b && frame.contentWindow.document.readyState === "complete"){ b.click(); return; }
      if (++tries < 40) setTimeout(openAdd, 150);
    })();
  });
  /* تُحدَّث الأرقام عند كل عودة إلى الصفحة الرئيسية، وقسم المنزل يُحمَّل في الخلفية ليحسب مصروف الشهر والباقي */
  document.addEventListener("DOMContentLoaded", function(){
    stats();
    if (APP_MODE === "budget") setTimeout(function(){ if (!frame.getAttribute("src")) frame.setAttribute("src", "../masroof/"); }, 600);
  });
  window.__shell = {/* ثلاثة تنبيهات في اليوم: 7:00 صباحاً، 4:30 عصراً، 9:00 مساءً. كل تنبيه يبقى حتى تُسجَّل قراءة بعد وقته */
    odoDue:function(){ var n = new Date(), t = n.getHours() * 60 + n.getMinutes(), ms = det.odoMins || []; if (!det.hasCar) return false;
      if (t >= 1260) return !ms.some(function(x){ return x >= 1260; }); if (t >= 990) return !ms.some(function(x){ return x >= 990; }); if (t >= 420) return !ms.length; return false; }, show:show, stats:stats, showDet:showDet, frame:frame, dm:dm, addCar:function(){ el("home-add-car").click(); }};
  show("home");
})();

/* ===== الواجهة الجديدة (النسخة 45): خمس شاشات بدل قسمين =====
   الرئيسية برقم واحد «المتاح اليوم»، زر إضافة واحد، المشتريات، السجل، المزيد.
   المحرّكان القديمان (قسم السيارة وصفحة المنزل) يبقيان كما هما ويُفتحان من «المزيد» أو عند تسجيل مصروف. */
(function(){
  if (APP_MODE !== "budget") return;
  var S = window.__shell; if (!S) return;
  var frame = S.frame, cur = "home", logF = "all";
  function $(id){ return document.getElementById(id); }
  function esc(x){ return String(x).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function n0(x){ return Number(x).toLocaleString("en-US", {maximumFractionDigits:0}); }
  function n2(x){ return Number(x).toLocaleString("en-US", {maximumFractionDigits:2}); }
  function days(n){ return n === 1 ? "يوم واحد" : n === 2 ? "يومان" : n + (n > 10 ? " يوماً" : " أيام"); }
  function todayS(){ var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function sum(){ var s = null; try { s = JSON.parse(lsGet("masroof-summary") || "null"); } catch(e){} return s && s.d === todayS() ? s : null; }
  function dayName(d){ var t = todayS(), y = new Date(); y.setDate(y.getDate() - 1); var ys = y.getFullYear() + "-" + String(y.getMonth() + 1).padStart(2, "0") + "-" + String(y.getDate()).padStart(2, "0");
    if (d === t) return "اليوم"; if (d === ys) return "أمس";
    try { return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {weekday:"long", day:"numeric", month:"long"}).format(new Date(d + "T12:00")); } catch(e){ return d; } }
  function nxDate(d){ try { return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {weekday:"long", day:"numeric", month:"long"}).format(new Date(d + "T12:00")); } catch(e){ return d; } }
  function ico(p, s){ return '<svg aria-hidden="true" width="' + (s || 22) + '" height="' + (s || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  var I = {home:'<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>', cart:'<path d="M3 4h2l2.5 11h10L20 7H6.5"/><circle cx="9" cy="19" r="1.4"/><circle cx="17" cy="19" r="1.4"/>',
    list:'<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>', more:'<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', fuel:'<path d="M5 20V5a1 1 0 011-1h7a1 1 0 011 1v15"/><path d="M4 20h11"/><path d="M14 9h2.5a1.5 1.5 0 011.5 1.5V16a1.5 1.5 0 003 0V8l-2.5-2.5"/><path d="M7.5 8h4"/>',
    tool:'<path d="M14.5 6.5a4 4 0 00-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 005.3-5.3L15 12l-3-3z"/>', bag:'<path d="M6 8h12l-1 12H7z"/><path d="M9 8V6a3 3 0 016 0v2"/>',
    coin:'<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4"/>', chev:'<path d="M14 6l-6 6 6 6"/>',
    car:'<path d="M4 16v-3l2-5h12l2 5v3"/><path d="M4 16h16"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/>', sliders:'<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    gauge:'<path d="M4 17a8 8 0 1116 0"/><path d="M12 17l4-6"/><path d="M12 17h.01"/>',
    cloud:'<path d="M7 18a4 4 0 010-8 5 5 0 019.6-1.2A4.5 4.5 0 0117 18z"/>', alert:'<path d="M12 4l9 15H3z"/><path d="M12 10v4M12 17h.01"/>'};
  try { var fl = document.createElement("link"); fl.rel = "stylesheet"; fl.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"; document.head.appendChild(fl); } catch(e){}
  var css = document.createElement("style");
  css.textContent = "#app-home,#app-tabs{display:none!important}" +
    "#v2,#v2-nav,#v2-add{--i:#14213D;--m:#5B6577;--b:#F3F5F8;--s:#fff;--l:#DDE2EA;--a:#0B6E63;--ab:#E3F2EF;--w:#B4470B;--wb:#FBEDE2;--wl:#F0CDB0;font-family:'IBM Plex Sans Arabic',system-ui,-apple-system,sans-serif}" +
    "@media (prefers-color-scheme:dark){#v2,#v2-nav,#v2-add{--i:#E8ECF2;--m:#9AA6B8;--b:#10151C;--s:#19202A;--l:#2A3441;--a:#4CC7B5;--ab:#143630;--w:#F2A66F;--wb:#3A2415;--wl:#5A3A22}}" +
    "@media (prefers-color-scheme:light){:root{--accent:#0B6E63;--accent-ink:#fff}}" +
    "body{padding-bottom:calc(92px + env(safe-area-inset-bottom))!important}" +
    "#exp-view{bottom:calc(72px + env(safe-area-inset-bottom))!important}" +
    "#v2{position:fixed;top:0;left:0;right:0;bottom:calc(72px + env(safe-area-inset-bottom));z-index:6;background:var(--b);color:var(--i);overflow:auto;font-size:15px;line-height:1.5}" +
    "#v2 .in{max-width:560px;margin:0 auto;padding:calc(22px + env(safe-area-inset-top)) 18px 34px;display:flex;flex-direction:column;gap:14px}" +
    "#v2 h1{margin:0;font-size:26px;font-weight:700;line-height:1.3;color:var(--i)}#v2 .sub{margin:0;color:var(--m);font-size:14px}" +
    "#v2 .card{background:var(--s);border:1px solid var(--l);border-radius:18px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}" +
    "#v2 .nx{font:inherit;color:inherit;cursor:pointer;text-align:start;display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--b);border:1px solid var(--l);border-radius:12px;padding:10px 12px}#v2 .nx span{display:flex;flex-direction:column;gap:2px;min-width:0}#v2 .nx small{font-size:12px;color:var(--m)}#v2 .nx b{font-size:17px;font-weight:700}#v2 .nx .dd{align-items:center;flex:none}#v2 .nx .dd b{font-size:26px;color:var(--a);font-variant-numeric:tabular-nums;line-height:1}#v2 .nx.w .dd b{color:var(--w)}" +
    "#v2 .f3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}#v2 .tl{font:inherit;color:inherit;text-align:start;cursor:pointer;background:var(--b);border:1px solid var(--l);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:2px;min-width:0}#v2 .tl b{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--a)}#v2 .tl small{font-size:12px;color:var(--m)}" +
    "#v2 button.card{font:inherit;color:inherit;text-align:start;cursor:pointer;width:100%}" +
    "#v2 .big{display:flex;align-items:baseline;gap:8px}#v2 .big b{font-size:40px;font-weight:700;line-height:1.05;color:var(--a);font-variant-numeric:tabular-nums}#v2 .big.over b{color:var(--w)}#v2 .big span{font-size:15px;color:var(--m)}" +
    "#v2 .pb{height:10px;border-radius:5px;background:var(--l);overflow:hidden}#v2 .pb i{display:block;height:100%;border-radius:5px;background:var(--a)}#v2 .pb.over i{background:var(--w)}#v2 .pb.sec{margin-top:14px}" +
    "#v2 .two{display:flex;justify-content:space-between;gap:10px;font-size:14px;color:var(--m)}#v2 .two b{color:var(--i);font-variant-numeric:tabular-nums}#v2 .lnk{color:var(--a);font-weight:600}" +
    "#v2 .al{display:flex;align-items:center;gap:12px;border-radius:16px;padding:14px 16px;font:inherit;text-align:start;cursor:pointer;width:100%;background:var(--s);border:1px solid var(--l);color:var(--i)}" +
    "#v2 .al.w{background:var(--wb);border-color:var(--wl);color:var(--w);font-weight:600}#v2 .al>span{flex:1;min-width:0}#v2 .al>span.ic{flex:none;display:flex}#v2 .al svg{flex:none}#v2 .al .ic{color:var(--a)}" +
    "#v2 .row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--l)}#v2 .row:last-child{border-bottom:0}" +
    "#v2 button.row{font:inherit;color:inherit;text-align:start;background:transparent;border-left:0;border-right:0;border-top:0;width:100%;cursor:pointer}" +
    "#v2 .row .t{flex:1;min-width:0;display:flex;flex-direction:column}#v2 .row .t b{font-weight:600}#v2 .row .t small{color:var(--m);font-size:13px}#v2 .row .v{font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}" +
    "#v2 .sq{width:38px;height:38px;border-radius:12px;background:var(--ab);color:var(--a);display:flex;align-items:center;justify-content:center;flex:none}" +
    "#v2 .hd{display:flex;justify-content:space-between;align-items:center;gap:10px}#v2 .hd b{font-size:16px}" +
    "#v2 .pill{font-size:13px;font-weight:600;border-radius:12px;padding:3px 10px;white-space:nowrap;background:var(--b);color:var(--i)}#v2 .pill.w{background:var(--wb);color:var(--w)}#v2 .pill.a{background:var(--ab);color:var(--a)}" +
    "#v2 .bt{font:inherit;font-size:13px;font-weight:600;color:#fff;background:var(--a);border:1px solid var(--a);border-radius:10px;padding:0 14px;min-height:44px;cursor:pointer;white-space:nowrap}#v2 .bt.o{background:var(--s);color:var(--a)}" +
    "@media (prefers-color-scheme:dark){#v2 .bt{color:#06231f}#v2 .bt.o{color:var(--a)}}" +
    "#v2 .chips{display:flex;gap:8px;flex-wrap:wrap}#v2 .chip{font:inherit;font-size:14px;padding:9px 16px;min-height:44px;border-radius:22px;border:1px solid var(--l);background:var(--s);color:var(--i);cursor:pointer}" +
    "#v2 .chip[aria-pressed=true]{background:var(--a);border-color:var(--a);color:#fff;font-weight:600}" +
    "#v2 .card.g2{gap:2px}#v2 .card.g0{gap:0}#v2 .fx{display:flex;gap:6px}#v2 .mu{color:var(--m)}" +
    "#v2 .gh{color:var(--m);font-size:13px;font-weight:600}#v2 .note{margin:0;text-align:center;color:var(--m);font-size:13px}" +
    "#v2-nav{position:fixed;left:0;right:0;bottom:0;z-index:7;height:calc(72px + env(safe-area-inset-bottom));padding:0 6px env(safe-area-inset-bottom);box-sizing:border-box;background:var(--s);border-top:1px solid var(--l);display:grid;grid-template-columns:1fr 1fr 76px 1fr 1fr;align-items:center}" +
    "#v2-nav button{font:inherit;border:0;background:transparent;color:var(--m);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:12px;font-weight:500;min-height:52px;cursor:pointer}" +
    "#v2-nav button[aria-current=page]{color:var(--a);font-weight:700}" +
    "#v2-nav button.plus{width:60px;height:60px;min-height:60px;margin:-26px auto 0;border-radius:30px;border:4px solid var(--b);background:var(--a);color:#fff}" +
    "#v2-row{--i:#14213D;--m:#5B6577;--b:#F3F5F8;--s:#fff;--l:#DDE2EA;--a:#0B6E63;--ab:#E3F2EF;font-family:'IBM Plex Sans Arabic',system-ui,-apple-system,sans-serif;border:1px solid var(--l);border-radius:20px;padding:20px 18px;background:var(--s);color:var(--i);width:min(94vw,440px);max-height:86vh}" +
    "@media (prefers-color-scheme:dark){#v2-row{--i:#E8ECF2;--m:#9AA6B8;--b:#10151C;--s:#19202A;--l:#2A3441;--a:#4CC7B5;--ab:#143630}}" +
    "#v2-row::backdrop{background:rgba(0,0,0,.45)}#v2-row h2{margin:0 0 4px;font-size:20px}#v2-row .sub{margin:0 0 10px;color:var(--m);font-size:14px}" +
    "#v2-row ul{list-style:none;margin:0;padding:0}#v2-row li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--l);font-variant-numeric:tabular-nums}#v2-row li:last-child{border-bottom:0}" +
    "#v2-row li.now{font-weight:700;color:var(--a)}#v2-row li.past{color:var(--m)}#v2-row li.sum{font-weight:700}#v2-row h3{margin:14px 0 2px;font-size:15px;color:var(--m)}" +
    "#v2-row .note{margin:10px 0 0;color:var(--m);font-size:13px}#v2-row .acts{display:flex;gap:10px;margin-top:14px}" +
    "#v2-row .acts button{flex:1;font:inherit;font-weight:600;padding:13px;border-radius:14px;cursor:pointer;border:1px solid var(--l);background:transparent;color:var(--i)}#v2-row .acts .pr{background:var(--a);border-color:var(--a);color:#fff}" +
    "@media (prefers-color-scheme:dark){#v2-row .acts .pr{color:#06231f}}" +
    "#v2-row .acts .dl{color:#B42318;border-color:#F0C4BE}#v2-row .acts .dl.sure{background:#B42318;border-color:#B42318;color:#fff}#v2-row .acts .dl[hidden]{display:none}" +
    "#v2-add{border:1px solid var(--l);border-radius:20px;padding:20px 18px;background:var(--b);color:var(--i);width:min(94vw,440px)}#v2-add::backdrop{background:rgba(0,0,0,.45)}" +
    "#v2-add h2{margin:0;font-size:22px}#v2-add p{margin:0 0 12px;color:var(--m);font-size:14px}#v2-add .os{display:grid;gap:10px}" +
    "#v2-add .o{display:flex;align-items:center;gap:14px;width:100%;text-align:start;font:inherit;color:var(--i);background:var(--s);border:1px solid var(--l);border-radius:16px;padding:14px;cursor:pointer}" +
    "#v2-add .o .sq{width:46px;height:46px;border-radius:14px;background:var(--ab);color:var(--a);display:flex;align-items:center;justify-content:center;flex:none}" +
    "#v2-add .o span.t{flex:1;display:flex;flex-direction:column}#v2-add .o b{font-size:17px}#v2-add .o small{color:var(--m);font-size:13px}#v2-add .o>svg{color:var(--m)}" +
    "#v2-add .x{margin-top:12px;width:100%;font:inherit;font-weight:600;color:var(--m);background:transparent;border:1px solid var(--l);border-radius:14px;padding:13px;cursor:pointer}";
  document.head.appendChild(css);
  var v2 = document.createElement("div"); v2.id = "v2"; v2.innerHTML = '<div class="in" id="v2-in"></div>';
  var nav = document.createElement("nav"); nav.id = "v2-nav"; nav.setAttribute("aria-label", "التنقل");
  nav.innerHTML = '<button type="button" data-go="home">' + ico(I.home) + '<span>الرئيسية</span></button><button type="button" data-go="shop">' + ico(I.cart) + '<span>المشتريات</span></button>' +
    '<button type="button" class="plus" id="v2-plus" aria-label="إضافة مصروف">' + ico(I.plus, 28) + '</button>' +
    '<button type="button" data-go="log">' + ico(I.list) + '<span>السجل</span></button><button type="button" data-go="more">' + ico(I.more) + '<span>المزيد</span></button>';
  var add = document.createElement("dialog"); add.id = "v2-add"; add.setAttribute("aria-labelledby", "v2-add-h");
  function opt(k, ic, t, s){ return '<button type="button" class="o" data-add="' + k + '"><span class="sq">' + ico(I[ic], 24) + '</span><span class="t"><b>' + t + '</b><small>' + s + '</small></span>' + ico(I.chev, 18) + '</button>'; }
  add.innerHTML = '<h2 id="v2-add-h">إضافة مصروف</h2><p>اختر نوع المصروف</p><div class="os">' + opt("shop", "bag", "مشتريات البيت", "طعام ومستلزمات بالكمية") + opt("other", "coin", "مصروف آخر", "إيجار، فواتير، مدارس، غيرها") + opt("inv", "coin", "فاتورة مجزّأة", "إجمالي واحد يُقسَّم على عدة بنود وفروع") + '</div><button type="button" class="x" id="v2-add-x">إلغاء</button>';
  var rd = document.createElement("dialog"); rd.id = "v2-row"; rd.setAttribute("aria-labelledby", "v2-row-h");
  rd.innerHTML = '<h2 id="v2-row-h"></h2><div id="v2-row-b"></div><div class="acts"><button type="button" class="pr" id="v2-row-edit">تعديل</button><button type="button" class="dl" id="v2-row-del">حذف</button><button type="button" class="x" id="v2-row-x">إغلاق</button></div>';
  document.body.appendChild(v2); document.body.appendChild(nav); document.body.appendChild(add); document.body.appendChild(rd);

  /* الرجوع تلقائياً إلى الشاشة السابقة بعد إغلاق نوافذ التسجيل في القسمين القديمين */
  var watch = null;
  function anyDlg(){ if (document.querySelector("dialog[open]")) return true; try { return !!frame.contentWindow.document.querySelector("dialog[open]"); } catch(e){ return false; } }
  function back(to){
    if (watch) clearInterval(watch);
    var seen = false, quiet = 0, t0 = Date.now();
    watch = setInterval(function(){
      if (anyDlg()){ seen = true; quiet = 0; return; }
      if (seen && ++quiet >= 2){ clearInterval(watch); watch = null; go(to); }
      else if (!seen && Date.now() - t0 > 120000){ clearInterval(watch); watch = null; }
    }, 350);
  }
  function inFrame(fn){ var n = 0; (function t(){ var d = null; try { d = frame.contentWindow.document; } catch(e){} if (d && d.readyState === "complete" && fn(d, frame.contentWindow)) return; if (++n < 50) setTimeout(t, 150); })(); }
  function addHome(cat, item){
    var prev = cur; S.show("exp");
    inFrame(function(d, W){ var o = d.getElementById("add-open"); if (!o) return false; o.click();
      try { if (cat){ var c = d.getElementById("a-cat"); c.value = cat; c.dispatchEvent(new W.Event("change", {bubbles:true})); }
        if (item){ var it = d.getElementById("a-item"); it.value = item; it.dispatchEvent(new W.Event("change", {bubbles:true})); } } catch(e){}
      return true; });
    back(prev);
  }
  function haveItem(id){ var prev = cur; S.show("exp"); inFrame(function(d){ var o = d.querySelector('#stock button[data-have="' + id + '"]'); if (!o) return false; o.click(); return true; }); back(prev); }
  function editRow(id){ var prev = cur; S.show("exp"); inFrame(function(d){ var o = d.querySelector('#log button[data-edit="' + id + '"]'); if (!o) return false; o.click(); return true; }); back(prev); }
  function addCar(){ var prev = cur; S.addCar(); back(prev); }

  function rHome(){
    var s = sum(), h = '<div><h1>دفتر المصروف</h1><p class="sub">' + esc(dayName(todayS()) === "اليوم" ? new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", {weekday:"long", day:"numeric", month:"long"}).format(new Date()) : "") + '</p></div>';
    /* تنبيه يومي أعلى الصفحة: من 4:30 عصراً حتى تُسجَّل قراءة العداد */
    var due = false; /* تنبيه العداد انتقل إلى دفتر البنزين */
    if (due) h += '<button type="button" class="al w" data-odo="1">' + ico(I.gauge) + '<span>يلزم تسجيل ممشى اليوم ليُحسب كم يكفي البنزين</span>' + ico(I.chev, 18) + '</button>';
    if (!s){ return h + '<div class="card"><span class="sub">المتاح اليوم</span><div class="big"><b>—</b><span>ريال</span></div><p class="sub">جارٍ تحميل البيانات…</p></div>'; }
    var L = Number(s.dayLimit) || 0, sp = Number(s.daySpent) || 0, left = L - sp, pc = L > 0 ? Math.min(100, sp / L * 100) : (sp > 0 ? 100 : 0), over = left < -0.005;
    /* المتبقي فعلياً يُقاس بالحد النقدي: ما بقي من الميزانية بعد كل ما دُفع وحُوّل ÷ الأيام الباقية */
    var Lc = s.cashLimit != null ? Number(s.cashLimit) : L, pd = Number(s.dayPaid) || 0, ppc = Lc > 0 ? Math.min(100, pd / Lc * 100) : (pd > 0 ? 100 : 0), pov = Lc - pd < -0.005;
    h += '<button type="button" class="card" data-det="day"><span class="sub">' + (over ? "تجاوزت حد اليوم بـ" : "المتاح اليوم") + '</span><div class="big' + (over ? " over" : "") + '"><b>' + n0(Math.abs(left)) + '</b><span>ريال</span></div>' +
      '<div class="pb' + (over ? " over" : "") + '"><i data-w="' + pc + '"></i></div><div class="two"><span>المحسوب على اليوم <b>' + n0(sp) + '</b> من ' + n0(L) + '</span><span class="lnk">التفاصيل</span></div></button>' +
      /* بطاقة مستقلة للمتبقي فعلياً اليوم: الحد اليومي ناقص ما خرج من الجيب بتاريخ اليوم قبل توزيعه على الأيام */
      '<button type="button" class="card" data-det="day"><span class="sub">' + (pov ? "تجاوزت فعلياً حد اليوم بـ" : "المتبقي فعلياً اليوم") + '</span><div class="big' + (pov ? " over" : "") + '"><b>' + n0(Math.abs(Lc - pd)) + '</b><span>ريال</span></div>' +
      '<div class="pb' + (pov ? " over" : "") + '"><i data-w="' + ppc + '"></i></div><div class="two"><span>المدفوع فعلياً <b>' + n0(pd) + '</b> من ' + n0(Lc) + '</span><span class="lnk">التفاصيل</span></div></button>';
    var inc = Number(s.income) || 0, ms = Number(s.spent) || 0, ml = inc - ms, mp = inc > 0 ? Math.min(100, ms / inc * 100) : 0, mo = ml < -0.005;
    h += '<button type="button" class="card" data-det="mon"><div class="hd"><span class="sub">' + (mo ? "تجاوزت ميزانية الشهر بـ" : "المتاح هذا الشهر") + '</span><span class="sub">باقي ' + days(s.daysLeft) + '</span></div><div class="big' + (mo ? " over" : "") + '"><b>' + n0(Math.abs(ml)) + '</b><span>ريال</span></div>' +
      '<div class="pb' + (mo ? " over" : "") + '"><i data-w="' + mp + '"></i></div><div class="two"><span>صرفت <b>' + n0(ms) + '</b> من ' + n0(inc) + '</span><span class="lnk">التفاصيل</span></div></button>';
    /* المحجوز: قسط الإيجار وسداد الديون وما شابههما */
    var rs = s.res || [];
    if (rs.length) h += '<button type="button" class="card g2" data-res="1"><div class="hd"><b>المحجوز</b><span class="lnk">إدارة</span></div>' + rs.map(function(r){
      var sub = r.e === 1 ? n0(r.a) + " شهرياً" + (r.sw ? " + فائض الأيام" : "") : "من " + n0(r.a) + " · يحل " + S.dm(r.due) + (r.pre > 0 ? " · منه " + n0(r.pre) + " خارج البرنامج" : "");
      if (!(r.per > 0) && !(r.saved > 0)) sub = "يبدأ الحجز في شهر " + Number(String(r.st).slice(5,7)) + (r.due ? " · يحل " + S.dm(r.due) : r.sw ? " · فائض الأيام من الآن" : "");
      return '<div class="row"><span class="t"><b>' + esc(r.n) + '</b><small>' + esc(sub) + '</small></span>' + (r.now && r.e !== 1 ? '<span class="pill w">حلّ موعده</span>' : '') + '<span class="v">' + n0(r.saved) + '</span></div>'; }).join("") + '</button>';
    var st = s.stock || [], miss = st.filter(function(x){ return x.left <= 0; }).length, fuel = st.find(function(x){ return x.car && x.n === "بنزين"; });
    /* لا تنبيه في الرئيسية عن السلع غير المتوفرة: الشراء اختياري وتُتابع من صفحة المشتريات */
    /* سطر البنزين يبقى في مكانه؛ تنبيه تسجيل الممشى صار أعلى الصفحة */
    /* إحصائية البنزين: مصروف الشهر، ممشى الشهر، الممشى منذ آخر تعبئة (من إحصاءات قسم السيارة) */
    var hv = function(id){ var e = document.getElementById(id); return e ? String(e.textContent || "").trim() : ""; }, fv = hv("hs-fuel"), kv = hv("hs-km"), sv = hv("hs-since");
    if (false) if ((fv && fv !== "—") || (kv && kv !== "—") || (sv && sv !== "—") || fuel) h += '<div class="card"><div class="hd"><b>البنزين</b><span class="sub">تقديري</span></div>' +
      /* موعد التعبئة القادمة تقديرياً: بالأيام وبالتاريخ (آخر يوم يكفيه البنزين الحالي) */
      (fuel && fuel.end ? '<button type="button" class="nx' + (fuel.left > 0 ? "" : " w") + '" data-det="since"><span><small>' + (fuel.left > 0 ? "التعبئة القادمة تقريباً" : "حان وقت التعبئة · انتهت المدة المقدّرة") + '</small><b>' + esc(nxDate(fuel.end)) + '</b></span><span class="dd"><b>' + (fuel.left > 0 ? fuel.left : 0) + '</b><small>' + (fuel.left === 1 ? "يوم باقٍ" : fuel.left === 2 ? "يومان باقيان" : fuel.left > 2 && fuel.left <= 10 ? "أيام باقية" : fuel.left > 10 ? "يوماً باقياً" : "يوم باقٍ") + '</small></span></button>' : '') + '<div class="f3">' +
      '<button type="button" class="tl" data-det="fuel"><b>' + esc(fv || "—") + '</b><small>مصروف الشهر (ريال)</small></button>' +
      '<button type="button" class="tl" data-det="km"><b>' + esc(kv || "—") + '</b><small>ممشى الشهر (كم)</small></button>' +
      '<button type="button" class="tl" data-det="since"><b>' + esc(sv || "—") + '</b><small>منذ آخر تعبئة (كم)</small></button></div></div>';
    if (!lsGet(SYNCKEY)) h += '<button type="button" class="al" data-sync="1"><span class="ic">' + ico(I.cloud) + '</span><span>بياناتك على هذا الجهاز فقط. فعّل النسخ الاحتياطي.</span>' + ico(I.chev, 18) + '</button>';
    return h;
  }
  function rShop(){
    var s = sum(), st = s ? (s.stock || []) : [], miss = st.filter(function(x){ return x.left <= 0; }).sort(function(a, b){ return b.left - a.left; }), have = st.filter(function(x){ return x.left > 0; });
    var h = '<div><h1>المشتريات</h1><p class="sub">المتوفر في البيت وغير المتوفر</p></div>';
    h += '<div class="card g2"><div class="hd"><b>غير متوفر</b><span class="pill">' + (miss.length ? miss.length : "لا شيء") + '</span></div>' + (miss.length ? '<p class="sub">الشراء اختياري: سجّل شراءً، أو اضغط «متوفر» إن كان عندك دون شراء.</p>' : '') + (miss.length ? miss.map(function(x){
      var sub = x.nv ? "لم يُسجَّل بعد" : x.left === 0 ? "انتهى أمس" : "انتهى منذ " + days(1 - x.left);
      return '<div class="row"><span class="t"><b>' + esc(x.n) + '</b><small>' + sub + '</small></span>' + (x.id ? '<span class="fx">' + '<button type="button" class="bt o" data-have="' + esc(x.id) + '">متوفر</button><button type="button" class="bt" data-buy="' + esc(x.id) + '">شراء</button></span>' : '<span class="pill w">انتهى</span>') + '</div>'; }).join("") : '<p class="sub">كل السلع متوفرة.</p>') + '</div>';
    h += '<div class="card g2"><div class="hd"><b>متوفر</b><span class="pill a">' + (have.length === 1 ? "صنف واحد" : have.length === 2 ? "صنفان" : have.length + (have.length > 10 ? " صنفاً" : " أصناف")) + '</span></div>' + (have.length ? have.map(function(x){
      return '<div class="row"><span class="t"><b>' + esc(x.n + (x.q ? " " + x.q : "")) + '</b><small>' + (x.car ? "تقديراً حتى " : "حتى ") + S.dm(x.end) + '</small></span><span class="pill' + (x.left <= 2 ? " w" : "") + '">' + (x.left === 1 ? "آخر يوم" : days(x.left)) + '</span></div>'; }).join("") : '<p class="sub">لا يوجد صنف مسجّل بعد.</p>') + '</div>';
    return h;
  }
  function rLog(){
    var s = sum(), rows = s ? (s.rows || []) : [];
    if (logF === "home") rows = rows.filter(function(r){ return !r.x; }); else if (logF === "car") rows = rows.filter(function(r){ return r.x; });
    var h = '<div><h1>السجل</h1><p class="sub">مصروفات هذا الشهر في مكان واحد</p></div><div class="chips">' + [["all","الكل"],["home","المنزل"],["car","السيارة"]].map(function(f){ return '<button type="button" class="chip" data-f="' + f[0] + '" aria-pressed="' + (logF === f[0]) + '">' + f[1] + '</button>'; }).join("") + '</div>';
    if (!rows.length) return h + '<div class="card"><p class="sub">لا توجد مصروفات مسجّلة.</p></div>';
    var by = {}, ord = []; rows.forEach(function(r){ if (!by[r.d]){ by[r.d] = []; ord.push(r.d); } by[r.d].push(r); });
    ord.forEach(function(d){
      var tot = by[d].reduce(function(a, r){ return a + (r.r ? 0 : r.a); }, 0);
      h += '<div class="card g2"><span class="gh">' + esc(dayName(d)) + ' · ' + n2(tot) + ' ريال</span>' + by[d].map(function(r){
        return '<button type="button" class="row" data-row="' + esc(r.id) + '" data-x="' + r.x + '"><span class="sq">' + ico(r.x ? (r.n === "بنزين" ? I.fuel : I.tool) : (r.k > 1 || r.c.indexOf("الطعام") === 0 ? I.bag : I.coin), 20) + '</span><span class="t"><b>' + esc(r.n) + '</b><small>' + esc((r.x ? "السيارة" : r.c) + (r.k > 1 ? " · تكفي " + days(r.k) : "")) + '</small></span><span class="v">' + n2(r.a) + '</span></button>'; }).join("") + '</div>';
    });
    return h + '<p class="note">اضغط أي مصروف لعرض أيام توزيعه ثم تعديله</p>';
  }
  function rMore(){
    var s = sum();
    function m(k, ic, t, sub){ return '<button type="button" class="row" data-more="' + k + '"><span class="sq">' + ico(I[ic], 20) + '</span><span class="t"><b>' + t + '</b><small>' + sub + '</small></span><span class="mu">' + ico(I.chev, 18) + '</span></button>'; }
    return '<div><h1>المزيد</h1></div><div class="card g0">' + m("car", "car", "دفتر البنزين", "تطبيق السيارة المستقل: التعبئة والصيانة والإحصائيات") + m("exp", "sliders", "البنود والحدود", "الدخل وحدود البنود والتسويات") + m("stmt", "sliders", "كشف البنود", "أول المدة، المضاف، المصروف، رصيد آخر المدة") + '</div>' +
      '<div class="card g0">' + m("sync", "cloud", "النسخ الاحتياطي", lsGet(SYNCKEY) ? "مفعّل: بياناتك تُحفظ على الخادم" : "غير مفعّل: البيانات على هذا الجهاز فقط") + '</div>' +
      '<p class="note">دفتر المصروف · النسخة ' + esc(VERSION) + (s && s.ver ? " · المنزل " + esc(s.ver) : "") + '</p>';
  }
  /* تفاصيل مصروف من السجل: الأيام التي وُزّع عليها ونصيب كل يوم، ثم التعديل */
  var rowCur = null;
  function rowDet(id){
    var s = sum(), r = s ? (s.rows || []).find(function(x){ return String(x.id) === String(id); }) : null; if (!r) return;
    rowCur = r;
    var p = r.d.split("-"), last = new Date(Number(p[0]), Number(p[1]), 0).getDate(), toEnd = last - Number(p[2]) + 1, span = r.k > 1 ? Math.max(1, Math.min(r.k, toEnd)) : 1, share = r.a / span, t = todayS();
    var h = '<p class="sub">' + esc((r.x ? "السيارة" : r.c) + " · " + dayName(r.d)) + '</p><ul>' + (r.f ? '<li><span>أصل المبلغ المدفوع</span><b>' + n2(r.f) + ' ريال</b></li><li><span>المحسوب على ميزانية الشهر</span><b>' + n2(r.a) + ' ريال</b></li><li><span>خارج البرنامج</span><b>' + n2(r.f - r.a) + ' ريال</b></li>' : '<li><span>المبلغ المدفوع</span><b>' + n2(r.a) + ' ريال</b></li>') + '<li><span>يغطي</span><b>' + days(r.k) + '</b></li>' +
      (span > 1 ? '<li><span>نصيب اليوم الواحد</span><b>' + n2(Math.round(share * 100) / 100) + ' ريال</b></li>' : '') + '</ul>';
    if (span > 1){
      h += '<h3>الأيام الموزَّع عليها (' + span + ')</h3><ul>';
      for (var i = 0; i < span; i++){
        var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + i), ds = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
        h += '<li class="' + (ds === t ? "now" : ds < t ? "past" : "") + '"><span>' + esc(dayName(ds)) + (ds === t ? "" : "") + '</span><span>' + n2(Math.round(share * 100) / 100) + '</span></li>';
      }
      h += '<li class="sum"><span>المجموع</span><span>' + n2(r.a) + '</span></li></ul>';
      if (r.k > span) h += '<p class="note">المدة (' + days(r.k) + ') تمتد بعد نهاية الشهر، فوُزّع المبلغ على الأيام الباقية من هذا الشهر فقط لأنه دُفع من ميزانيته.</p>';
    } else h += '<p class="note">هذا المصروف محسوب كاملاً على يوم دفعه.</p>';
    if (r.x) h += '<p class="note">مصروف سيارة: تعديله من صفحة السيارة، والمدة تقديرية تُحسب تلقائياً.</p>';
    if (r.r) h = '<p class="sub">' + esc(r.c + " · " + dayName(r.d)) + '</p><ul><li><span>المبلغ المسدَّد</span><b>' + n2(r.a) + ' ريال</b></li></ul><p class="note">سُدّد من المبلغ المحجوز، فلا يُحسب على مصروف هذا الشهر ولا على الحد اليومي. التراجع عنه من بطاقة «مبالغ محجوزة».</p>';
    $("v2-row-h").textContent = r.n; $("v2-row-b").innerHTML = h; $("v2-row-edit").textContent = r.x ? "فتح صفحة السيارة" : r.r ? "فتح صفحة المصروف" : "تعديل";
    /* الحذف لمصروفات المنزل فقط، وبضغطتين: «حذف» ثم «تأكيد الحذف» */
    var db = $("v2-row-del"); db.hidden = !!(r.x || r.r); db.className = "dl"; db.textContent = "حذف"; db.disabled = false;
    try { rd.showModal(); } catch(e){ rd.setAttribute("open", ""); }
    rd.scrollTop = 0;
  }
  rd.addEventListener("click", function(ev){
    if (ev.target.closest("#v2-row-x")){ rd.close(); return; }
    var dl = ev.target.closest("#v2-row-del");
    if (dl && rowCur){
      if (dl.className.indexOf("sure") < 0){ dl.className = "dl sure"; dl.textContent = "تأكيد الحذف"; return; }
      dl.disabled = true; var did = rowCur.id; rd.close(); S.show("exp");
      inFrame(function(d){ var o = d.querySelector('#log button[data-del="' + did + '"]'); if (!o) return false; o.click(); o.click(); setTimeout(function(){ go("log"); }, 500); return true; });
      return;
    }
    if (ev.target.closest("#v2-row-edit") && rowCur){ rd.close(); if (rowCur.x) S.show("car"); else if (rowCur.r) S.show("exp"); else editRow(rowCur.id); }
  });
  function draw(){
    $("v2-in").innerHTML = cur === "shop" ? rShop() : cur === "log" ? rLog() : cur === "more" ? rMore() : rHome();
    /* العرض يُضبط بالسكربت لأن سياسة أمان الصفحة تمنع الأنماط المضمّنة */
    Array.prototype.forEach.call(v2.querySelectorAll(".pb i[data-w]"), function(b){ b.style.width = b.dataset.w + "%"; });
  }
  function mark(k){ Array.prototype.forEach.call(nav.querySelectorAll("button[data-go]"), function(b){ b.setAttribute("aria-current", b.dataset.go === k ? "page" : "false"); }); }
  function go(k){
    if (k === "car"){ location.href = "../fuel/"; return; }
    if (k === "exp"){ S.show(k); return; }
    cur = k; v2.hidden = false; mark(k); try { S.stats(); } catch(e){} draw(); v2.scrollTop = 0;
  }
  window.__shellHook = function(v){ if (v === "car" || v === "exp"){ v2.hidden = true; mark("more"); } };
  function syncGo(){ S.show("car"); try { var f = $("sa-sync"); f.closest("details").open = true; f.scrollIntoView({block:"center"}); f.focus(); } catch(e){} }
  nav.addEventListener("click", function(ev){ var b = ev.target.closest("button"); if (!b) return; if (b.id === "v2-plus"){ try { add.showModal(); } catch(e){ add.setAttribute("open", ""); } return; } if (b.dataset.go) go(b.dataset.go); });
  add.addEventListener("click", function(ev){
    if (ev.target.closest("#v2-add-x")){ add.close(); return; }
    var b = ev.target.closest("button[data-add]"); if (!b) return; add.close();
    var k = b.dataset.add;
    if (k === "odo"){ odoGo(); return; }
    if (k === "inv"){ var pv = cur; S.show("exp"); inFrame(function(d){ var o = d.getElementById("inv-open"); if (!o) return false; o.click(); return true; }); back(pv); return; }
    if (k === "fuel" || k === "svc") addCar(); else if (k === "shop") addHome("food"); else addHome(null);
  });
  function odoGo(){ var prev = cur; S.show("car"); try { $("mnt-open").click(); $("odo-open").click(); } catch(e){} back(prev); }
  /* يظهر التنبيه عند 4:30 حتى لو كان التطبيق مفتوحاً قبلها */
  var dueWas = false; setInterval(function(){ if (v2.hidden || document.hidden || cur !== "home") return; var d = false; try { S.stats(); d = S.odoDue(); } catch(e){} if (d !== dueWas){ dueWas = d; draw(); } }, 60000);
  v2.addEventListener("click", function(ev){
    var b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.odo){ odoGo(); return; }
    if (b.dataset.res){ S.show("exp"); inFrame(function(d){ var c = d.getElementById("res-card"); if (!c) return false; c.scrollIntoView({block:"start"}); return true; }); return; }
    if (b.dataset.det){ S.showDet(b.dataset.det); return; }
    if (b.dataset.go){ go(b.dataset.go); return; }
    if (b.dataset.sync){ syncGo(); return; }
    if (b.dataset.buy){ addHome("food", b.dataset.buy); return; }
    if (b.dataset.have){ haveItem(b.dataset.have); return; }
    if (b.dataset.f){ logF = b.dataset.f; draw(); return; }
    if (b.dataset.row){ rowDet(b.dataset.row); return; }
    if (b.dataset.more){ var k = b.dataset.more; if (k === "sync") syncGo();
      else if (k === "stmt"){ var pv = cur; S.show("exp"); inFrame(function(d){ var o = d.getElementById("stmt-open"); if (!o) return false; o.click(); return true; }); back(pv); }
      else S.show(k); }
  });
  window.addEventListener("storage", function(ev){ if (ev.key === "masroof-summary" && !v2.hidden) draw(); });
  document.addEventListener("visibilitychange", function(){ if (!document.hidden && !v2.hidden) draw(); });
  go("home");
})();


/* ===== دفتر البنزين (النسخة 72): تطبيق للسيارة فقط =====
   الرئيسية، السجل، الصيانة، الإحصائيات، وزر الإضافة. كل الأرقام تُحسب من سجلات السيارة المحفوظة (store) دون تغييرها.
   التسجيل والتعديل والإعدادات يبقى في صفحة السيارة الأصلية وتُفتح من هنا. */
(function(){
  if (typeof APP_MODE !== "undefined" && APP_MODE !== "fuel") return;
  var S = window.__shell; if (!S) return;
  try { document.title = "دفتر البنزين"; } catch(e){}
  var cur = "home", logF = "all", statP = 6;
  function $(id){ return document.getElementById(id); }
  function esc(x){ return String(x).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function n0(x){ return Number(x).toLocaleString("en-US", {maximumFractionDigits:0}); }
  function n1(x){ return Number(x).toLocaleString("en-US", {minimumFractionDigits:1, maximumFractionDigits:1}); }
  function n2(x){ return Number(x).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2}); }
  function pad(n){ return String(n).padStart(2, "0"); }
  function dS(d){ return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayS(){ return dS(new Date()); }
  function days(n){ return n === 1 ? "يوم واحد" : n === 2 ? "يومان" : n + (n > 10 ? " يوماً" : " أيام"); }
  function fmtD(d, o){ try { return new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", o).format(new Date(String(d).slice(0,10) + "T12:00")); } catch(e){ return String(d).slice(0,10); } }
  function dLong(d){ return fmtD(d, {weekday:"long", day:"numeric", month:"long"}); }
  function dShort(d){ return fmtD(d, {day:"numeric", month:"long"}); }
  function mName(ym){ return fmtD(ym + "-01", {month:"long", year:"numeric"}); }
  function mShort(ym){ return fmtD(ym + "-01", {month:"long"}); }
  function ico(p, s){ return '<svg aria-hidden="true" width="' + (s || 22) + '" height="' + (s || 22) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  var I = {home:'<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>', list:'<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>', plus:'<path d="M12 5v14M5 12h14"/>',
    fuel:'<path d="M5 20V5a1 1 0 011-1h7a1 1 0 011 1v15"/><path d="M4 20h11"/><path d="M14 9h2.5a1.5 1.5 0 011.5 1.5V16a1.5 1.5 0 003 0V8l-2.5-2.5"/><path d="M7.5 8h4"/>',
    tool:'<path d="M14.5 6.5a4 4 0 00-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 005.3-5.3L15 12l-3-3z"/>', chart:'<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>', chev:'<path d="M14 6l-6 6 6 6"/>',
    gear:'<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
    gauge:'<path d="M4 15a8 8 0 0116 0"/><path d="M12 15l4-4"/><path d="M4 19h16"/>'};

  /* ---------- القراءة من السجلات ---------- */
  var DEF = [["oil","زيت المحرك",10000,6],["oil-filter","فلتر الزيت",10000,6],["air-filter","فلتر الهواء",20000,12],["cabin-filter","فلتر المكيف",20000,12],["brake-pads","فحمات الفرامل",40000,0],["tires","الإطارات",50000,48],["battery","البطارية",0,24],["gear-oil","زيت القير",60000,0],["coolant","سائل التبريد",40000,24],["spark","البواجي",40000,0],["wipers","مساحات الزجاج",0,12]];
  function docs(pre){ var out = []; Object.keys(store).forEach(function(k){ var v = store[k]; if (k.indexOf(pre) === 0 && v && typeof v === "object") out.push(Object.assign({id:k.slice(pre.length)}, v)); }); return out; }
  function num(x){ var n = Number(x); return isFinite(n) ? n : null; }
  function model(){
    var cars = docs("cars/"), ids = cars.map(function(c){ return c.id; }).sort(), cid = lsGet("fuel-cur-car"); if (ids.indexOf(cid) < 0) cid = ids[0] || null;
    var car = cid ? store["cars/" + cid] : null, M = {car:car, cid:cid, many:ids.length > 1, name:car ? ([car.make, car.model].filter(Boolean).join(" ") || "السيارة") : ""};
    var mine = function(x){ return !cid || x.carId === cid; };
    M.fills = docs("fills/").filter(mine).sort(function(a, b){ return String(a.ts) < String(b.ts) ? -1 : 1; });
    M.svcs = docs("services/").filter(mine).sort(function(a, b){ return String(a.ts) < String(b.ts) ? -1 : 1; });
    M.fills.forEach(function(f){ var p = num(f.price), a = num(f.amount); f.L = p > 0 && a > 0 ? a / p : null; });
    /* قراءات العداد: من التعبئات والصيانة وسجل العداد، قراءة واحدة لكل يوم وبترتيب تصاعدي */
    var raw = [];
    M.fills.concat(M.svcs).forEach(function(x){ if (num(x.odo) != null) raw.push({d:String(x.ts).slice(0,10), o:Number(x.odo)}); });
    if (car){ (car.odoLog || []).forEach(function(q){ if (num(q.o) != null) raw.push({d:String(q.t).slice(0,10), o:Number(q.o)}); }); if (num(car.odoNow) != null && car.odoAt) raw.push({d:String(car.odoAt).slice(0,10), o:Number(car.odoNow)}); }
    var byDay = {}; raw.forEach(function(q){ if (/^\d{4}-\d\d-\d\d$/.test(q.d) && (byDay[q.d] == null || q.o > byDay[q.d])) byDay[q.d] = q.o; });
    var pts = []; Object.keys(byDay).sort().forEach(function(d){ if (!pts.length || byDay[d] >= pts[pts.length - 1].o) pts.push({d:d, o:byDay[d], t:new Date(d + "T12:00").getTime()}); });
    M.pts = pts; M.top = pts.length ? pts[pts.length - 1].o : null; M.topDay = pts.length ? pts[pts.length - 1].d : null;
    M.odoAt = function(t){ if (!pts.length) return null; if (t <= pts[0].t) return pts[0].o; for (var i = 1; i < pts.length; i++){ if (t <= pts[i].t){ var A = pts[i - 1], B = pts[i]; return A.o + (B.o - A.o) * (t - A.t) / (B.t - A.t); } } return pts[pts.length - 1].o; };
    /* الممشى اليومي: متوسط كل القراءات المسجّلة (حتى آخر 90 يوماً) = فرق العداد ÷ عدد الأيام */
    var now = Date.now(); M.daily = null; M.dailyDays = 0; M.dailyKm = 0;
    if (pts.length > 1){ var t0 = Math.max(pts[0].t, pts[pts.length - 1].t - 90 * 864e5), span = (pts[pts.length - 1].t - t0) / 864e5; if (span >= 1){ M.dailyKm = Math.max(0, M.top - M.odoAt(t0)); M.dailyDays = Math.round(span); M.daily = M.dailyKm / span; } }
    /* الاستهلاك: لترات كل تعبئة تُحسب على المسافة حتى التعبئة التي بعدها */
    var fo = M.fills.filter(function(f){ return num(f.odo) != null; }); M.iv = [];
    for (var i = 1; i < fo.length; i++){ var dist = Number(fo[i].odo) - Number(fo[i - 1].odo), L = fo[i - 1].L; if (dist > 0) M.iv.push({d:String(fo[i].ts).slice(0,10), dist:dist, L:L, kml:L > 0 ? dist / L : null, id:fo[i].id}); }
    var okIv = M.iv.filter(function(x){ return x.kml > 0; }), sd = 0, sl = 0; okIv.forEach(function(x){ sd += x.dist; sl += x.L; });
    M.kmlAll = sl > 0 ? sd / sl : null; M.kmlLast = okIv.length ? okIv[okIv.length - 1].kml : null; M.kmlSrc = "calc";
    M.lastF = fo.length ? fo[fo.length - 1] : (M.fills.length ? M.fills[M.fills.length - 1] : null);
    /* إن لم تكفِ التعبئات للحساب تُستعمل قراءة شاشة السيارة المسجَّلة مع آخر تعبئة (لتر/100 كم) */
    if (!M.kmlAll){ var withAvg = M.fills.filter(function(f){ return num(f.avg) > 0; }); if (withAvg.length){ var a = withAvg[withAvg.length - 1]; M.kmlAll = String(a.avgUnit || "").indexOf("km/l") === 0 ? Number(a.avg) : 100 / Number(a.avg); M.kmlSrc = "dash"; } }
    M.kml = M.kmlLast || M.kmlAll;
    M.price = M.lastF && num(M.lastF.price) > 0 ? Number(M.lastF.price) : null;
    M.perKm = M.price && M.kmlAll ? M.price / M.kmlAll : null;
    /* التعبئة القادمة:
       المدى = لترات آخر تعبئة × متوسط الاستهلاك (كل التعبئات)، أو قراءة مدى السيارة إن سُجّلت
       الباقي = المدى − ما مُشي منذ التعبئة (حتى آخر قراءة عداد)
       الموعد = تاريخ آخر قراءة + الباقي ÷ متوسط الممشى اليومي */
    M.next = null;
    if (M.lastF && num(M.lastF.odo) != null && M.top != null){
      var range = num(M.lastF.range) > 0 ? Number(M.lastF.range) : (M.lastF.L > 0 && M.kmlAll ? M.lastF.L * M.kmlAll : null), since = Math.max(0, M.top - Number(M.lastF.odo));
      if (range){ var rem = range - since, over = rem <= 0, fd = String(M.lastF.ts).slice(0,10), anchor = M.topDay && M.topDay > fd ? M.topDay : fd, today = todayS(), dt = null, dn = null, last = null;
        if (M.daily > 0){ var e = new Date(anchor + "T12:00"); e.setDate(e.getDate() + Math.max(0, Math.round(Math.max(0, rem) / M.daily))); dt = dS(e); if (dt < today) dt = today; dn = Math.round((new Date(dt + "T12:00") - new Date(today + "T12:00")) / 864e5); last = Math.round(range / M.daily); }
        M.next = {range:range, since:since, rem:Math.max(0, rem), extra:over ? -rem : 0, over:over, pct:Math.max(0, Math.min(100, rem / range * 100)), days:dn, date:dt, lasts:last, anchor:anchor, stale:anchor < today, fromDash:num(M.lastF.range) > 0}; }
      else M.next = {since:since};
    }
    /* مصروف وممشى كل شهر */
    M.month = function(ym){ var f = 0, s = 0, L = 0, nf = 0; M.fills.forEach(function(x){ if (String(x.ts).slice(0,7) === ym){ f += num(x.amount) || 0; L += x.L || 0; nf++; } }); M.svcs.forEach(function(x){ if (String(x.ts).slice(0,7) === ym) s += num(x.cost) || 0; });
      var a = new Date(Number(ym.slice(0,4)), Number(ym.slice(5,7)) - 1, 1, 12).getTime(), b = Math.min(Date.now(), new Date(Number(ym.slice(0,4)), Number(ym.slice(5,7)), 1, 12).getTime()), km = null, partial = false;
      if (pts.length && pts[pts.length - 1].t >= a && pts[0].t <= b){ var ta = Math.max(a, pts[0].t); km = Math.max(0, M.odoAt(b) - M.odoAt(ta)); partial = pts[0].t > a; }
      return {fuel:f, svc:s, total:f + s, L:L, n:nf, km:km, partial:partial, from:partial ? pts[0].d : null}; };
    /* الصيانة: كل بند وما بقي له بالكيلومتر والتاريخ */
    var cfg = {}; docs("items/").forEach(function(x){ cfg[x.id] = x; });
    var list = DEF.map(function(d){ var c = cfg[d[0]] || {}; return {id:d[0], name:c.name || d[1], km:c.km != null ? Number(c.km) : d[2], months:c.months != null ? Number(c.months) : d[3], hidden:!!c.hidden}; });
    Object.keys(cfg).forEach(function(id){ if (!DEF.some(function(d){ return d[0] === id; })) list.push({id:id, name:cfg[id].name || "بند", km:Number(cfg[id].km) || 0, months:Number(cfg[id].months) || 0, hidden:!!cfg[id].hidden}); });
    M.items = list.filter(function(it){ return !it.hidden; }).map(function(it){
      var last = null; M.svcs.forEach(function(s){ if (s.itemId === it.id) last = s; });
      var o = {id:it.id, name:it.name, km:it.km, months:it.months, last:last, remKm:null, remDays:null, dueDate:null, estDate:null, pct:null, st:"none"};
      if (!last) return o;
      if (it.km > 0 && num(last.odo) != null && M.top != null) o.remKm = Number(last.odo) + it.km - M.top;
      if (it.months > 0){ var dd = new Date(String(last.ts).slice(0,10) + "T12:00"); dd.setMonth(dd.getMonth() + it.months); o.dueDate = dS(dd); o.remDays = Math.round((dd.getTime() - new Date(todayS() + "T12:00").getTime()) / 864e5); }
      var eKm = o.remKm != null && M.daily > 0 ? o.remKm / M.daily : null, e = eKm != null && o.remDays != null ? Math.min(eKm, o.remDays) : eKm != null ? eKm : o.remDays;
      if (e != null){ var z = new Date(); z.setDate(z.getDate() + Math.round(e)); o.estDate = dS(z); o.estDays = Math.round(e); }
      var pk = o.remKm != null ? 1 - o.remKm / it.km : null, pm = o.remDays != null ? 1 - o.remDays / (it.months * 30.4) : null; o.pct = Math.max(0, Math.min(100, Math.max(pk == null ? 0 : pk, pm == null ? 0 : pm) * 100));
      o.st = (o.remKm != null && o.remKm <= 0) || (o.remDays != null && o.remDays <= 0) ? "due" : (o.remKm != null && o.remKm <= Math.max(500, it.km * 0.1)) || (o.remDays != null && o.remDays <= 30) ? "near" : "ok";
      return o; });
    return M;
  }

  /* ---------- الواجهة ---------- */
  try { var fl = document.createElement("link"); fl.rel = "stylesheet"; fl.href = "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap"; document.head.appendChild(fl); } catch(e){}
  var css = document.createElement("style");
  css.textContent = "#app-home,#app-tabs{display:none!important}body{padding-bottom:calc(86px + env(safe-area-inset-bottom))}" +
    "#v3,#v3-nav,#v3-add,#v3-det{--i:#14213D;--m:#5B6577;--b:#F3F5F8;--s:#fff;--l:#DDE2EA;--a:#0B6E63;--ab:#E3F2EF;--a2:#B9D8D3;--w:#B4470B;--wb:#FBEDE2;--g:#1E7A46;--gb:#E4F3EA;font-family:'IBM Plex Sans Arabic',system-ui,-apple-system,sans-serif}" +
    "@media (prefers-color-scheme:dark){#v3,#v3-nav,#v3-add,#v3-det{--i:#EEF1F6;--m:#A3ACBB;--b:#12141A;--s:#1B1F27;--l:#2C323D;--a:#7CC4B8;--ab:#16332F;--a2:#2F5952;--w:#E0A46E;--wb:#3A2A1C;--g:#7CC79A;--gb:#17301F}}" +
    "#v3{position:fixed;top:0;left:0;right:0;bottom:calc(72px + env(safe-area-inset-bottom));z-index:6;background:var(--b);color:var(--i);overflow:auto;font-size:15px;line-height:1.5}" +
    "#v3 .in{max-width:560px;margin:0 auto;padding:calc(22px + env(safe-area-inset-top)) 18px 34px;display:flex;flex-direction:column;gap:14px}" +
    "#v3 h1{margin:0;font-size:26px;font-weight:700;line-height:1.3;color:var(--i)}#v3 .sub{margin:0;color:var(--m);font-size:14px}" +
    "#v3 .hd{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}" +
    "#v3 .gb{width:42px;height:42px;border-radius:14px;background:var(--s);border:1px solid var(--l);color:var(--m);display:flex;align-items:center;justify-content:center;flex:none;cursor:pointer;padding:0}" +
    "#v3 .card{background:var(--s);border:1px solid var(--l);border-radius:18px;padding:16px;display:flex;flex-direction:column;gap:10px;font:inherit;color:inherit;text-align:start;width:100%;box-sizing:border-box}" +
    "#v3 button.card{cursor:pointer}" +
    "#v3 .rw{display:flex;justify-content:space-between;align-items:center;gap:10px}#v3 .mu{color:var(--m);font-size:14px}#v3 .mu b{color:var(--i)}" +
    "#v3 .big{display:flex;align-items:baseline;gap:8px}#v3 .big b{font-size:50px;font-weight:700;line-height:1.05;color:var(--a);font-variant-numeric:tabular-nums}#v3 .big span{font-size:18px;color:var(--m)}#v3 .big .dt{margin-inline-start:auto;font-size:16px;font-weight:700;color:var(--i)}#v3 .big.w b{color:var(--w)}" +
    "#v3 .pb{height:10px;border-radius:5px;background:var(--l);overflow:hidden}#v3 .pb i{display:block;height:100%;width:0;background:var(--a);border-radius:5px}#v3 .pb.w i{background:var(--w)}#v3 .pb.g i{background:var(--g)}" +
    "#v3 .chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;background:var(--ab);color:var(--a);font-size:12.5px;font-weight:600;white-space:nowrap}#v3 .chip.w{background:var(--wb);color:var(--w)}#v3 .chip.g{background:var(--gb);color:var(--g)}#v3 .chip.n{background:var(--l);color:var(--m)}" +
    "#v3 .g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}#v3 .g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}" +
    "#v3 .st{background:var(--s);border:1px solid var(--l);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:2px;min-width:0}#v3 .st .k{font-size:12.5px;color:var(--m)}#v3 .st .v{display:flex;align-items:baseline;gap:4px}#v3 .st .v b{font-size:24px;line-height:1.15;font-variant-numeric:tabular-nums}#v3 .st .v span{font-size:12px;color:var(--m)}#v3 .st .d{font-size:12px;font-weight:600;color:var(--m)}#v3 .st .d.g{color:var(--g)}#v3 .st .d.w{color:var(--w)}" +
    "#v3 .sq{width:40px;height:40px;border-radius:12px;background:var(--ab);color:var(--a);display:flex;align-items:center;justify-content:center;flex:none}#v3 .sq.w{background:var(--wb);color:var(--w)}" +
    "#v3 .tx{flex:1;min-width:0;display:flex;flex-direction:column}#v3 .tx small{font-size:13px;color:var(--m)}" +
    "#v3 .al{display:flex;align-items:center;gap:12px;background:var(--wb);border:1px solid var(--wb);border-radius:16px;padding:12px 14px;color:var(--w);font:inherit;font-weight:600;text-align:start;cursor:pointer;width:100%}#v3 .al span{flex:1}" +
    "#v3 .tabs{display:flex;gap:8px;flex-wrap:wrap}#v3 .tabs button{font:inherit;font-weight:600;font-size:14px;padding:8px 16px;border-radius:999px;background:var(--s);color:var(--i);border:1px solid var(--l);cursor:pointer}#v3 .tabs button[aria-pressed=true]{background:var(--a);border-color:var(--a);color:#fff}" +
    "@media (prefers-color-scheme:dark){#v3 .tabs button[aria-pressed=true]{color:#06231f}#v3-nav button.plus{color:#06231f!important}}" +
    "#v3 .lr{display:flex;align-items:center;gap:12px;padding:11px 0;border:0;border-bottom:1px solid var(--l);background:transparent;font:inherit;color:inherit;text-align:start;width:100%;cursor:pointer}#v3 .lr:last-child{border-bottom:0}#v3 .lr>b{font-variant-numeric:tabular-nums}" +
    "#v3 .mi{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid var(--l)}#v3 .mi:last-child{border-bottom:0;padding-bottom:0}#v3 .mi:first-child{padding-top:0}" +
    "#v3 .bars{display:flex;align-items:flex-end;gap:10px;height:128px}#v3 .bars div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%;min-width:0}#v3 .bars i{display:block;width:100%;border-radius:8px 8px 3px 3px;background:var(--a2);min-height:2px}#v3 .bars .on i{background:var(--a)}#v3 .bars span{font-size:11.5px;color:var(--m);font-variant-numeric:tabular-nums;white-space:nowrap}#v3 .bars .on span:first-child{color:var(--i);font-weight:700}" +
    "#v3 .btn{display:block;text-align:center;padding:14px;border-radius:14px;background:var(--s);border:1px solid var(--l);color:var(--a);font:inherit;font-weight:700;cursor:pointer;width:100%}" +
    "#v3 .note{margin:0;text-align:center;color:var(--m);font-size:13px}#v3 .ln{border-top:1px solid var(--l);padding-top:10px;color:var(--m);font-size:13px}#v3 .sm{color:var(--m);font-size:12.5px}" +
    "#v3-nav{position:fixed;left:0;right:0;bottom:0;z-index:7;height:calc(72px + env(safe-area-inset-bottom));padding:0 6px env(safe-area-inset-bottom);box-sizing:border-box;background:var(--s);border-top:1px solid var(--l);display:grid;grid-template-columns:1fr 1fr 76px 1fr 1fr;align-items:center}" +
    "#v3-nav button{font:inherit;border:0;background:transparent;color:var(--m);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:12px;font-weight:500;min-height:52px;cursor:pointer}" +
    "#v3-nav button[aria-current=page]{color:var(--a);font-weight:700}" +
    "#v3-nav button.plus{width:60px;height:60px;min-height:60px;margin:-26px auto 0;border-radius:30px;border:4px solid var(--b);background:var(--a);color:#fff}" +
    "#v3-add,#v3-det{border:1px solid var(--l);border-radius:20px;padding:20px;background:var(--b);color:var(--i);width:min(94vw,440px);max-height:86vh;box-sizing:border-box}#v3-add::backdrop,#v3-det::backdrop{background:rgba(0,0,0,.45)}" +
    "#v3-add h2,#v3-det h2{margin:0 0 4px;font-size:22px}#v3-add p,#v3-det p{margin:0 0 12px;color:var(--m);font-size:14px}#v3-add .os{display:flex;flex-direction:column;gap:10px}" +
    "#v3-add .o{display:flex;align-items:center;gap:14px;width:100%;text-align:start;font:inherit;color:var(--i);background:var(--s);border:1px solid var(--l);border-radius:16px;padding:14px;cursor:pointer}" +
    "#v3-add .o .sq{width:46px;height:46px;border-radius:14px;background:var(--ab);color:var(--a);display:flex;align-items:center;justify-content:center;flex:none}#v3-add .o span.t{flex:1;display:flex;flex-direction:column}#v3-add .o b{font-size:17px}#v3-add .o small{color:var(--m);font-size:13px}#v3-add .o>svg{color:var(--m)}" +
    "#v3-add .x,#v3-det .x{margin-top:12px;width:100%;font:inherit;font-weight:600;color:var(--i);background:var(--s);border:1px solid var(--l);border-radius:14px;padding:13px;cursor:pointer}#v3-det .pr{margin-top:12px;width:100%;font:inherit;font-weight:700;color:#fff;background:var(--a);border:0;border-radius:14px;padding:13px;cursor:pointer}" +
    "#v3-det ul{list-style:none;margin:0;padding:0}#v3-det li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--l)}#v3-det li:last-child{border-bottom:0}#v3-det li span{color:var(--m)}#v3-det li b{font-variant-numeric:tabular-nums;text-align:end}";
  document.head.appendChild(css);
  var v3 = document.createElement("div"); v3.id = "v3"; v3.innerHTML = '<div class="in" id="v3-in"></div>';
  var nav = document.createElement("nav"); nav.id = "v3-nav"; nav.setAttribute("aria-label", "التنقل");
  nav.innerHTML = '<button type="button" data-go="home">' + ico(I.home) + '<span>الرئيسية</span></button><button type="button" data-go="log">' + ico(I.list) + '<span>السجل</span></button>' +
    '<button type="button" class="plus" id="v3-plus" aria-label="إضافة">' + ico(I.plus, 28) + '</button>' +
    '<button type="button" data-go="mnt">' + ico(I.tool) + '<span>الصيانة</span></button><button type="button" data-go="stat">' + ico(I.chart) + '<span>الإحصائيات</span></button>';
  var add = document.createElement("dialog"); add.id = "v3-add"; add.setAttribute("aria-labelledby", "v3-add-h");
  function opt(k, ic, t, s){ return '<button type="button" class="o" data-add="' + k + '"><span class="sq">' + ico(I[ic], 24) + '</span><span class="t"><b>' + t + '</b><small>' + s + '</small></span>' + ico(I.chev, 18) + '</button>'; }
  add.innerHTML = '<h2 id="v3-add-h">إضافة</h2><p>ماذا تريد أن تسجّل؟</p><div class="os">' + opt("fuel", "fuel", "تعبئة بنزين", "العداد ثم مبلغ التعبئة") + opt("svc", "tool", "صيانة", "زيت، إطارات، فلاتر، وغيرها") + opt("odo", "gauge", "قراءة العداد", "لتحديث الممشى فقط، بلا مصروف") + '</div><button type="button" class="x" id="v3-add-x">إلغاء</button>';
  var det = document.createElement("dialog"); det.id = "v3-det"; det.setAttribute("aria-labelledby", "v3-det-h");
  det.innerHTML = '<h2 id="v3-det-h"></h2><div id="v3-det-b"></div><button type="button" class="pr" id="v3-det-go">فتح صفحة السيارة للتعديل</button><button type="button" class="x" id="v3-det-x">إغلاق</button>';
  document.body.appendChild(v3); document.body.appendChild(nav); document.body.appendChild(add); document.body.appendChild(det);

  /* العودة تلقائياً بعد إغلاق نوافذ التسجيل في صفحة السيارة */
  var watch = null;
  function back(to){
    if (watch) clearInterval(watch);
    var seen = false, quiet = 0, t0 = Date.now();
    watch = setInterval(function(){
      var open = [].some.call(document.querySelectorAll("dialog[open]"), function(d){ return d !== add && d !== det; });
      if (open){ seen = true; quiet = 0; return; }
      if (seen && ++quiet >= 2){ clearInterval(watch); watch = null; go(to); }
      else if (!seen && Date.now() - t0 > 120000){ clearInterval(watch); watch = null; }
    }, 350);
  }
  function stat(k, v, u, d, cls){ return '<div class="st"><span class="k">' + k + '</span><div class="v"><b>' + v + '</b><span>' + u + '</span></div>' + (d ? '<span class="d' + (cls ? " " + cls : "") + '">' + d + '</span>' : '') + '</div>'; }
  function prevYm(ym, n){ var d = new Date(Number(ym.slice(0,4)), Number(ym.slice(5,7)) - 1 - (n == null ? 1 : n), 1); return d.getFullYear() + "-" + pad(d.getMonth() + 1); }
  function mntSub(o){
    if (!o.last) return "لم تُسجَّل له صيانة بعد";
    var p = [];
    if (o.remKm != null) p.push(o.remKm > 0 ? "باقي " + n0(o.remKm) + " كم" : "تجاوز " + n0(-o.remKm) + " كم");
    if (o.estDate) p.push((o.estDays > 0 ? "نحو " : "منذ ") + dShort(o.estDate)); else if (o.remDays != null) p.push(o.remDays > 0 ? "باقي " + days(o.remDays) : "تجاوز " + days(-o.remDays));
    p.push("كل " + [o.km > 0 ? n0(o.km) + " كم" : "", o.months > 0 ? (o.months % 12 === 0 ? (o.months / 12 === 1 ? "سنة" : o.months / 12 === 2 ? "سنتين" : o.months / 12 + " سنوات") : o.months + " أشهر") : ""].filter(Boolean).join(" أو "));
    return p.join(" · ");
  }
  /* قراءة العداد عند آخر تغيير، والقراءة الحالية، وما مُشي بينهما */
  function odoLine(o, M){
    if (!o.last) return "";
    var at = num(o.last.odo), p = ["آخر تغيير " + dShort(o.last.ts) + (at != null ? " عند " + n0(at) + " كم" : "")];
    if (M.top != null) p.push("العداد الآن " + n0(M.top) + " كم");
    if (at != null && M.top != null && M.top >= at) p.push("مشيت " + n0(M.top - at) + " كم");
    return '<small>' + esc(p.join(" · ")) + '</small>';
  }
  var ST = {due:["حان", "w"], near:["اقترب", "w"], ok:["جيد", "g"], none:["غير مسجّل", "n"]};

  function rHome(M){
    var tail = "";
    var h = '<div class="hd"><div><h1>دفتر البنزين</h1><p class="sub">' + esc(M.car ? M.name + (M.top != null ? " · العداد " + n0(M.top) + " كم" : "") : "لم تُضف سيارة بعد") + '</p></div><button type="button" class="gb" data-set="1" aria-label="الإعدادات وصفحة السيارة">' + ico(I.gear, 21) + '</button></div>';
    var due = false; try { due = S.odoDue(); } catch(e){}
    if (due) h += '<button type="button" class="al" data-add="odo">' + ico(I.gauge) + '<span>سجّل قراءة العداد ليبقى التقدير دقيقاً</span>' + ico(I.chev, 18) + '</button>';
    if (!M.car || (!M.fills.length && M.top == null)) return h + '<div class="card"><b>ابدأ بأول تعبئة</b><p class="sub">اضغط زر الإضافة وسجّل قراءة العداد ومبلغ التعبئة، وتظهر هنا التقديرات والإحصائيات.</p></div>';
    var nx = M.next, lastNote = M.lastF ? '<div class="ln">آخر تعبئة: ' + esc(dShort(M.lastF.ts)) + ' · ' + n0(M.lastF.amount) + ' ريال' + (M.lastF.L ? ' · ' + n1(M.lastF.L) + ' لتراً' : '') + '</div>' : '';
    if (nx && nx.range){
      /* الأساس هو الكيلومترات الباقية؛ الوقت المتوقع ملاحظة صغيرة تحتها */
      var low = nx.pct <= 15, when = nx.over ? "" : nx.days == null ? "" : "الوقت المتوقع: " + (nx.days === 0 ? "خلال اليوم" : "بعد نحو " + days(nx.days) + " · " + dLong(nx.date));
      h += '<button type="button" class="card" data-det="next"><div class="rw"><span class="mu">الباقي حتى التعبئة القادمة</span><span class="chip' + (nx.over ? " w" : "") + '">' + (nx.over ? "من الاحتياطي" : "تقديري") + '</span></div>' +
        '<div class="big' + (low ? " w" : "") + '"><b>' + n0(nx.rem) + '</b><span>كم</span></div>' +
        '<div class="pb' + (low ? " w" : "") + '"><i data-w="' + nx.pct + '"></i></div>' +
        (nx.over ? '<div class="rw mu"><span>تجاوزت التقدير بـ <b>' + n0(nx.extra) + '</b> كم؛ الباقي من احتياطي الخزان</span></div>' : '<div class="rw mu"><span>في الخزان نحو <b>' + n0(nx.pct) + '%</b></span><span>مشيت <b>' + n0(nx.since) + '</b> من <b>' + n0(nx.range) + '</b> كم</span></div>') +
        (when ? '<div class="sm">' + esc(when) + '</div>' : '') +
        (nx.stale ? '<div class="sm">آخر قراءة للعداد ' + esc(dShort(nx.anchor)) + '؛ سجّل العداد ليتحدّث التقدير</div>' : '') + lastNote + '</button>';
    } else h += '<div class="card"><span class="mu">التعبئة القادمة</span><p class="sub">يظهر التقدير بعد تسجيل تعبئة بقراءة العداد' + (M.daily ? "" : " وقراءتين للعداد في يومين مختلفين") + '.</p>' + lastNote + '</div>';
    var ym = todayS().slice(0,7), a = M.month(ym), b = M.month(prevYm(ym)), kd = "", kc = "";
    if (M.kmlLast && M.kmlAll && M.iv.length > 1){ var df = M.kmlLast - M.kmlAll; kd = Math.abs(df) < 0.15 ? "مثل معدلك " + n1(M.kmlAll) : (df > 0 ? "أفضل من معدلك " : "أقل من معدلك ") + n1(M.kmlAll); kc = df > 0.15 ? "g" : df < -0.15 ? "w" : ""; }
    else if (M.kmlSrc === "dash" && M.kml) kd = "من قراءة شاشة السيارة";
    var md = "", mc = ""; if (b.total > 0 && a.total > 0){ var pc = Math.round((a.total - b.total) / b.total * 100); md = pc === 0 ? "مثل " + mShort(prevYm(ym)) : (pc < 0 ? "أقل " : "أكثر ") + Math.abs(pc) + "% من " + mShort(prevYm(ym)); mc = pc < 0 ? "g" : pc > 0 ? "w" : ""; } else if (a.n) md = a.n + (a.n === 1 ? " تعبئة" : a.n === 2 ? " تعبئتان" : " تعبئات");
    h += '<div class="g2">' + stat("الاستهلاك", M.kml ? n1(M.kml) : "—", "كم/لتر", kd, kc) + stat("تكلفة الكيلومتر", M.perKm ? n2(M.perKm) : "—", "ريال/كم", M.perKm ? "بنزين فقط" : "") + '</div>' +
      '<div class="g2">' + stat("مصروف " + mShort(ym), n0(a.total), "ريال", md, mc) + stat("ممشى " + mShort(ym), a.km != null ? n0(a.km) : "—", "كم", M.daily ? n0(M.daily) + " كم يومياً" : (a.from ? "منذ " + dShort(a.from) : "")) + '</div>';
    var nxt = M.items.filter(function(o){ return o.last && o.st !== "none"; }).sort(function(x, y){ return (x.estDays == null ? 1e9 : x.estDays) - (y.estDays == null ? 1e9 : y.estDays); })[0];
    if (nxt){ var w = nxt.st !== "ok"; h += '<button type="button" class="card" data-go="mnt"><div class="rw"><span class="sq' + (w ? " w" : "") + '">' + ico(I.tool, 20) + '</span><span class="tx"><b>' + esc(nxt.name) + '</b><small>' + esc(mntSub(nxt).split(" · ").slice(0, 2).join(" · ")) + '</small>' + odoLine(nxt, M) + '</span>' + ico(I.chev, 18) + '</div><div class="pb' + (w ? " w" : " g") + '"><i data-w="' + nxt.pct + '"></i></div></button>'; }
    if (lsGet("masroof-v1")) tail = '<button type="button" class="btn" data-exp="1">مصروف البيت: بياناتك محفوظة · فتح</button>';
    /* ملاحظة آخر تعبئة صارت داخل بطاقة التعبئة القادمة */
    return h + tail;
  }
  function logRows(M){
    var ivBy = {}; M.iv.forEach(function(x){ ivBy[x.id] = x; });
    var rows = M.fills.map(function(f){ var iv = ivBy[f.id]; return {k:"f", id:f.id, d:String(f.ts).slice(0,10), ts:String(f.ts), a:num(f.amount) || 0, t:"تعبئة" + (f.L ? " · " + n1(f.L) + " لتراً" : ""), s:[iv ? n0(iv.dist) + " كم" : "", iv && iv.kml ? n1(iv.kml) + " كم/لتر" : ""].filter(Boolean).join(" · "), f:f, iv:iv}; })
      .concat(M.svcs.map(function(s){ var it = M.items.filter(function(o){ return o.id === s.itemId; })[0]; return {k:"s", id:s.id, d:String(s.ts).slice(0,10), ts:String(s.ts), a:num(s.cost) || 0, t:it ? it.name : (s.note || "صيانة"), s:num(s.odo) != null ? "عند " + n0(s.odo) + " كم" : "", v:s}; }));
    return rows.sort(function(x, y){ return x.ts < y.ts ? 1 : -1; });
  }
  function rLog(M){
    var h = '<div><h1>السجل</h1><p class="sub">كل التعبئات والصيانة</p></div><div class="tabs">' + [["all","الكل"],["f","تعبئات"],["s","صيانة"]].map(function(t){ return '<button type="button" data-lf="' + t[0] + '" aria-pressed="' + (logF === t[0]) + '">' + t[1] + '</button>'; }).join("") + '</div>';
    var rows = logRows(M).filter(function(r){ return logF === "all" || r.k === logF; });
    if (!rows.length) return h + '<div class="card"><p class="sub">لا توجد سجلات بعد.</p></div>';
    var by = {}, ord = []; rows.forEach(function(r){ var m = r.d.slice(0,7); if (!by[m]){ by[m] = []; ord.push(m); } by[m].push(r); });
    ord.forEach(function(m){ var mm = M.month(m), tot = by[m].reduce(function(a, r){ return a + r.a; }, 0);
      h += '<div class="card"><div class="rw mu"><span>' + esc(mName(m)) + '</span><span>' + n0(tot) + ' ريال' + (logF === "all" && mm.km != null ? ' · ' + n0(mm.km) + ' كم' : '') + '</span></div><div>' + by[m].map(function(r){
        return '<button type="button" class="lr" data-row="' + r.k + ":" + esc(r.id) + '"><span class="sq' + (r.k === "s" ? " w" : "") + '">' + ico(r.k === "s" ? I.tool : I.fuel, 19) + '</span><span class="tx"><b>' + esc(r.t) + '</b><small>' + esc(dShort(r.d) + (r.s ? " · " + r.s : "")) + '</small></span><b>' + n0(r.a) + '</b></button>'; }).join("") + '</div></div>'; });
    return h + '<p class="note">اضغط أي سطر لعرض تفاصيله</p>';
  }
  function rMnt(M){
    var h = '<div><h1>الصيانة</h1><p class="sub">ما حان وما اقترب، بالكيلومتر والتاريخ</p></div>';
    var rank = {due:0, near:1, ok:2, none:3}, list = M.items.slice().sort(function(x, y){ return rank[x.st] - rank[y.st] || (x.estDays == null ? 1e9 : x.estDays) - (y.estDays == null ? 1e9 : y.estDays); });
    var known = list.filter(function(o){ return o.last; }), unk = list.filter(function(o){ return !o.last; });
    if (known.length) h += '<div class="card"><div>' + known.map(function(o){ var c = ST[o.st]; return '<div class="mi"><div class="rw"><span class="tx"><b>' + esc(o.name) + '</b><small>' + esc(mntSub(o)) + '</small>' + odoLine(o, M) + '</span><span class="chip ' + c[1] + '">' + c[0] + '</span></div><div class="pb ' + (o.st === "ok" ? "g" : "w") + '"><i data-w="' + o.pct + '"></i></div></div>'; }).join("") + '</div></div>';
    else h += '<div class="card"><p class="sub">لم تُسجَّل أي صيانة بعد. سجّل آخر تغيير زيت مثلاً ليبدأ حساب الموعد القادم.</p></div>';
    var y = todayS().slice(0,4), yc = 0; M.svcs.forEach(function(s){ if (String(s.ts).slice(0,4) === y) yc += num(s.cost) || 0; });
    var first = M.pts.length ? M.pts[0] : null, yKm = first ? Math.max(0, M.top - M.odoAt(Math.max(first.t, new Date(Number(y), 0, 1, 12).getTime()))) : 0;
    h += '<div class="g2">' + stat("صيانة هذا العام", n0(yc), "ريال") + stat("نصيب الكيلومتر", yKm > 0 && yc > 0 ? n2(yc / yKm) : "—", "ريال/كم") + '</div>';
    if (unk.length) h += '<p class="note">بنود بلا سجل: ' + esc(unk.map(function(o){ return o.name; }).join("، ")) + '</p>';
    return h + '<button type="button" class="btn" data-open="mnt">تسجيل صيانة أو تعديل البنود والمواعيد</button>';
  }
  function rStat(M){
    var h = '<div><h1>الإحصائيات</h1><p class="sub">' + (statP === 0 ? "كل السجلات" : statP === 12 ? "آخر 12 شهراً" : "آخر 6 أشهر") + '</p></div><div class="tabs">' + [[6,"6 أشهر"],[12,"السنة"],[0,"الكل"]].map(function(t){ return '<button type="button" data-sp="' + t[0] + '" aria-pressed="' + (statP === t[0]) + '">' + t[1] + '</button>'; }).join("") + '</div>';
    var ym = todayS().slice(0,7), ms = []; for (var i = 5; i >= 0; i--) ms.push(prevYm(ym, i));
    var vals = ms.map(function(m){ return M.month(m).total; }), mx = Math.max.apply(null, vals);
    h += '<div class="card"><div class="rw"><b>المصروف الشهري</b><span class="mu">بنزين وصيانة · ريال</span></div>' + (mx > 0 ? '<div class="bars">' + ms.map(function(m, i){ return '<div' + (i === 5 ? ' class="on"' : '') + '><span>' + (vals[i] ? n0(vals[i]) : "") + '</span><i data-h="' + Math.round(vals[i] / mx * 84) + '"></i><span>' + esc(mShort(m)) + '</span></div>'; }).join("") + '</div>' : '<p class="sub">لا مصروفات مسجّلة في هذه الأشهر.</p>') + '</div>';
    var iv = M.iv.filter(function(x){ return x.kml > 0; }).slice(-8);
    h += '<div class="card"><div class="rw"><b>الاستهلاك</b><span class="mu">كم/لتر' + (M.kmlAll && iv.length > 1 ? ' · المنقّط معدلك ' + n1(M.kmlAll) : '') + '</span></div>';
    if (iv.length > 1){ var lo = Math.min.apply(null, iv.map(function(x){ return x.kml; })), hi = Math.max.apply(null, iv.map(function(x){ return x.kml; })), pd = Math.max(0.3, (hi - lo) * 0.25); lo -= pd; hi += pd;
      var X = function(i){ return 16 + i * (318 / (iv.length - 1)); }, Y = function(v){ return 76 - (v - lo) / (hi - lo) * 66; };
      h += '<svg role="img" aria-label="اتجاه الاستهلاك" viewBox="0 0 350 84" width="100%" height="84"><path d="M0 ' + Y(M.kmlAll).toFixed(1) + ' H350" fill="none" stroke="var(--l)" stroke-width="1.5" stroke-dasharray="4 4"/><polyline fill="none" stroke="var(--a)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="' + iv.map(function(x, i){ return X(i).toFixed(1) + "," + Y(x.kml).toFixed(1); }).join(" ") + '"/>' +
        iv.map(function(x, i){ var l = i === iv.length - 1; return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(x.kml).toFixed(1) + '" r="' + (l ? 5 : 3.5) + '" fill="' + (l ? "var(--a)" : "var(--s)") + '" stroke="var(--a)" stroke-width="2"/>'; }).join("") + '</svg><div class="rw mu"><span>الأقل <b>' + n1(Math.min.apply(null, iv.map(function(x){ return x.kml; }))) + '</b></span><span>آخر تعبئة <b>' + n1(iv[iv.length - 1].kml) + '</b></span><span>الأفضل <b>' + n1(Math.max.apply(null, iv.map(function(x){ return x.kml; }))) + '</b></span></div>'; }
    else h += '<p class="sub">' + (M.kml ? "الاستهلاك الحالي " + n1(M.kml) + " كم/لتر" + (M.kmlSrc === "dash" ? " (من قراءة شاشة السيارة)" : "") + ". " : "") + 'يظهر الرسم بعد ثلاث تعبئات مسجّلة بالعداد.</p>';
    h += '</div>';
    /* مجاميع الفترة */
    var t1 = Date.now(), t0 = statP ? new Date(new Date().getFullYear(), new Date().getMonth() - statP + 1, 1, 12).getTime() : (M.pts.length ? M.pts[0].t : t1), inP = function(x){ var t = new Date(String(x.ts).slice(0,10) + "T12:00").getTime(); return t >= t0 && t <= t1 + 864e5; };
    var fu = 0, sv = 0, L = 0; M.fills.filter(inP).forEach(function(f){ fu += num(f.amount) || 0; L += f.L || 0; }); M.svcs.filter(inP).forEach(function(s){ sv += num(s.cost) || 0; });
    var first = M.pts.length ? M.pts[0].t : null, a0 = first != null ? Math.max(t0, first) : null, km = a0 != null ? Math.max(0, M.top - M.odoAt(a0)) : null;
    var firstRec = Math.min.apply(null, M.fills.concat(M.svcs).map(function(x){ return new Date(String(x.ts).slice(0,10) + "T12:00").getTime(); }).concat([t1])), dd = Math.max(1, Math.round((t1 - Math.max(t0, firstRec)) / 864e5) + 1);
    h += '<div class="g3">' + stat("المسافة", km != null ? n0(km) : "—", "كم") + stat("المجموع", n0(fu + sv), "ريال") + stat("تكلفة اليوم", n0((fu + sv) / dd), "ريال") + '</div>' +
      '<div class="g3">' + stat("البنزين", n0(fu), "ريال") + stat("الصيانة", n0(sv), "ريال") + stat("اللترات", n0(L), "لتر") + '</div>';
    return h + '<p class="note">المسافة من قراءات العداد المسجّلة؛ كلما سجّلت العداد أكثر كانت الأرقام أدق.</p>';
  }
  var lastM = null;
  function draw(){
    var M = lastM = model();
    $("v3-in").innerHTML = cur === "log" ? rLog(M) : cur === "mnt" ? rMnt(M) : cur === "stat" ? rStat(M) : rHome(M);
    /* المقاسات تُضبط بالسكربت لأن سياسة أمان الصفحة تمنع الأنماط المضمّنة */
    [].forEach.call(v3.querySelectorAll(".pb i[data-w]"), function(b){ b.style.width = b.dataset.w + "%"; });
    [].forEach.call(v3.querySelectorAll(".bars i[data-h]"), function(b){ b.style.height = b.dataset.h + "px"; });
  }
  function mark(k){ [].forEach.call(nav.querySelectorAll("button[data-go]"), function(b){ b.setAttribute("aria-current", b.dataset.go === k ? "page" : "false"); }); }
  function go(k){ cur = k; v3.hidden = false; mark(k); try { S.stats(); } catch(e){} draw(); v3.scrollTop = 0; }
  window.__shellHook = function(v){ if (v === "car" || v === "exp"){ v3.hidden = true; mark(""); } };
  function doAdd(k){
    var prev = cur;
    if (k === "odo"){ S.show("car"); try { $("mnt-open").click(); $("odo-open").click(); } catch(e){} back(prev); return; }
    S.addCar(); back(prev);
  }
  function showDet(title, rows, canEdit){
    $("v3-det-h").textContent = title; $("v3-det-b").innerHTML = '<ul>' + rows.filter(function(r){ return r && r[1] != null && r[1] !== ""; }).map(function(r){ return '<li><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></li>'; }).join("") + '</ul>';
    $("v3-det-go").hidden = !canEdit; try { det.showModal(); } catch(e){ det.setAttribute("open", ""); } det.scrollTop = 0;
  }
  nav.addEventListener("click", function(ev){ var b = ev.target.closest("button"); if (!b) return; if (b.id === "v3-plus"){ try { add.showModal(); } catch(e){ add.setAttribute("open", ""); } return; } if (b.dataset.go) go(b.dataset.go); });
  add.addEventListener("click", function(ev){ if (ev.target.closest("#v3-add-x")){ add.close(); return; } var b = ev.target.closest("button[data-add]"); if (!b) return; add.close(); doAdd(b.dataset.add); });
  det.addEventListener("click", function(ev){ if (ev.target.closest("#v3-det-x")){ det.close(); return; } if (ev.target.closest("#v3-det-go")){ det.close(); S.show("car"); } });
  v3.addEventListener("click", function(ev){
    var b = ev.target.closest("button"); if (!b) return; var M = lastM || model();
    if (b.dataset.set){ S.show("car"); return; }
    if (b.dataset.exp){ S.show("exp"); return; }
    if (b.dataset.add){ doAdd(b.dataset.add); return; }
    if (b.dataset.go){ go(b.dataset.go); return; }
    if (b.dataset.lf){ logF = b.dataset.lf; draw(); return; }
    if (b.dataset.sp != null && b.dataset.sp !== ""){ statP = Number(b.dataset.sp); draw(); return; }
    if (b.dataset.open === "mnt"){ var prev = cur; S.show("car"); try { $("mnt-open").click(); } catch(e){} back(prev); return; }
    if (b.dataset.det === "next" && M.next){ var nx = M.next, f = M.lastF;
      showDet("كيف حُسبت التعبئة القادمة", [
        ["١) متوسط الاستهلاك", M.kmlAll ? n1(M.kmlAll) + " كم/لتر" + (M.kmlSrc === "dash" ? " (شاشة السيارة)" : " (كل التعبئات)") : ""],
        ["٢) مدى آخر تعبئة", nx.fromDash ? n0(nx.range) + " كم (قراءة السيارة)" : (f.L ? n1(f.L) + " لتر × " + n1(M.kmlAll) + " = " + n0(nx.range) + " كم" : n0(nx.range) + " كم")],
        ["٣) مشيت منذ التعبئة", n0(M.top) + " − " + n0(f.odo) + " = " + n0(nx.since) + " كم"],
        ["٤) الباقي", nx.over ? "صفر (تجاوزت التقدير بـ " + n0(nx.extra) + " كم)" : n0(nx.range) + " − " + n0(nx.since) + " = " + n0(nx.rem) + " كم"],
        ["٥) متوسط ممشاك اليومي", M.daily ? n0(M.dailyKm) + " كم ÷ " + M.dailyDays + " يوماً = " + n0(M.daily) + " كم" : "غير معروف بعد"],
        ["٦) الأيام الباقية", M.daily ? n0(nx.rem) + " ÷ " + n0(M.daily) + " = " + n1(nx.rem / M.daily) + " يوم من " + dShort(nx.anchor) : ""],
        ["الوقت المتوقع", nx.over ? "" : nx.date ? (nx.days === 0 ? "خلال اليوم" : "بعد نحو " + days(nx.days) + " · " + dLong(nx.date)) : "تحتاج قراءتين للعداد في يومين مختلفين"],
        ["التعبئة كاملةً تكفي", nx.lasts ? "نحو " + days(nx.lasts) : ""],
        ["ملاحظة", nx.over ? "التقدير لا يحسب ما كان في الخزان قبل التعبئة، لذلك قد يبقى بنزين بعد انتهائه." : "التقدير يتحسن كلما زادت التعبئات وقراءات العداد المسجّلة."]], false); return; }
    if (b.dataset.row){ var p = b.dataset.row.split(":"), r = logRows(M).filter(function(x){ return x.k === p[0] && x.id === p.slice(1).join(":"); })[0]; if (!r) return;
      if (r.k === "f"){ var f2 = r.f, iv = r.iv; showDet("تعبئة " + dShort(r.d), [["المبلغ", n2(r.a) + " ريال"], ["النوع وسعر اللتر", (f2.type ? "بنزين " + f2.type + " · " : "") + (num(f2.price) ? n2(f2.price) + " ريال" : "")], ["اللترات", f2.L ? n1(f2.L) + " لتر" : ""], ["العداد", num(f2.odo) != null ? n0(f2.odo) + " كم" : ""],
          ["المسافة منذ التعبئة السابقة", iv ? n0(iv.dist) + " كم" : ""], ["استهلاك تلك المسافة", iv && iv.kml ? n1(iv.kml) + " كم/لتر" : ""], ["قراءة شاشة السيارة", num(f2.avg) > 0 ? n1(f2.avg) + " " + (String(f2.avgUnit || "").indexOf("km/l") === 0 ? "كم/لتر" : "لتر/100 كم") : ""], ["المدى بعد التعبئة", num(f2.range) > 0 ? n0(f2.range) + " كم" : ""]], true); }
      else { var s2 = r.v; showDet(r.t, [["التاريخ", dLong(r.d)], ["التكلفة", n2(r.a) + " ريال"], ["العداد", num(s2.odo) != null ? n0(s2.odo) + " كم" : ""], ["ملاحظة", s2.note || ""]], true); }
      return; }
  });
  /* تنبيه العداد يظهر في وقته حتى لو كان التطبيق مفتوحاً */
  var dueWas = false; setInterval(function(){ if (v3.hidden || document.hidden || cur !== "home") return; var d = false; try { S.stats(); d = S.odoDue(); } catch(e){} if (d !== dueWas){ dueWas = d; draw(); } }, 60000);
  document.addEventListener("visibilitychange", function(){ if (!document.hidden && !v3.hidden) go(cur); });
  window.addEventListener("storage", function(){ if (!v3.hidden) draw(); });
  go("home");
})();

if ("serviceWorker" in navigator && location.protocol === "https:"){
  navigator.serviceWorker.register("sw.js").catch(function(){});
}
})();
