/* ===== 通用产线工坊 · SPA（原生 JS，无依赖） =====
   核心概念：
     产线流程 flow  —— 一套自定义的流程模板（可增删改名设默认）
     环节     step  —— flow 下的一个阶段（名称自定义、可增删重排启停设门）
     记录     record—— 挂在「流程 + 环节」下，单表邻接（parent 指向上一环节的记录）

   渲染策略（性能要点）：
     · nav()  —— 路由级渲染，只有【切换页面 / 切流程】才走这里
     · 写操作（删附件 / 存属性 / 评审 / 建子记录）一律【局部更新】，
       只重画受影响的区块，绝不整页重渲染
     · 独立请求并行发出（Promise.all），减少串行往返
     · flows / meta / attr-defs 带缓存，仅配置页改动后失效
   ================================================= */
"use strict";

const API = "/api/";
const FLOW_KEY = "pw_flow";

/* ---------- 缓存层 ---------- */
const Store = {
  meta: null,
  flows: null,
  defs: {},
};
function invalidateFlows() { Store.flows = null; Store.defs = {}; }
function invalidateDefs(flowId, stepId) { delete Store.defs[flowId + ":" + stepId]; }

async function ensureMeta() {
  if (!Store.meta) Store.meta = await api("GET", "meta");
  return Store.meta;
}
async function ensureFlows() {
  if (!Store.flows) Store.flows = await api("GET", "flows");
  return Store.flows;
}
async function ensureDefs(flowId, stepId) {
  const k = flowId + ":" + stepId;
  if (!Store.defs[k]) Store.defs[k] = await api("GET", "attr-defs?flow=" + flowId + "&step=" + stepId);
  return Store.defs[k];
}

/* ---------- 导航令牌：防止过期请求回写 ---------- */
let NAV = 0;

/* ---------- 工具 ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}
function fmtTime(t) { return t ? String(t).slice(0, 16) : ""; }
function relTime(t) {
  if (!t) return "";
  const d = new Date(String(t).replace(/-/g, "/"));
  if (isNaN(d.getTime())) return fmtTime(t);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  if (s < 86400 * 30) return Math.floor(s / 86400) + " 天前";
  return fmtTime(t).slice(0, 10);
}
function extOf(n) { return (String(n).split(".").pop() || "").toLowerCase(); }
function isImg(n) { return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].indexOf(extOf(n)) >= 0; }
function isVid(n) { return ["mp4", "webm", "mov", "m4v"].indexOf(extOf(n)) >= 0; }
function isAud(n) { return ["mp3", "wav", "m4a", "ogg", "flac"].indexOf(extOf(n)) >= 0; }
function kindOf(n) { return isVid(n) ? "v" : isAud(n) ? "a" : "i"; }
function icoOf(n) { return isImg(n) ? "🖼" : isVid(n) ? "🎬" : isAud(n) ? "🎧" : "📄"; }
function canPv(n) { return isImg(n) || isVid(n) || isAud(n); }

function toast(msg, type) {
  const d = document.createElement("div");
  d.className = "toast" + (type ? " " + type : "");
  d.textContent = msg;
  $("#toastRoot").appendChild(d);
  requestAnimationFrame(() => d.classList.add("in"));
  setTimeout(() => { d.classList.remove("in"); setTimeout(() => d.remove(), 220); }, 3000);
}

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(API + path, opt);
  if (r.status === 401) {
    location.href = "/";
    throw new Error("登录已过期，请重新输入访问口令");
  }
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  if (!r.ok) {
    const err = new Error((j && j.error) || ("请求失败 HTTP " + r.status));
    err.status = r.status;
    throw err;
  }
  return j;
}

/* ---------- 当前状态 ---------- */
let CUR = { flowId: null, attStepId: null };

function curFlow() {
  const fl = Store.flows || [];
  if (!fl.length) return null;
  let f = fl.filter(x => x.id === CUR.flowId)[0];
  if (!f) f = fl.filter(x => x.is_default)[0] || fl[0];
  CUR.flowId = f.id;
  return f;
}
function saveFlowSel(id) {
  CUR.flowId = id;
  try { localStorage.setItem(FLOW_KEY, String(id)); } catch (e) { }
}
function loadFlowSel() {
  try {
    const v = parseInt(localStorage.getItem(FLOW_KEY) || "0", 10);
    if (v) CUR.flowId = v;
  } catch (e) { }
}
const effSteps = f => (f ? (f.steps || []).filter(s => s.enabled !== 0) : []);
const flowName = id => { const f = (Store.flows || []).filter(x => x.id === id)[0]; return f ? f.name : "—"; };

/* ---------- 顶栏 ---------- */
function paintTopbar() {
  const bar = $("#flowBar");
  if (!bar) return;
  const fl = Store.flows || [];
  const opts = fl.map(f =>
    '<option value="' + f.id + '"' + (f.id === CUR.flowId ? " selected" : "") + ">" +
    esc(f.name) + (f.is_default ? "（默认）" : "") + "</option>").join("");
  bar.innerHTML = '<span class="fsel"><select id="flowSel" title="切换产线流程（右侧统计会跟随切换）">' + opts + "</select></span>" +
    '<span class="stat" id="topStat"><span class="skel skel-sm"></span></span>';
  const sel = $("#flowSel");
  sel.addEventListener("change", () => {
    saveFlowSel(Number(sel.value));
    CUR.attStepId = null;
    nav();
  });
}

function paintStat(s) {
  const el = $("#topStat");
  if (!el) return;
  if (!s || !s.flow) { el.textContent = "（无流程）"; return; }
  const parts = s.steps.map(x => '<span class="st"><b>' + esc(x.name) + "</b><i>" + x.count + "</i></span>");
  parts.push('<span class="st files"><b>附件</b><i>' + s.attachments + "</i></span>");
  el.innerHTML = parts.join("");
}

async function refreshStat() {
  const fid = CUR.flowId || "";
  try {
    const s = await api("GET", "stat?flow=" + fid);
    if (fid !== (CUR.flowId || "")) return;
    paintStat(s);
  } catch (e) { /* 静默 */ }
}

/* ---------- 路由 ---------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const p = h.split("/").filter(Boolean);
  if (!p.length) return { page: "home" };
  if (p[0] === "config") return { page: "config" };
  if (p[0] === "r" && p[1]) return { page: "record", id: Number(p[1]) || null };
  return { page: "home" };
}
window.addEventListener("hashchange", nav);

function skeleton() {
  return '<div class="skel-wrap">' +
    '<div class="skel skel-title"></div>' +
    '<div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div>' +
    "</div>";
}

async function nav() {
  const app = $("#app");
  if (!app) return;
  const my = ++NAV;
  const r = parseHash();
  app.innerHTML = skeleton();
  try {
    await Promise.all([ensureMeta(), ensureFlows()]);
    if (my !== NAV) return;
    loadFlowSel();
    curFlow();
    paintTopbar();
    if (r.page === "home") await paintHome(app, my);
    else if (r.page === "config") await paintConfig(app, my);
    else await paintRecord(app, r.id, my);
    if (my !== NAV) return;
    refreshStat();
  } catch (e) {
    if (my !== NAV) return;
    if (e && e.status === 404) {
      app.innerHTML = '<div class="empty dead"><div class="big">🔍</div>' +
        '<div class="t1">找不到这条记录</div>' +
        '<div class="t2">它可能已被删除，或者链接不正确。</div>' +
        '<div class="ops"><a class="btn primary" href="#/">返回工作台</a></div></div>';
      return;
    }
    app.innerHTML = '<div class="empty"><div class="big">⚠</div>' +
      '<div class="t1">' + esc((e && e.message) || "加载失败") + "</div>" +
      '<div class="ops"><a class="btn" href="#/">返回工作台</a></div></div>';
  }
}

/* ---------- 帖子卡片 ---------- */
function thumbHtml(a) {
  if (!a) return "";
  const u = API + "attachments/" + a.id + "/file?d=inline";
  if (isImg(a.filename)) return '<img class="thumb" src="' + u + '" alt="' + esc(a.filename) + '" loading="lazy">';
  return '<div class="thumbf"><span class="tf-ico">' + icoOf(a.filename) + "</span>" +
    '<span class="tf-size">' + fmtSize(a.size) + "</span></div>";
}

function postCard(rec, step, nextStep) {
  const atts = rec.attachments || [];
  const thumbs = atts.slice(0, 3).map(thumbHtml).join("");
  const more = atts.length > 3 ? '<span class="thumb-more">+' + (atts.length - 3) + "</span>" : "";
  const kv = [];
  if (rec.status) kv.push('<span class="tag">' + esc(rec.status) + "</span>");
  if (step && step.gate === "review") {
    const rs = rec.review_status || "草稿";
    const cls = rs === "通过" ? "b-ok" : rs === "驳回" ? "b-bad" : (rs.indexOf("中") >= 0 ? "b-wait" : "b-mut");
    kv.push('<span class="badge ' + cls + '">' + esc(rs) + "</span>");
  }
  const owner = rec.owner ? '<span class="pm-owner">' + esc(rec.owner) + "</span>" : "";
  const h = document.createElement("div");
  h.className = "post";
  h.setAttribute("role", "link");
  h.tabIndex = 0;
  h.innerHTML =
    '<div class="pbody">' +
    '<div class="pt">' + esc(rec.title || "(未命名)") + "</div>" +
    (rec.summary ? '<div class="sum">' + esc(rec.summary) + "</div>" : "") +
    (kv.length ? '<div class="props">' + kv.join("") + "</div>" : "") +
    "</div>" +
    (thumbs ? '<div class="thumbs">' + thumbs + more + "</div>" : "") +
    '<div class="footrow"><span class="fr-l">' + owner +
    (nextStep && rec.child_count
      ? '<span class="fr-kid">' + esc(nextStep.name) + " " + rec.child_count + " 条</span>" : "") +
    '</span><span class="fr-r">' + relTime(rec.created_at) + ' <i class="arw">→</i></span></div>';
  const go = () => { location.hash = "#/r/" + rec.id; };
  h.addEventListener("click", go);
  h.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  return h;
}

/* ---------- 属性 ---------- */
function attBadge(atts) {
  return atts.length ? ' <span class="badge b-acc">📎 ' + atts.length + "</span>" : "";
}
/* 单个附件小条；fk = 该附件归属的字段 key（用于「＋」直接往该字段加附件） */
function attLinks(atts, fk) {
  const add = '<button class="attadd" data-addfield="' + esc(fk) + '" title="为该字段添加附件">＋ 附件</button>';
  const items = atts.map(a => {
    const u = API + "attachments/" + a.id + "/file?d=inline";
    const durl = API + "attachments/" + a.id + "/file?d=attachment";
    return '<span class="attlink"><span class="al-ico">' + icoOf(a.filename) + "</span>" +
      '<span class="al-nm">' + esc(a.filename) + "</span>" +
      '<span class="al-sz">' + fmtSize(a.size) + "</span>" +
      '<a href="' + durl + '" title="下载">下载</a>' +
      (canPv(a.filename)
        ? '<button class="lk" data-look="' + u + '" data-kind="' + kindOf(a.filename) + '">预览</button>' : "") +
      "</span>";
  }).join("");
  return '<div class="attlinks">' + items + add + "</div>";
}

/* 属性区：单列全宽属性列表（标签 | 值 | 附件），每行一行高、随内容自然增高 */
function propsHtml(rec, step, defs) {
  const attsOf = k => (rec.attachments || []).filter(a => a.attr_key === k);
  const rows = [];
  const core = (Store.meta.core_fields || []).slice();
  if (step && step.gate === "review") {
    // 评审状态 / 意见由「评审门」区负责流转，这里只展示，不做行内编辑
    core.push({ key: "review_status", label: "评审状态", type: "text", ro: true },
      { key: "review_comment", label: "评审意见", type: "textarea", ro: true });
  }
  const labelCell = (label, badgeHtml, atts) =>
    '<div class="k"><span class="k-lab">' + esc(label) + "</span>" + badgeHtml + attBadge(atts) + "</div>";

  core.forEach(f => {
    const v = rec[f.key];
    const atts = attsOf(f.key);
    const vs = Array.isArray(v) ? v.join("、") : (v == null ? "" : String(v));
    const fk = f.ro ? "" : ' data-fk="' + esc(f.key) + '"';
    const badge = f.ro ? "" : '<span class="badge b-mut">核心</span>';
    if (f.type === "textarea" && vs) {
      // 长文本：同样是一行，值区随内容向下长
      rows.push('<div class="prop longblk' + (f.ro ? " ro" : "") + '"' + fk + ">" +
        labelCell(f.label, badge, atts).replace('class="k"', 'class="k longblk-h"') +
        '<div class="v bodytxt">' + esc(vs) + "</div>" + attLinks(atts, f.key) + "</div>");
      return;
    }
    rows.push('<div class="prop' + (f.ro ? " ro" : "") + '"' + fk + ">" +
      labelCell(f.label, badge, atts) +
      '<div class="v' + (vs ? "" : " blank") + '">' + esc(vs || (f.ro ? "—" : "点击填写")) + "</div>" +
      attLinks(atts, f.key) + "</div>");
  });
  (defs || []).forEach(d => {
    const v = (rec.attrs || {})[d.key];
    const atts = attsOf(d.key);
    const vs = Array.isArray(v) ? v.join("、") : (v == null ? "" : String(v));
    rows.push('<div class="prop" data-fk="' + esc(d.key) + '">' +
      labelCell(d.name, '<span class="badge b-acc">自定义</span>', atts) +
      '<div class="v' + (vs ? "" : " blank") + '">' + esc(vs || "点击填写") + "</div>" +
      attLinks(atts, d.key) + "</div>");
  });
  return '<div class="propgrid">' + rows.join("") + "</div>";
}

/* 附件墙：始终渲染 + 末尾一个「添加附件」格（点击选文件 / 也可拖拽到整块区域） */
function attWallHtml(rec) {
  // 只放【记录级】附件：字段自己的附件显示在对应字段行里，避免同一份东西出现两处
  const atts = (rec.attachments || []).filter(a => !a.attr_key);
  const tiles = atts.map(a => {
    const u = API + "attachments/" + a.id + "/file?d=inline";
    const durl = API + "attachments/" + a.id + "/file?d=attachment";
    let pv;
    if (isImg(a.filename)) pv = '<img class="pv" src="' + u + '" alt="' + esc(a.filename) + '" loading="lazy">';
    else if (isVid(a.filename)) pv = '<video class="pvmp4" src="' + u + '" controls preload="metadata"></video>';
    else if (isAud(a.filename)) pv = '<div class="pvaud"><audio controls preload="none" src="' + u + '"></audio></div>';
    else pv = '<div class="pvfile">' + icoOf(a.filename) + "</div>";
    const own = a.attr_key ? attrLabel(a.attr_key) : "记录级";
    return '<div class="att">' + pv +
      '<div class="meta"><b title="' + esc(a.filename) + '">' + esc(a.filename) + "</b>" +
      '<span class="metaline">' + fmtSize(a.size) + " · " + esc(own) + "</span></div>" +
      '<div class="ops"><a class="btn sm" href="' + durl + '">下载</a>' +
      (canPv(a.filename)
        ? '<button class="btn sm" data-look="' + u + '" data-kind="' + kindOf(a.filename) + '">预览</button>' : "") +
      '<button class="btn sm danger" data-delatt="' + a.id + '">删除</button></div></div>';
  }).join("");
  return '<div class="attwall" id="attWall">' + tiles +
    '<div class="att addtile" data-addatt>' +
    '<div class="at-ico">＋</div><div class="at-t">添加记录级附件</div>' +
    '<div class="at-s">点击选择文件<br>或拖拽到此处</div></div></div>';
}

/* 属性 key → 显示名（附件归属展示用） */
function attrLabel(key) {
  const gf = (Store.meta.gate_fields || []).filter(g => g.key === key)[0];
  if (gf) return gf.label;
  const cf = (Store.meta.core_fields || []).filter(f => f.key === key)[0];
  if (cf) return cf.label;
  const d = (RC.defs || []).filter(x => x.key === key)[0];
  return d ? d.name : key;
}

/* ---------- 灯箱 ---------- */
function openLightbox(url, kind) {
  const lm = document.createElement("div");
  lm.className = "light";
  let m;
  if (kind === "v") { m = document.createElement("video"); m.controls = true; m.autoplay = true; }
  else if (kind === "a") { m = document.createElement("audio"); m.controls = true; m.autoplay = true; }
  else { m = document.createElement("img"); }
  m.src = url;
  lm.appendChild(m);
  const close = () => lm.remove();
  lm.addEventListener("click", e => { if (e.target === lm) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });
  document.body.appendChild(lm);
}
function bindLooks(root) {
  if (!root) return;
  root.querySelectorAll("[data-look]").forEach(b => b.addEventListener("click", () => {
    openLightbox(b.getAttribute("data-look"), b.getAttribute("data-kind") || "i");
  }));
}

/* ================= 行内编辑：点击窗格即编，失焦即存 ================= */
let EDIT = null;   // 同一时刻只允许一处处于编辑态

/* 字段元信息：核心字段 / 门字段 / 自定义属性 */
function findField(key) {
  const gf = (Store.meta.gate_fields || []).filter(g => g.key === key)[0];
  if (gf) return { key: key, label: gf.label, type: gf.type, options: gf.options, kind: "core", ro: true };
  const cf = (Store.meta.core_fields || []).filter(f => f.key === key)[0];
  if (cf) return { key: cf.key, label: cf.label, type: cf.type, options: cf.options, kind: "core" };
  const d = (RC.defs || []).filter(x => x.key === key)[0];
  if (d) {
    let opts = [];
    try { opts = JSON.parse(d.options || "[]") || []; } catch (e) { opts = []; }
    return { key: d.key, label: d.name, type: d.atype, options: opts, kind: "attr" };
  }
  return null;
}
function currentValue(key) {
  const rec = RC.rec || {};
  return Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : (rec.attrs || {})[key];
}

/* 局部重画属性区（不联网），并给刚保存的字段一个短暂高亮 */
function refreshProps(flashKey) {
  const box = $("#secProps");
  if (!box || !RC.rec) return;
  const anchor = box.getBoundingClientRect().top;
  paintProps(RC.rec, RC.rec.step || RC.step, RC.defs);
  if (flashKey) {
    const hit = box.querySelector('[data-fk="' + flashKey + '"]');
    if (hit) {
      hit.classList.add("saved");
      setTimeout(() => hit.classList.remove("saved"), 900);
    }
  }
  // 尽量保持视觉位置不跳动
  const after = box.getBoundingClientRect().top;
  if (Math.abs(after - anchor) > 2) window.scrollBy(0, after - anchor);
}

function startInline(host) {
  if (EDIT) return;
  const key = host.getAttribute("data-fk");
  if (!key) return;
  const f = findField(key);
  if (!f || f.ro) return;
  const valueEl = host.classList.contains("longblk")
    ? host.querySelector(".bodytxt")
    : (host.querySelector(".v") || host);
  if (!valueEl) return;

  const cur0 = currentValue(key);
  const cur = Array.isArray(cur0) ? cur0.slice() : (cur0 == null ? "" : cur0);
  EDIT = { host: host, key: key, orig: cur, tag: null };

  let el;
  if (f.type === "textarea") {
    el = document.createElement("textarea");
    el.className = "inline-input";
    el.rows = Math.min(14, Math.max(2, String(cur).split("\n").length + 1));
  } else if (f.type === "select" || f.type === "multiselect") {
    el = document.createElement("select");
    el.className = "inline-input";
    if (f.type === "multiselect") el.multiple = true;
    const arr = Array.isArray(cur) ? cur : String(cur || "").split("、").filter(Boolean);
    (f.options || []).forEach(o => {
      const op = document.createElement("option");
      op.value = o; op.textContent = o;
      op.selected = f.type === "multiselect" ? arr.indexOf(o) >= 0 : String(cur) === String(o);
      el.appendChild(op);
    });
  } else {
    el = document.createElement("input");
    el.className = "inline-input";
    el.type = f.type === "number" ? "number" : f.type === "date" ? "date" : "text";
  }
  if (el.tagName !== "SELECT") el.value = cur == null ? "" : String(cur);

  const prevHtml = valueEl.innerHTML;
  const hadEmpty = valueEl.classList.contains("empty");
  valueEl.classList.remove("empty");
  valueEl.classList.add("editing");
  valueEl.innerHTML = "";
  valueEl.appendChild(el);
  EDIT.tag = el;
  el.focus();
  if (el.tagName === "INPUT" && el.select) el.select();
  else if (el.tagName === "TEXTAREA") el.setSelectionRange(el.value.length, el.value.length);

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    let v;
    if (el.tagName === "SELECT") {
      v = el.multiple ? Array.from(el.selectedOptions).map(o => o.value) : el.value;
    } else {
      v = el.value;
    }
    const unchanged = JSON.stringify(v) === JSON.stringify(cur === "" ? "" : cur)
      || (Array.isArray(cur) && JSON.stringify(v) === JSON.stringify(cur));
    valueEl.classList.remove("editing");
    if (!commit || unchanged) {
      valueEl.innerHTML = prevHtml;
      if (hadEmpty) valueEl.classList.add("empty");
      EDIT = null;
      return;
    }
    // 乐观更新本地状态
    const rec = RC.rec;
    if (f.kind === "attr") { rec.attrs = rec.attrs || {}; rec.attrs[key] = v; }
    else { rec[key] = v; }
    if (key === "title") {
      // 标题在页头，不在属性区：直接写回并给个高亮
      const t = $("#recTitle");
      if (t) {
        t.textContent = v || "(未命名)";
        t.classList.add("saved"); setTimeout(() => t.classList.remove("saved"), 900);
      }
    } else {
      refreshProps(key);
    }
    EDIT = null;
    try {
      if (f.kind === "attr") await api("PUT", "records/" + rec.id + "/attrs", { attrs: (function () { const o = {}; o[key] = v; return o; })() });
      else await api("PUT", "records/" + rec.id, (function () { const o = {}; o[key] = v; return o; })());
    } catch (e) {
      toast("保存失败：" + e.message, "err");
      refreshSections(rec.id);        // 回滚：重新拉真实值
    }
  };

  // 长文本编辑时随输入自动增高（高度跟着内容走，不出现内部滚动条）
  if (el.tagName === "TEXTAREA") {
    const grow = () => { el.style.height = "auto"; el.style.height = Math.max(28, el.scrollHeight) + "px"; };
    el.addEventListener("input", grow);
    grow();
  }
  el.addEventListener("blur", () => finish(true));
  el.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    else if (e.key === "Enter" && el.tagName !== "TEXTAREA") { e.preventDefault(); finish(true); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
  });
  if (el.tagName === "SELECT") el.addEventListener("change", () => { if (!el.multiple) finish(true); });
}

/* 把一块区域里所有 [data-fk] 绑上「点击即编」 */
function bindInline(root) {
  if (!root) return;
  root.querySelectorAll("[data-fk]").forEach(el => {
    if (el._inlineBound) return;
    el._inlineBound = true;
    el.classList.add("editable");
    el.addEventListener("click", e => {
      if (e.target.closest("[data-look],[data-delatt],a,.attadd")) return;   // 别抢附件按钮
      if (EDIT && EDIT.host === el) return;
      startInline(el);
    });
  });
}

/* ================= 行内附件：点窗格选归属 + 选文件（也能拖拽） ================= */
function pickAndUpload(recId, attrKey, onDone) {
  const fi = document.createElement("input");
  fi.type = "file";
  fi.multiple = true;
  fi.onchange = () => uploadFiles(recId, attrKey, fi.files, onDone);
  fi.click();
}
async function uploadFiles(recId, attrKey, fileList, onDone) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let ok = 0;
  showBusy("上传中 0/" + files.length);
  for (const f of files) {
    if (f.size > 100 * 1048576) { toast("超过 100MB：" + f.name, "err"); continue; }
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.onerror = rej; r.readAsDataURL(f);
      });
      await api("POST", "records/" + recId + "/attachments",
        { attr_key: attrKey || null, filename: f.name, ftype: f.type || "", b64: b64 });
      ok++;
      showBusy("上传中 " + ok + "/" + files.length);
    } catch (e) { toast("上传失败：" + f.name + " → " + e.message, "err"); }
  }
  hideBusy();
  toast(ok ? "已上传 " + ok + " 个附件" : "未上传", ok ? "ok" : "warn");
  if (ok) await refreshSections(recId);
  if (onDone) onDone();
}
let BUSY_EL = null;
function showBusy(txt) {
  if (!BUSY_EL) {
    BUSY_EL = document.createElement("div");
    BUSY_EL.className = "busy";
    document.body.appendChild(BUSY_EL);
  }
  BUSY_EL.textContent = txt;
  BUSY_EL.classList.add("in");
}
function hideBusy() {
  if (BUSY_EL) { BUSY_EL.classList.remove("in"); setTimeout(() => { if (BUSY_EL) { BUSY_EL.remove(); BUSY_EL = null; } }, 220); }
}

/* ================= 列表内联快速添加（输入名称 → 回车即建） ================= */
function quickAddHtml(ph) {
  return '<div class="quickadd" data-qa>' +
    '<span class="qa-ico">＋</span>' +
    '<input class="qa-input" placeholder="' + esc(ph) + '" aria-label="快速新建">' +
    '<button class="btn primary sm qa-btn">创建</button></div>';
}
function bindQuickAdd(root, ctx) {
  const qa = root && root.querySelector("[data-qa]");
  if (!qa) return;
  const input = qa.querySelector(".qa-input");
  const btn = qa.querySelector(".qa-btn");
  let busy = false;
  const submit = async () => {
    const title = input.value.trim();
    if (!title || busy) return;
    busy = true;
    btn.disabled = true;
    try {
      await api("POST", "records", Object.assign({}, ctx.base, { title: title }));
      input.value = "";
      toast("已创建", "ok");
      ctx.after ? await ctx.after() : nav();
    } catch (e) { toast(e.message, "err"); }
    busy = false;
    btn.disabled = false;
    input.focus();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape" && !input.value) input.blur();
  });
  btn.addEventListener("click", submit);
}

/* ---------- 表单弹层 ---------- */
function openFormModal(cfg) {
  const fields = cfg.fields || [];
  const values = cfg.values || {};
  let fh = '<div class="mrow">';
  fields.forEach(f => {
    const v = values[f.key] != null ? values[f.key] : "";
    const req = f.required ? ' <span class="req">*</span>' : "";
    let input;
    if (f.type === "textarea") input = '<textarea name="' + f.key + '">' + esc(v) + "</textarea>";
    else if (f.type === "select") input = '<select name="' + f.key + '">' +
      (f.options || []).map(o => '<option value="' + esc(o) + '"' +
        (String(v) === String(o) ? " selected" : "") + ">" + esc(o) + "</option>").join("") + "</select>";
    else input = '<input name="' + f.key + '" type="' +
      (f.type === "number" ? "number" : f.type === "date" ? "date" : "text") + '" value="' + esc(v) + '">';
    fh += '<div class="mf"><label>' + esc(f.label) + req + "</label>" + input + "</div>";
  });
  fh += "</div>";
  if (cfg.note) fh += '<div class="hint">' + esc(cfg.note) + "</div>";
  const md = document.createElement("div");
  md.className = "modal-mask";
  md.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>' + esc(cfg.title) + "</h2>" + fh +
    '<div class="mdl-ops"><button class="btn" data-c>取消</button>' +
    '<button class="btn primary" data-ok>保存</button></div></div>';
  $("#modalRoot").appendChild(md);
  const collect = () => {
    const out = {};
    fields.forEach(f => {
      const el = md.querySelector('[name="' + f.key + '"]');
      let val = el ? el.value : "";
      if (f.type === "number") val = val === "" ? null : Number(val);
      out[f.key] = val;
    });
    return out;
  };
  md.querySelector("[data-c]").addEventListener("click", () => md.remove());
  md.querySelector("[data-ok]").addEventListener("click", async () => {
    const data = collect();
    for (const f of fields) {
      if (f.required && (data[f.key] === "" || data[f.key] == null)) {
        toast("请填写：" + f.label, "warn"); return;
      }
    }
    const btn = md.querySelector("[data-ok]");
    btn.disabled = true;
    try { await cfg.onSave(data); md.remove(); }
    catch (e) { btn.disabled = false; toast(e.message, "err"); }
  });
  md.addEventListener("click", e => { if (e.target === md) md.remove(); });
  const first = md.querySelector("input,textarea,select");
  if (first) first.focus();
}

/* ---------- 工作台 ---------- */
async function paintHome(app, my) {
  await ensureFlows();          // 缓存可能被失效（配置页改动后）
  const f = curFlow();
  if (!f) {
    app.innerHTML = '<div class="empty"><div class="big">⚠</div><div class="t1">没有可用的产线流程</div>' +
      '<div class="ops"><a class="btn primary" href="#/config">去配置页新建</a></div></div>';
    return;
  }
  const steps = effSteps(f);
  const first = steps[0];
  const nx = steps[1] || null;

  let html = '<div class="pagehead"><div class="t"><h1>' + esc(f.name) + "</h1>" +
    '<div class="crumbs">' + (steps.length
      ? steps.map((s, i) => '<span class="tag cr' + (i === 0 ? " on" : "") + '">' + esc(s.name) + "</span>")
        .join('<i class="cr-sep">→</i>')
      : "该流程还没有启用的环节") + "</div></div>" +
    '<div class="act"><button class="btn primary" id="newRec">＋ 新建' + esc(first ? first.name : "记录") + "</button></div></div>";

  if (!first) {
    html += '<div class="empty starter"><div class="big">＋</div><div class="t1">该流程还没有启用的环节</div>' +
      '<div class="t2">到「流程与属性配置」为该流程添加环节后即可录入记录。</div>' +
      '<div class="ops"><a class="btn primary" href="#/config">去配置环节</a></div></div>';
    app.innerHTML = html;
    return;
  }

  const recs = await api("GET", "records?flow=" + f.id + "&step=" + first.id);
  if (my !== NAV) return;
  const list = recs.length
    ? '<div class="posts" id="homeGrid"></div>'
    : '<div class="empty starter"><div class="big">＋</div>' +
    '<div class="t1">还没有「' + esc(first.name) + "」记录</div>" +
    '<div class="t2">这是「' + esc(f.name) + "」的第一个环节。<br>" +
    "在上方输入框里写名称、回车即可创建，之后可逐环节往下推进。</div>" +
    '<div class="ops"><button class="btn primary" id="newRec2">＋ 新建' + esc(first.name) + "</button></div></div>";

  html += '<div class="sec"><h3><span class="x">' + esc(first.name) + " 记录</span>" +
    '<span class="tag">' + recs.length + " 条</span></h3>" +
    quickAddHtml("输入" + first.name + "名称，回车即创建…") + list + "</div>";
  app.innerHTML = html;

  const grid = $("#homeGrid");
  if (grid) recs.forEach(rc => grid.appendChild(postCard(rc, first, nx)));

  bindQuickAdd(app, { base: { flow_id: f.id, step_id: first.id } });
  // 顶部按钮与空态按钮都只是把焦点交给内联输入框（不再弹窗）
  const focusQA = () => {
    const el = app.querySelector(".qa-input");
    if (el) { el.focus(); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  };
  const r1 = $("#newRec"); if (r1) r1.addEventListener("click", focusQA);
  const r2 = $("#newRec2"); if (r2) r2.addEventListener("click", focusQA);
}

/* ---------- 记录详情 ---------- */
let RC = { id: null, rec: null, defs: [] };

async function paintRecord(app, id, my) {
  await ensureFlows();          // 缓存可能被失效
  const rec = await api("GET", "records/" + id);
  if (my !== NAV) return;
  const fl = (Store.flows || []).filter(f => f.id === rec.flow_id)[0];
  const steps = effSteps(fl);
  const nx = rec.next_step;
  const pv = rec.prev_step;
  const defs = await ensureDefs(rec.flow_id, rec.step_id);
  if (my !== NAV) return;
  const kids = nx
    ? await api("GET", "records?flow=" + rec.flow_id + "&step=" + nx.id + "&parent=" + rec.id)
    : [];
  if (my !== NAV) return;

  RC = { id: id, rec: rec, defs: defs };

  let html = '<div class="pagehead"><div class="t"><h1 id="recTitle" data-fk="title">' + esc(rec.title || "(未命名)") + "</h1>" +
    '<div class="crumbs"><a href="#/">' + esc(flowName(rec.flow_id)) + "</a>" +
    (pv ? '<i class="cr-sep">›</i><span class="cr">' + esc(pv.name) + "</span>" : "") +
    '<i class="cr-sep">›</i><span class="cr on">' + esc(rec.step ? rec.step.name : "") + "</span></div></div>" +
    '<div class="act">' +
    '<button class="btn danger" data-del>删除</button></div></div>';

  html += '<div class="sec"><h3><span class="x">内容与属性</span>' +
    '<span class="hint" style="font-weight:400">点任意字段即可直接填写，离开自动保存</span></h3>' +
    '<div id="secProps"></div></div>';
  html += '<div class="sec"><h3><span class="x">记录级附件</span><span class="tag" id="attCount">' +
    (rec.attachments || []).filter(a => !a.attr_key).length + " 个</span>" +
    '<span class="hint" style="font-weight:400">字段自己的附件在该字段行里添加</span></h3>' +
    "<div id='secAtts'></div></div>";
  if (nx) {
    html += '<div class="sec"><h3><span class="x">' + esc(nx.name) + " 记录</span>" +
      '<span class="tag">' + rec.child_count + " 条</span></h3>" +
      quickAddHtml("输入" + nx.name + "名称，回车即创建…") + "<div id='childGrid'></div></div>";
  }
  html += '<div class="sec"><h3><span class="x">流程位置</span></h3><div class="chain" id="secChain"></div></div>';
  app.innerHTML = html;

  const step = rec.step;
  paintProps(rec, step, defs);
  paintAtts(rec);
  paintGate(rec, step);
  paintChain(rec, steps);
  if (nx) paintKids(kids, nx, steps);
  bindRecordActions(app, rec, step, nx);
}

function paintProps(rec, step, defs) {
  const box = $("#secProps");
  if (!box) return;
  box.innerHTML = propsHtml(rec, step, defs);
  bindLooks(box);
  bindInline(box);
  box.querySelectorAll("[data-addfield]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    pickAndUpload(rec.id, b.getAttribute("data-addfield"));
  }));
}

function paintAtts(rec) {
  const box = $("#secAtts");
  if (!box) return;
  box.innerHTML = attWallHtml(rec);
  const c = $("#attCount");
  if (c) c.textContent = (rec.attachments || []).filter(a => !a.attr_key).length + " 个";
  // 「＋ 添加附件」格：点击直接选文件（记录级）
  const tile = box.querySelector("[data-addatt]");
  if (tile) tile.addEventListener("click", () => pickAndUpload(rec.id, null));
  // 整块附件区可拖拽上传
  // ⚠️ #secAtts 容器本身不会被重建（只换 innerHTML），所以监听器【只能绑一次】，
  //    否则每次局部刷新都会叠加一个，拖一次文件会上传 N 次。
  if (!box._dropBound) {
    box._dropBound = true;
    box.addEventListener("dragover", e => { e.preventDefault(); box.classList.add("dropping"); });
    box.addEventListener("dragleave", e => { if (e.target === box) box.classList.remove("dropping"); });
    box.addEventListener("drop", e => {
      e.preventDefault(); box.classList.remove("dropping");
      const rec2 = RC.rec;
      if (rec2 && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        uploadFiles(rec2.id, null, e.dataTransfer.files);
      }
    });
  }
  box.querySelectorAll("[data-delatt]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("删除该附件？")) return;
    const card = b.closest(".att");
    if (card) card.classList.add("removing");
    try {
      await api("DELETE", "attachments/" + b.getAttribute("data-delatt"));
      if (card) card.remove();
      toast("已删除", "ok");
      await refreshSections(rec.id);
    } catch (e) {
      if (card) card.classList.remove("removing");
      toast(e.message, "err");
    }
  }));
  bindLooks(box);
}

function paintGate(rec, step) {
  const old = $("#secGate");
  if (old) old.remove();
  if (!step || step.gate !== "review") return;
  const rs = rec.review_status || "草稿";
  const wrap = document.createElement("div");
  wrap.className = "sec"; wrap.id = "secGate";
  wrap.innerHTML = '<h3><span class="x">评审门</span><span class="tag">' + esc(rs) + "</span></h3>" +
    '<div class="ops" style="margin-top:2px">' +
    ((rs === "草稿" || rs === "驳回") ? '<button class="btn wait" data-rv="submit">提交评审</button>' : "") +
    (rs === "评审中" ? '<button class="btn ok" data-rv="approve">评审通过</button>' +
      '<button class="btn danger" data-rv="reject">驳回</button>' : "") +
    '<span class="gate-now">' + (rec.review_comment ? "意见：" + esc(rec.review_comment) : "") + "</span></div>";
  const anchor = $("#childGrid") ? $("#childGrid").closest(".sec") : $("#secChain").closest(".sec");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(wrap, anchor);
  else $("#app").appendChild(wrap);
  wrap.querySelectorAll("[data-rv]").forEach(b => b.addEventListener("click", async () => {
    const action = b.getAttribute("data-rv");
    let comment = "";
    if (action === "approve" || action === "reject") {
      comment = prompt(action === "approve" ? "填写评审意见（可留空）：" : "填写驳回意见：", "") || "";
    }
    b.disabled = true;
    try {
      await api("PUT", "records/" + rec.id + "/review", { action, comment });
      toast("状态已更新", "ok");
      await refreshSections(rec.id);
    } catch (e) { b.disabled = false; toast(e.message, "err"); }
  }));
}

function paintChain(rec, steps) {
  const box = $("#secChain");
  if (!box) return;
  const cur = steps.findIndex(x => x.id === rec.step_id);
  box.innerHTML = steps.map((s, i) =>
    '<span class="tag cr' + (i === cur ? " on" : (i < cur ? " done" : "")) + '">' + esc(s.name) + "</span>")
    .join('<i class="cr-sep">→</i>');
}

function paintKids(kids, nx, steps) {
  const grid = $("#childGrid");
  if (!grid) return;
  const i = steps.findIndex(s => s.id === nx.id);
  const nn = (i >= 0 ? steps[i + 1] : null) || null;
  if (kids.length) kids.forEach(k => grid.appendChild(postCard(k, nx, nn)));
  else grid.innerHTML = '<div class="empty sm"><div class="t1">还没有' + esc(nx.name) + "</div>" +
    '<div class="t2">在上方输入框填写名称、回车即可添加第一条</div></div>';
}

function bindRecordActions(app, rec, step, nx) {
  // 标题：点一下直接改名，离开自动保存
  const ti = $("#recTitle");
  if (ti && !ti._inlineBound) {
    ti._inlineBound = true;
    ti.classList.add("editable");
    ti.addEventListener("click", e => { e.stopPropagation(); startInline(ti); });
  }
  // 子记录：内联快速添加
  if (nx) {
    bindQuickAdd(app, {
      base: { flow_id: rec.flow_id, step_id: nx.id, parent_id: rec.id },
      after: async () => {
        const kids = await api("GET", "records?flow=" + rec.flow_id + "&step=" + nx.id + "&parent=" + rec.id);
        const grid = $("#childGrid");
        if (grid) grid.innerHTML = "";
        paintKids(kids, nx, effSteps((Store.flows || []).filter(f => f.id === rec.flow_id)[0]));
        refreshStat();
      },
    });
  }
  app.querySelector("[data-del]").addEventListener("click", async () => {
    if (!confirm("确定删除该记录？此操作不可恢复。")) return;
    try {
      await api("DELETE", "records/" + rec.id);
      toast("已删除", "ok");
      location.hash = "#/";
    } catch (e) { toast(e.message, "err"); }
  });
}

/* ---------- 局部刷新：只重画记录详情里会变的区块（1 次 GET） ---------- */
async function refreshSections(rid) {
  try {
    const rec = await api("GET", "records/" + rid);
    RC.rec = rec;
    const step = rec.step;
    const defs = await ensureDefs(rec.flow_id, rec.step_id);
    RC.defs = defs;
    paintProps(rec, step, defs);
    paintAtts(rec);
    paintGate(rec, step);
    const t = $("#recTitle");
    if (t && rec.title) t.textContent = rec.title;
    refreshStat();
  } catch (e) { /* 静默 */ }
}

/* ---------- 配置页 ---------- */
async function paintConfig(app, my) {
  await ensureFlows();          // ⚠️ 必须：保存环节后会 invalidateFlows()，此处若读空缓存会导致环节编辑器不渲染
  const fl = Store.flows || [];
  const f = curFlow();
  if (f && !CUR.attStepId) {
    const ss = f.steps || [];
    CUR.attStepId = (effSteps(f)[0] || ss[0] || {}).id || null;
  }

  let html = '<div class="pagehead"><div class="t"><h1>流程与属性配置</h1>' +
    '<div class="crumbs">产线流程可增删改名；每条流程的环节数量自由、名称自定义</div></div>' +
    '<div class="act"><a class="btn" href="#/">← 返回工作台</a></div></div>';

  html += '<div class="sec"><h3><span class="x">产线流程</span>' +
    '<span class="tag">' + fl.length + " 条</span></h3>" +
    '<div class="hint" style="margin-bottom:12px">「默认」是兜底流程；日常切换在页面右上角。</div>';
  fl.forEach(x => {
    const on = f && x.id === f.id;
    html += '<div class="flowrow' + (on ? " on" : "") + '">' +
      '<span class="fn">' + esc(x.name) + "</span>" +
      (x.is_default ? '<span class="badge b-acc">默认</span>' : "") +
      '<span class="tag">' + (x.steps || []).length + " 环节</span>" +
      '<span class="tag">' + x.count + " 记录</span>" +
      '<span class="ops">' +
      (on ? '<span class="tag on">编辑中</span>'
        : '<button class="btn sm" data-pick="' + x.id + '">编辑环节</button>') +
      (x.is_default ? "" : '<button class="btn sm" data-def="' + x.id + '">设为默认</button>') +
      '<button class="btn sm" data-ren="' + x.id + '">改名</button>' +
      '<button class="btn sm danger" data-delf="' + x.id + '">删除</button>' +
      "</span></div>";
  });
  html += '<div style="margin-top:12px"><button class="btn primary" id="addFlow">＋ 新增产线流程</button></div></div>';

  if (f) {
    html += '<div class="sec"><h3><span class="x">「' + esc(f.name) + "」的环节</span>" +
      '<span class="tag">' + (f.steps || []).length + " / " + Store.meta.max_steps + " 个</span></h3>" +
      '<div class="hint" style="margin-bottom:12px">环节名称直接输入即可；上下按钮调整顺序；改动需点保存生效。</div>' +
      '<div id="stepEditor"></div></div>';

    const steps = f.steps || [];
    html += '<div class="sec"><h3><span class="x">自定义属性</span></h3>' +
      '<div class="hint" style="margin-bottom:10px">按「产线流程 + 环节」定义。核心字段（' +
      (Store.meta.core_fields || []).map(c => esc(c.label)).join(" / ") +
      '）所有环节固定拥有，此处只增自定义项。</div>' +
      '<div class="attrpick"><label>环节</label><select id="attStep">' +
      steps.map(s => '<option value="' + s.id + '"' + (s.id === CUR.attStepId ? " selected" : "") + ">" +
        esc(s.name) + "</option>").join("") + "</select>" +
      '<button class="btn sm primary" id="addDef">＋ 新增自定义属性</button></div>' +
      '<div id="defList"></div></div>';
  }
  app.innerHTML = html;

  $("#addFlow").addEventListener("click", () => openFormModal({
    title: "新增产线流程",
    note: "会沿用默认模板的 5 个环节作为起手式，之后可在下方逐条改名、增删；自定义属性按需自行添加。",
    fields: [{ key: "name", label: "产线流程名称", type: "text", required: true }],
    values: { name: "" },
    onSave: d => api("POST", "flows", d).then(rr => {
      saveFlowSel(rr.id); invalidateFlows(); toast("已创建", "ok"); nav();
    }),
  }));
  app.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
    saveFlowSel(Number(b.getAttribute("data-pick"))); CUR.attStepId = null; paintConfig(app, my);
  }));
  app.querySelectorAll("[data-def]").forEach(b => b.addEventListener("click", async () => {
    try {
      await api("POST", "flows/" + b.getAttribute("data-def") + "/default");
      invalidateFlows(); toast("已设为默认", "ok"); nav();
    } catch (e) { toast(e.message, "err"); }
  }));
  app.querySelectorAll("[data-ren]").forEach(b => b.addEventListener("click", () => {
    const fx = fl.filter(x => x.id === Number(b.getAttribute("data-ren")))[0];
    openFormModal({
      title: "重命名产线流程",
      fields: [{ key: "name", label: "产线流程名称", type: "text", required: true }],
      values: { name: fx.name },
      onSave: d => api("PUT", "flows/" + fx.id, { name: d.name, steps: fx.steps }).then(() => {
        invalidateFlows(); toast("已改名", "ok"); nav();
      }),
    });
  }));
  app.querySelectorAll("[data-delf]").forEach(b => b.addEventListener("click", async () => {
    const fx = fl.filter(x => x.id === Number(b.getAttribute("data-delf")))[0];
    if (!confirm("确定删除产线流程「" + fx.name + "」？\n（其下若有记录将无法删除）")) return;
    try { await api("DELETE", "flows/" + fx.id); invalidateFlows(); toast("已删除", "ok"); nav(); }
    catch (e) { toast(e.message, "err"); }
  }));

  if (f) {
    renderStepEditor(f, app, my);
    const sel = $("#attStep");
    sel.addEventListener("change", () => { CUR.attStepId = Number(sel.value); renderDefs(f); });
    $("#addDef").addEventListener("click", () => openDefModal(f, Number(sel.value), null));
    renderDefs(f);
  }
}

/* ---- 环节编辑器（名称直填，非下拉）---- */
function renderStepEditor(f, app, my) {
  const mount = $("#stepEditor");
  const steps = (f.steps || []).map(s => Object.assign({}, s));
  const draw = () => {
    mount.innerHTML = steps.length ? "" :
      '<div class="empty sm"><div class="t2">还没有环节，至少添加一个</div></div>';
    steps.forEach((s, i) => {
      const d = document.createElement("div");
      d.className = "steprow" + (s.enabled === 0 ? " off" : "");
      d.innerHTML =
        '<span class="sn">' + (i + 1) + "</span>" +
        '<input class="sname" value="' + esc(s.name) + '" placeholder="环节名称，如：立项 / 执行 / 复核">' +
        '<select class="sgate"><option value="none"' + (s.gate === "review" ? "" : " selected") +
        ">无门</option>" +
        '<option value="review"' + (s.gate === "review" ? " selected" : "") + ">评审门</option></select>" +
        '<span class="ops">' +
        '<button class="btn sm" data-up' + (i === 0 ? " disabled" : "") + ' title="上移">↑</button>' +
        '<button class="btn sm" data-dn' + (i === steps.length - 1 ? " disabled" : "") + ' title="下移">↓</button>' +
        '<button class="btn sm" data-tg>' + (s.enabled === 0 ? "启用" : "停用") + "</button>" +
        '<button class="btn sm danger" data-rm>删</button></span>';
      mount.appendChild(d);
      d.querySelector(".sname").addEventListener("input", e => { steps[i].name = e.target.value; });
      d.querySelector(".sgate").addEventListener("change", e => { steps[i].gate = e.target.value; });
      d.querySelector("[data-up]").addEventListener("click", () => {
        if (i > 0) { const t = steps[i - 1]; steps[i - 1] = steps[i]; steps[i] = t; draw(); }
      });
      d.querySelector("[data-dn]").addEventListener("click", () => {
        if (i < steps.length - 1) { const t = steps[i + 1]; steps[i + 1] = steps[i]; steps[i] = t; draw(); }
      });
      d.querySelector("[data-tg]").addEventListener("click", () => {
        steps[i].enabled = steps[i].enabled === 0 ? 1 : 0; draw();
      });
      d.querySelector("[data-rm]").addEventListener("click", () => { steps.splice(i, 1); draw(); });
    });
    const add = document.createElement("div");
    add.className = "addstep";
    add.innerHTML = '<input id="newStepName" placeholder="新环节名称">' +
      '<select id="newStepGate"><option value="none">无门</option>' +
      '<option value="review">评审门</option></select>' +
      '<button class="btn" id="doAddStep">＋ 新增环节</button>';
    mount.appendChild(add);
    const doAdd = () => {
      const nm = mount.querySelector("#newStepName").value.trim();
      if (!nm) { toast("请先填写新环节名称", "warn"); return; }
      if (steps.length >= Store.meta.max_steps) { toast("环节数不能超过 " + Store.meta.max_steps, "warn"); return; }
      steps.push({ name: nm, gate: mount.querySelector("#newStepGate").value, enabled: 1 });
      draw();
    };
    mount.querySelector("#doAddStep").addEventListener("click", doAdd);
    mount.querySelector("#newStepName").addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); });

    const bar = document.createElement("div");
    bar.className = "savebar";
    bar.innerHTML = '<button class="btn primary" id="saveSteps">保存环节</button>' +
      '<span class="hint">共 ' + steps.length + " 个环节</span>";
    mount.appendChild(bar);
    mount.querySelector("#saveSteps").addEventListener("click", async () => {
      if (steps.some(s => !(s.name || "").trim())) { toast("有环节名称为空", "warn"); return; }
      if (!steps.length) { toast("至少保留一个环节", "warn"); return; }
      const btn = mount.querySelector("#saveSteps");
      btn.disabled = true;
      try {
        await api("PUT", "flows/" + f.id, {
          name: f.name,
          steps: steps.map(s => ({
            id: s.id || undefined, name: s.name.trim(),
            gate: s.gate, enabled: s.enabled !== 0,
          })),
        });
        invalidateFlows();
        toast("环节已保存", "ok");
        await paintConfig(app, my);
        refreshStat();
      } catch (e) { btn.disabled = false; toast(e.message, "err"); }
    });
  };
  draw();
}

/* ---- 属性定义 ---- */
async function renderDefs(f) {
  const box = $("#defList");
  if (!box) return;
  const sid = CUR.attStepId;
  if (!sid) { box.innerHTML = '<div class="empty sm"><div class="t2">请先添加环节</div></div>'; return; }
  const defs = await api("GET", "attr-defs?flow=" + f.id + "&step=" + sid);
  invalidateDefs(f.id, sid);
  box.innerHTML = defs.length
    ? '<div class="propgrid tight">' +
    defs.map(d => '<div class="prop"><div class="k"><span class="k-lab">' + esc(d.name) + "</span>" +
      '<span class="badge b-acc">自定义</span></div>' +
      '<div class="v">' + esc(d.atype) + (d.required ? " · 必填" : "") + "</div>" +
      '<div class="prop-ops"><button class="btn sm" data-ed="' + d.id + '">改</button> ' +
      '<button class="btn sm danger" data-rm="' + d.id + '">删</button></div></div>').join("") + "</div>"
    : '<div class="empty sm"><div class="t2">该环节还没有自定义属性</div></div>';
  box.querySelectorAll("[data-ed]").forEach(b => b.addEventListener("click", () => {
    openDefModal(f, sid, defs.filter(x => x.id === Number(b.getAttribute("data-ed")))[0]);
  }));
  box.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("删除该自定义属性定义？已填写的值将不再展示。")) return;
    try { await api("DELETE", "attr-defs/" + b.getAttribute("data-rm")); toast("已删除", "ok"); renderDefs(f); }
    catch (e) { toast(e.message, "err"); }
  }));
}

function openDefModal(f, sid, def) {
  const md = document.createElement("div");
  md.className = "modal-mask";
  md.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>' +
    (def ? "编辑属性定义" : "新增自定义属性") + '</h2><div class="mrow">' +
    '<div class="mf"><label>Key（英文标识，本环节内唯一）<span class="req">*</span></label><input id="dk" value="' +
    esc(def ? def.key : "") + '"></div>' +
    '<div class="mf"><label>显示名称 <span class="req">*</span></label><input id="dn" value="' +
    esc(def ? def.name : "") + '"></div>' +
    '<div class="mf"><label>类型</label><select id="dt">' +
    ["text", "textarea", "number", "date", "select", "multiselect"].map(t =>
      '<option value="' + t + '"' + (def && def.atype === t ? " selected" : "") + ">" + t + "</option>").join("") +
    "</select></div>" +
    '<div class="mf"><label>选项（select / multiselect 用逗号分隔）</label><input id="do" value="' +
    esc(def ? (JSON.parse(def.options || "[]") || []).join(",") : "") + '"></div>' +
    '<div class="mf"><label>必填</label><select id="dr"><option value="0">否</option>' +
    '<option value="1"' + (def && def.required ? " selected" : "") + ">是</option></select></div></div>" +
    '<div class="mdl-ops"><button class="btn" data-c>取消</button>' +
    '<button class="btn primary" data-s>保存</button></div></div>';
  $("#modalRoot").appendChild(md);
  md.querySelector("[data-c]").addEventListener("click", () => md.remove());
  md.querySelector("[data-s]").addEventListener("click", async () => {
    const key = md.querySelector("#dk").value.trim();
    const name = md.querySelector("#dn").value.trim();
    if (!key || !name) { toast("请填写 Key 和名称", "warn"); return; }
    const opts = md.querySelector("#do").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const body = {
      flow_id: f.id, step_id: sid, key, name, atype: md.querySelector("#dt").value,
      required: md.querySelector("#dr").value === "1", options: opts,
    };
    try {
      if (def) await api("PUT", "attr-defs/" + def.id, body);
      else await api("POST", "attr-defs", body);
      toast("已保存", "ok"); md.remove(); renderDefs(f);
    } catch (e) { toast(e.message, "err"); }
  });
  md.addEventListener("click", e => { if (e.target === md) md.remove(); });
}

/* ---------- 启动 ---------- */
nav();
