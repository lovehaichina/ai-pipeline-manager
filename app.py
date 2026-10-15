# -*- coding: utf-8 -*-
"""通用产线工坊 · 通用化重构版

产线流程（flows）是一等对象：可新增 / 删除 / 改名 / 设默认；
每条流程的「环节」（steps）数量自由、名称自定义、可增删重排启停设门。
记录用单表邻接模型（records：flow_id + step_id + parent_id），按流程隔离。

纯 Python 标准库（Python 3.6 兼容，零第三方依赖）。
含：全局访问口令、附件上传下载预览、自定义属性、评审门、统计。
"""
import os, re, json, sqlite3, base64, uuid, time, hmac, hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
ATT_DIR = os.path.join(DATA_DIR, "attachments")
PORT = int(os.environ.get("PIPELINE_PORT", "8091"))
DB_PATH = os.environ.get("PIPELINE_DB") or os.path.join(DATA_DIR, "pipeline.db")
MAX_BODY = 150 * 1024 * 1024
MAX_FILE = 100 * 1024 * 1024

# ---------------- 全局访问口令 ----------------
ACCESS_USER = os.environ.get("PIPELINE_ACCESS_USER", "")
ACCESS_PASS = os.environ.get("PIPELINE_ACCESS_PASS", "")
COOKIE_NAME = "pl_session"
SESSION_MAX_AGE = 365 * 24 * 3600

SITE_NAME = "通用产线工坊"

# ---------------- 默认产线流程（= 原先的 AI 视频内容产线，逐条还原，不要改成通用占位名）----------------
DEFAULT_FLOW_NAME = "AI视频创作产线流程"
DEFAULT_STEPS = [
    {"name": "产线", "gate": "none", "enabled": 1},
    {"name": "主题系列", "gate": "none", "enabled": 1},
    {"name": "剧本", "gate": "review", "enabled": 1},
    {"name": "提示词", "gate": "review", "enabled": 1},
    {"name": "素材", "gate": "none", "enabled": 1},
]
# 默认流程各环节的预置自定义属性（承接原「各层核心字段」中通用核心字段无法承载的部分；
#   名称 / 详情 / 状态 / 计划日期 等由全局核心字段承载，见 CORE_FIELDS）
DEFAULT_ATTRS = {
    "产线": [
        {"key": "persona", "name": "人群画像", "atype": "text"},
        {"key": "goal", "name": "定位/目标", "atype": "text"},
        {"key": "daily_target", "name": "日产量", "atype": "text"},
    ],
    "主题系列": [
        {"key": "direction", "name": "内容方向", "atype": "text"},
        {"key": "audience", "name": "受众细分", "atype": "text"},
        {"key": "style", "name": "风格", "atype": "text"},
        {"key": "frequency", "name": "产出频率", "atype": "text"},
    ],
    "剧本": [
        {"key": "stype", "name": "类型", "atype": "select",
         "options": ["口播", "剧情", "图文", "混剪", "其它"]},
        {"key": "word_count", "name": "字数", "atype": "number"},
    ],
    "提示词": [
        {"key": "version", "name": "版本", "atype": "text"},
        {"key": "model", "name": "模型", "atype": "text"},
        {"key": "params", "name": "参数", "atype": "text"},
    ],
    "素材": [
        {"key": "atype", "name": "素材类型", "atype": "select",
         "options": ["图片", "音频", "视频", "脚本", "发布清单", "其它附件"]},
        {"key": "file_size", "name": "文件大小", "atype": "number"},
        {"key": "source", "name": "来源", "atype": "select", "options": ["agent回填", "手工上传"]},
        {"key": "gen_params", "name": "生成参数", "atype": "textarea"},
    ],
}
MAX_STEPS = 12

# 通用核心字段（所有环节共用；不落 attribute_defs，避免重复与迁移问题）
CORE_FIELDS = [
    {"key": "title", "label": "名称", "type": "text", "required": True},
    {"key": "summary", "label": "摘要", "type": "textarea"},
    {"key": "body", "label": "详情", "type": "textarea"},
    {"key": "owner", "label": "负责人", "type": "text"},
    {"key": "status", "label": "状态", "type": "select",
     "options": ["待办", "进行中", "已完成", "已归档"]},
    {"key": "due_date", "label": "计划日期", "type": "date"},
    {"key": "tags", "label": "标签", "type": "text"},
]
# 设门环节额外暴露的字段（存储始终存在，仅前端按门类型展示）
GATE_FIELDS = [
    {"key": "review_status", "label": "评审状态", "type": "select",
     "options": ["草稿", "评审中", "通过", "驳回"]},
    {"key": "review_comment", "label": "评审意见", "type": "textarea"},
]
LONG_FIELDS = ("body", "summary", "review_comment")

SCHEMA = """
CREATE TABLE IF NOT EXISTS flows(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  is_default INTEGER DEFAULT 0, sort INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS steps(
  id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER NOT NULL,
  name TEXT NOT NULL, gate TEXT DEFAULT 'none', enabled INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS records(
  id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL, parent_id INTEGER,
  title TEXT DEFAULT '', summary TEXT DEFAULT '', body TEXT DEFAULT '',
  owner TEXT DEFAULT '', status TEXT DEFAULT '待办',
  review_status TEXT DEFAULT '草稿', review_comment TEXT DEFAULT '',
  due_date TEXT DEFAULT '', tags TEXT DEFAULT '',
  sort INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_records_step ON records(flow_id, step_id);
CREATE INDEX IF NOT EXISTS idx_records_parent ON records(parent_id);

CREATE TABLE IF NOT EXISTS attribute_defs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, flow_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  atype TEXT DEFAULT 'text', required INTEGER DEFAULT 0, options TEXT DEFAULT '[]',
  sort INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_attrdef ON attribute_defs(flow_id, step_id, key);

CREATE TABLE IF NOT EXISTS record_attrs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL,
  def_key TEXT NOT NULL, value_text TEXT DEFAULT '', value_number REAL,
  value_date TEXT DEFAULT '', value_options TEXT DEFAULT '[]');
CREATE INDEX IF NOT EXISTS idx_attrs_record ON record_attrs(record_id);

CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, record_id INTEGER NOT NULL,
  attr_key TEXT, filename TEXT NOT NULL, ftype TEXT DEFAULT '',
  size INTEGER DEFAULT 0, path TEXT NOT NULL, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_att_record ON attachments(record_id);

CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT);
"""

CTYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".json": "application/json", ".html": "text/html", ".csv": "text/csv",
    ".zip": "application/zip", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
}


def now():
    import datetime
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------- 库 ----------------
def seed_default_flow(conn):
    """创建默认产线流程（含环节 + 各环节预置自定义属性）。幂等：仅在 flows 为空时调用。"""
    cur = conn.execute("INSERT INTO flows(name, is_default, sort, created_at, updated_at) "
                       "VALUES(?,1,0,?,?)", (DEFAULT_FLOW_NAME, now(), now()))
    fid = cur.lastrowid
    for i, s in enumerate(DEFAULT_STEPS):
        c2 = conn.execute("INSERT INTO steps(flow_id, name, gate, enabled, sort) VALUES(?,?,?,?,?)",
                          (fid, s["name"], s["gate"], s["enabled"], i))
        sid = c2.lastrowid
        for j, d in enumerate(DEFAULT_ATTRS.get(s["name"], [])):
            conn.execute("INSERT INTO attribute_defs(flow_id, step_id, key, name, atype, required, "
                         "options, sort) VALUES(?,?,?,?,?,0,?,?)",
                         (fid, sid, d["key"], d["name"], d["atype"],
                          json.dumps(d.get("options") or [], ensure_ascii=False), j))
    return fid


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(ATT_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    n = conn.execute("SELECT COUNT(*) c FROM flows").fetchone()[0]
    if n == 0:
        fid = seed_default_flow(conn)
        na = conn.execute("SELECT COUNT(*) c FROM attribute_defs WHERE flow_id=?", (fid,)).fetchone()[0]
        print("[init_db] 已创建默认产线流程「%s」（%d 个环节，%d 条预置属性）"
              % (DEFAULT_FLOW_NAME, len(DEFAULT_STEPS), na), flush=True)
    conn.commit()
    conn.close()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def rowd(r):
    return {k: r[k] for k in r.keys()}


# ---------------- 流程 / 环节 ----------------
def flow_steps(conn, flow_id):
    rows = conn.execute("SELECT * FROM steps WHERE flow_id=? ORDER BY sort, id", (flow_id,)).fetchall()
    return [rowd(r) for r in rows]


def flow_dict(conn, flow_id):
    r = conn.execute("SELECT * FROM flows WHERE id=?", (flow_id,)).fetchone()
    if not r:
        return None
    d = rowd(r)
    d["steps"] = flow_steps(conn, flow_id)
    return d


def flow_list(conn):
    out = []
    for r in conn.execute("SELECT * FROM flows ORDER BY is_default DESC, sort, id").fetchall():
        d = rowd(r)
        d["steps"] = flow_steps(conn, r["id"])
        d["count"] = conn.execute("SELECT COUNT(*) c FROM records WHERE flow_id=?",
                                  (r["id"],)).fetchone()["c"]
        out.append(d)
    return out


def default_flow_id(conn):
    r = conn.execute("SELECT id FROM flows WHERE is_default=1 ORDER BY id LIMIT 1").fetchone()
    if r:
        return r["id"]
    r = conn.execute("SELECT id FROM flows ORDER BY sort, id LIMIT 1").fetchone()
    return r["id"] if r else None


def step_of(conn, step_id):
    r = conn.execute("SELECT * FROM steps WHERE id=?", (step_id,)).fetchone()
    return rowd(r) if r else None


def next_step(conn, flow_id, step_id):
    """同流程中位于 step_id 之后的下一个环节（按 sort）。"""
    cur = conn.execute("SELECT sort FROM steps WHERE id=?", (step_id,)).fetchone()
    if not cur:
        return None
    r = conn.execute("SELECT * FROM steps WHERE flow_id=? AND sort>? ORDER BY sort LIMIT 1",
                     (flow_id, cur["sort"])).fetchone()
    return rowd(r) if r else None


def prev_step(conn, flow_id, step_id):
    cur = conn.execute("SELECT sort FROM steps WHERE id=?", (step_id,)).fetchone()
    if not cur:
        return None
    r = conn.execute("SELECT * FROM steps WHERE flow_id=? AND sort<? ORDER BY sort DESC LIMIT 1",
                     (flow_id, cur["sort"])).fetchone()
    return rowd(r) if r else None


# ---------------- 属性 / 附件 ----------------
def attr_defs(conn, flow_id, step_id):
    rows = conn.execute("SELECT * FROM attribute_defs WHERE flow_id=? AND step_id=? ORDER BY sort, id",
                        (flow_id, step_id)).fetchall()
    return [rowd(r) for r in rows]


def load_attrs(conn, record_id):
    out = {}
    for r in conn.execute("SELECT * FROM record_attrs WHERE record_id=?", (record_id,)).fetchall():
        v = r["value_text"]
        if r["value_number"] is not None:
            v = r["value_number"]
        elif r["value_date"]:
            v = r["value_date"]
        elif r["value_options"] and r["value_options"] != "[]":
            try:
                v = json.loads(r["value_options"])
            except Exception:
                v = r["value_text"]
        out[r["def_key"]] = v
    return out


def load_atts(conn, record_id):
    rows = conn.execute("SELECT id, attr_key, filename, ftype, size, created_at FROM attachments "
                        "WHERE record_id=? ORDER BY id", (record_id,)).fetchall()
    return [rowd(r) for r in rows]


def save_attrs(conn, record_id, attrs):
    conn.execute("DELETE FROM record_attrs WHERE record_id=?", (record_id,))
    for k, v in (attrs or {}).items():
        vtext, vnum, vdate, vopts = "", None, "", "[]"
        if isinstance(v, bool):
            vtext = "是" if v else "否"
        elif isinstance(v, (int, float)):
            vnum = v
        elif isinstance(v, list):
            vopts = json.dumps(v, ensure_ascii=False)
        else:
            vtext = "" if v is None else str(v)
        conn.execute("INSERT INTO record_attrs(record_id, def_key, value_text, value_number, "
                     "value_date, value_options) VALUES(?,?,?,?,?,?)",
                     (record_id, k, vtext, vnum, vdate, vopts))


def record_full(conn, rid):
    r = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
    if not r:
        return None
    d = rowd(r)
    d["attrs"] = load_attrs(conn, rid)
    d["attachments"] = load_atts(conn, rid)
    nxt = next_step(conn, d["flow_id"], d["step_id"])
    d["next_step"] = nxt
    d["prev_step"] = prev_step(conn, d["flow_id"], d["step_id"])
    d["step"] = step_of(conn, d["step_id"])
    d["child_count"] = (conn.execute("SELECT COUNT(*) c FROM records WHERE parent_id=? AND step_id=?",
                                     (rid, nxt["id"])).fetchone()["c"] if nxt else 0)
    return d


def list_records(conn, flow_id, step_id, parent_id):
    if parent_id is None:
        rows = conn.execute("SELECT * FROM records WHERE flow_id=? AND step_id=? AND parent_id IS NULL "
                            "ORDER BY sort, id DESC", (flow_id, step_id)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM records WHERE flow_id=? AND step_id=? AND parent_id=? "
                            "ORDER BY sort, id DESC", (flow_id, step_id, parent_id)).fetchall()
    nxt = next_step(conn, flow_id, step_id)
    out = []
    for r in rows:
        d = rowd(r)
        d["attachments"] = load_atts(conn, r["id"])
        d["attrs"] = load_attrs(conn, r["id"])
        d["child_count"] = (conn.execute("SELECT COUNT(*) c FROM records WHERE parent_id=? AND step_id=?",
                                         (r["id"], nxt["id"])).fetchone()["c"] if nxt else 0)
        out.append(d)
    return out


def save_attachment(conn, rid, attr_key, filename, ftype, b64):
    try:
        data = base64.b64decode(b64)
    except Exception:
        return None, "附件内容不是合法 base64"
    if len(data) > MAX_FILE:
        return None, "附件超过 100MB 上限"
    safe = re.sub(r"[^\w.\-]", "_", filename)[:120] or "file"
    abs_dir = os.path.join(ATT_DIR, "records", str(rid))
    os.makedirs(abs_dir, exist_ok=True)
    path = os.path.join(abs_dir, uuid.uuid4().hex[:12] + "_" + safe)
    with open(path, "wb") as f:
        f.write(data)
    conn.execute("INSERT INTO attachments(record_id, attr_key, filename, ftype, size, path, created_at) "
                 "VALUES(?,?,?,?,?,?,?)", (rid, attr_key, filename, ftype, len(data), path, now()))
    return conn.execute("SELECT last_insert_rowid()").fetchone()[0], None


def delete_record(conn, rid):
    if not conn.execute("SELECT 1 FROM records WHERE id=?", (rid,)).fetchone():
        return False, "记录不存在"
    n = conn.execute("SELECT COUNT(*) c FROM records WHERE parent_id=?", (rid,)).fetchone()["c"]
    if n > 0:
        return False, "该记录下还有 %d 条子记录，请先删除子记录" % n
    for r in conn.execute("SELECT path FROM attachments WHERE record_id=?", (rid,)).fetchall():
        if os.path.exists(r["path"]):
            try:
                os.remove(r["path"])
            except Exception:
                pass
    conn.execute("DELETE FROM attachments WHERE record_id=?", (rid,))
    conn.execute("DELETE FROM record_attrs WHERE record_id=?", (rid,))
    conn.execute("DELETE FROM records WHERE id=?", (rid,))
    # 顺手清掉该记录的附件目录（此前只删文件、目录会残留成空壳）
    att_dir = os.path.join(ATT_DIR, "records", str(rid))
    if os.path.isdir(att_dir):
        try:
            if not os.listdir(att_dir):
                os.rmdir(att_dir)
        except Exception:
            pass
    conn.commit()
    return True, ""


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_header(self, keyword, value):
        """HTTP 头按 latin-1 编码；非 ASCII 一律降级，避免响应被截断。"""
        if isinstance(value, str):
            try:
                value.encode("latin-1")
            except UnicodeEncodeError:
                value = "".join(c if ord(c) < 256 else "_" for c in value)
        return BaseHTTPRequestHandler.send_header(self, keyword, value)

    def send_error(self, code, message=None, explain=None):
        """错误响应统一关闭连接，避免 keep-alive 流错位（反代会报 malformed HTTP status code）。"""
        self.close_connection = True
        try:
            return BaseHTTPRequestHandler.send_error(self, code, message, explain)
        except TypeError:
            return BaseHTTPRequestHandler.send_error(self, code, message)

    def _send(self, code, headers, body):
        self._responded = True
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def send_json(self, obj, code=200):
        self._send(code, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache"},
                   json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def send_file(self, path, ctype, fname, inline):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except Exception:
            self.send_json({"error": "文件不存在"}, 404)
            return
        disp = "inline" if inline else "attachment"
        import urllib.parse as up
        ascii_name = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in fname) or "file"
        self._send(200, {
            "Content-Type": ctype,
            "Content-Disposition": '%s; filename="%s"; filename*=UTF-8\'\'%s'
                                   % (disp, ascii_name, up.quote(fname, safe="")),
            "Cache-Control": "no-cache",
        }, data)

    def read_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except Exception:
            n = 0
        if n > MAX_BODY:
            return None, 413
        if n == 0:
            return b"", 200
        return self.rfile.read(n), 200

    def parse_body(self):
        raw, code = self.read_body()
        if code != 200:
            return None, code
        if not raw:
            return {}, 200
        try:
            return json.loads(raw.decode("utf-8")), 200
        except Exception:
            return None, 400

    # ---------- 口令 ----------
    def _session_cookie(self):
        for part in (self.headers.get("Cookie", "") or "").split(";"):
            part = part.strip()
            if part.startswith(COOKIE_NAME + "="):
                return part[len(COOKIE_NAME) + 1:]
        return ""

    def _make_session(self):
        exp = int(time.time()) + SESSION_MAX_AGE
        payload = "%s|%d" % (ACCESS_USER, exp)
        sig = hmac.new(("pl-secret:" + ACCESS_PASS).encode("utf-8"),
                       payload.encode("utf-8"), hashlib.sha256).hexdigest()[:40]
        return base64.urlsafe_b64encode((payload + "|" + sig).encode("utf-8")).decode("ascii").rstrip("=")

    def _valid_session(self, token):
        if not token:
            return False
        try:
            raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode("utf-8", "replace")
            parts = raw.split("|")
            if len(parts) != 3:
                return False
            payload = parts[0] + "|" + parts[1]
            want = hmac.new(("pl-secret:" + ACCESS_PASS).encode("utf-8"),
                            payload.encode("utf-8"), hashlib.sha256).hexdigest()[:40]
            if not (hmac.compare_digest(parts[2], want) and hmac.compare_digest(parts[0], ACCESS_USER)):
                return False
            return int(parts[1]) > time.time()
        except Exception:
            return False

    def _basic_ok(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        try:
            got = base64.b64decode(auth[6:].strip()).decode("utf-8", "replace")
        except Exception:
            return False
        return hmac.compare_digest(got, "%s:%s" % (ACCESS_USER, ACCESS_PASS))

    def _auth_ok(self):
        if not ACCESS_USER:
            return True
        return self._valid_session(self._session_cookie()) or self._basic_ok()

    def _redirect(self, target):
        self._responded = True
        self.send_response(303)
        self.send_header("Location", target)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _urldecode(self, s):
        s = s.replace("+", " ")
        out, i, n = [], 0, len(s)
        while i < n:
            if s[i] == "%" and i + 2 < n:
                try:
                    out.append(chr(int(s[i + 1:i + 3], 16)))
                    i += 3
                    continue
                except Exception:
                    pass
            out.append(s[i])
            i += 1
        return "".join(out)

    def _handle_login(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(min(length, 4096)).decode("utf-8", "replace") if length else ""
        except Exception:
            raw = ""
        form = {}
        for kv in raw.split("&"):
            if "=" in kv:
                k, v = kv.split("=", 1)
                form[self._urldecode(k)] = self._urldecode(v)
        if (hmac.compare_digest(form.get("user", ""), ACCESS_USER)
                and hmac.compare_digest(form.get("pass", ""), ACCESS_PASS)):
            self._responded = True
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Lax"
                             % (COOKIE_NAME, self._make_session(), SESSION_MAX_AGE))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send_login_page("账号或口令不正确，请重试")

    def _send_login_page(self, error=""):
        err_html = ('<div class="err">%s</div>' % error) if error else ""
        html = '''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#16324f">
<title>登录 · __SITE__</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2316324f'/%3E%3Cpath d='M9 10h14M9 16h9M9 22h11' stroke='%23fbbf24' stroke-width='2.4' stroke-linecap='round'/%3E%3C/svg%3E">
<style>
* { box-sizing: border-box; }
html { height: 100%; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 22px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  font: 15px/1.6 "PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif; color: #e8edf4;
  background: #0f2438;
  background: radial-gradient(900px 460px at 92% -6%, rgba(251,191,36,.10) 0%, rgba(251,191,36,0) 62%),
              radial-gradient(760px 420px at -8% 2%, rgba(22,50,79,.55) 0%, rgba(22,50,79,0) 58%), #0f2438; }
.card { width: 100%; max-width: 380px; background: #16324f; border: 1px solid #2a4a6b;
  border-radius: 16px; box-shadow: 0 18px 50px rgba(0,0,0,.45); padding: 30px 26px 24px; margin: auto; }
.logo { width: 54px; height: 54px; border-radius: 14px; margin: 0 auto 14px; display: flex;
  align-items: center; justify-content: center; background: #0f2438; box-shadow: 0 10px 24px rgba(0,0,0,.35); }
h1 { font-size: 20px; text-align: center; margin: 0 0 6px; letter-spacing: .3px; color: #ffffff; }
.sub { text-align: center; color: #93a7bd; font-size: 12.5px; margin: 0 0 20px; }
label { display: block; font-size: 13px; font-weight: 700; color: #93a7bd; margin: 12px 0 6px; }
input { width: 100%; padding: 13px 14px; border: 1.5px solid #2a4a6b; border-radius: 8px;
  font: inherit; font-size: 16px; background: #1c3c5e; color: #e8edf4; }
input:focus { outline: none; border-color: #fbbf24; box-shadow: 0 0 0 4px rgba(251,191,36,.16); }
button { width: 100%; margin-top: 18px; padding: 13px; border: none; border-radius: 8px; cursor: pointer;
  font: inherit; font-size: 15px; font-weight: 800; color: #16324f; letter-spacing: 2px;
  background: linear-gradient(135deg,#fcd34d,#fbbf24); box-shadow: 0 10px 22px rgba(251,191,36,.28);
  transition: filter .15s ease, transform .15s ease; }
button:hover { filter: brightness(1.06); }
button:active { transform: scale(.98); }
.err { background: #4a2724; color: #f3a9a3; border-radius: 8px; padding: 10px 13px; font-size: 13.5px;
  font-weight: 600; margin-bottom: 4px; }
.tips { text-align: center; color: #6d8098; font-size: 12px; margin: 16px 0 0; }
</style></head>
<body>
<div class="card">
  <div class="logo"><svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#16324f"/><path d="M9 10h14M9 16h9M9 22h11" stroke="#fbbf24" stroke-width="2.4" stroke-linecap="round"/></svg></div>
  <h1>__SITE__</h1>
  <p class="sub">通用流程台账 · 登录一次，一年内本设备免重复输入</p>
  __ERROR__
  <form method="post" action="/login">
    <label>访问账号</label>
    <input name="user" type="text" autocomplete="username">
    <label>访问口令</label>
    <input name="pass" type="password" autocomplete="current-password">
    <button type="submit">进入系统</button>
  </form>
  <p class="tips">手机与电脑首次登录后都会自动记住</p>
</div>
</body></html>'''
        html = html.replace("__ERROR__", err_html).replace("__SITE__", SITE_NAME)
        self._send(200, {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache"},
                   html.encode("utf-8"))

    def _check_access(self):
        """访问口令关卡。⚠️ 刻意不带 WWW-Authenticate（否则浏览器会挂起请求）。"""
        if not ACCESS_USER or self._auth_ok():
            return True
        path = urlparse(self.path).path
        if path == "/favicon.ico":
            return True
        if self.command == "GET" and path == "/":
            self._send_login_page()
            return False
        if path.startswith("/api/"):
            body = json.dumps({"ok": False, "needAuth": True, "error": "需要访问口令"},
                              ensure_ascii=False).encode("utf-8")
            ctype = "application/json; charset=utf-8"
        else:
            body = "需要访问口令，请先登录".encode("utf-8")
            ctype = "text/plain; charset=utf-8"
        self._responded = True
        self.send_response(401)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass
        return False

    # ---------- 路由 ----------
    def route(self, method):
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)
        self._responded = False
        if path == "/login":
            if method == "POST":
                self._handle_login()
            elif self._auth_ok():
                self._redirect("/")
            else:
                self._send_login_page()
            return
        if not self._check_access():
            return
        conn = db()
        try:
            static_map = {"/": "text/html; charset=utf-8",
                          "/index.html": "text/html; charset=utf-8",
                          "/style.css": "text/css; charset=utf-8",
                          "/app.js": "application/javascript; charset=utf-8"}
            if path in static_map:
                fname = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
                with open(os.path.join(BASE_DIR, fname), "rb") as f:
                    self._send(200, {"Content-Type": static_map[path], "Cache-Control": "no-cache"},
                               f.read())
                return
            if path == "/favicon.ico":
                self._send(204, {}, b"")
                return
            if not path.startswith("/api/"):
                self.send_json({"error": "not found"}, 404)
                return
            seg = path[len("/api/"):].rstrip("/").split("/")

            # ===== 元信息 =====
            if seg[0] == "meta" and len(seg) == 1:
                self.send_json({"site": SITE_NAME, "core_fields": CORE_FIELDS,
                                "gate_fields": GATE_FIELDS, "max_steps": MAX_STEPS,
                                "default_flow_id": default_flow_id(conn)})
                return

            # ===== 产线流程 =====
            if seg[0] == "flows":
                if len(seg) == 1:
                    if method == "GET":
                        self.send_json(flow_list(conn))
                    elif method == "POST":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        name = (body.get("name") or "").strip()
                        if not name:
                            return self.send_json({"error": "流程名称必填"}, 400)
                        steps = body.get("steps")
                        if not isinstance(steps, list) or not steps:
                            steps = [dict(s) for s in DEFAULT_STEPS]
                        if len(steps) > MAX_STEPS:
                            return self.send_json({"error": "环节数不能超过 %d" % MAX_STEPS}, 400)
                        mx = conn.execute("SELECT COALESCE(MAX(sort),-1) m FROM flows").fetchone()["m"]
                        cur = conn.execute("INSERT INTO flows(name, is_default, sort, created_at, updated_at) "
                                           "VALUES(?,0,?,?,?)", (name, mx + 1, now(), now()))
                        fid = cur.lastrowid
                        for i, s in enumerate(steps):
                            nm = (s.get("name") or "").strip() or ("环节%d" % (i + 1))
                            conn.execute("INSERT INTO steps(flow_id, name, gate, enabled, sort) "
                                         "VALUES(?,?,?,?,?)",
                                         (fid, nm, s.get("gate") or "none",
                                          0 if s.get("enabled") is False else 1, i))
                        conn.commit()
                        self.send_json(flow_dict(conn, fid), 201)
                    return
                if len(seg) == 2 and seg[1].isdigit():
                    fid = int(seg[1])
                    f = conn.execute("SELECT * FROM flows WHERE id=?", (fid,)).fetchone()
                    if not f:
                        return self.send_json({"error": "产线流程不存在"}, 404)
                    if method == "GET":
                        self.send_json(flow_dict(conn, fid))
                    elif method == "PUT":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        name = (body.get("name") or "").strip()
                        if not name:
                            return self.send_json({"error": "流程名称必填"}, 400)
                        steps = body.get("steps")
                        if steps is not None:
                            if not isinstance(steps, list) or not steps:
                                return self.send_json({"error": "至少保留一个环节"}, 400)
                            if len(steps) > MAX_STEPS:
                                return self.send_json({"error": "环节数不能超过 %d" % MAX_STEPS}, 400)
                            old = {r["id"]: r for r in conn.execute(
                                "SELECT * FROM steps WHERE flow_id=?", (fid,)).fetchall()}
                            keep = set()
                            for i, s in enumerate(steps):
                                nm = (s.get("name") or "").strip()
                                if not nm:
                                    return self.send_json({"error": "第 %d 个环节名称不能为空" % (i + 1)}, 400)
                                sid = s.get("id")
                                if sid and int(sid) in old:
                                    keep.add(int(sid))
                            # 删除环节前校验其下是否有记录（防断链）
                            for oid in old:
                                if oid not in keep:
                                    n = conn.execute("SELECT COUNT(*) c FROM records WHERE step_id=?",
                                                     (oid,)).fetchone()["c"]
                                    if n > 0:
                                        return self.send_json(
                                            {"error": "环节「%s」下还有 %d 条记录，无法删除"
                                                      % (old[oid]["name"], n)}, 400)
                            for oid in old:
                                if oid not in keep:
                                    conn.execute("DELETE FROM attribute_defs WHERE step_id=?", (oid,))
                                    conn.execute("DELETE FROM steps WHERE id=?", (oid,))
                            for i, s in enumerate(steps):
                                nm = (s.get("name") or "").strip()
                                gate = s.get("gate") or "none"
                                en = 0 if s.get("enabled") is False else 1
                                sid = s.get("id")
                                if sid and int(sid) in old:
                                    conn.execute("UPDATE steps SET name=?, gate=?, enabled=?, sort=? "
                                                 "WHERE id=?", (nm, gate, en, i, int(sid)))
                                else:
                                    conn.execute("INSERT INTO steps(flow_id, name, gate, enabled, sort) "
                                                 "VALUES(?,?,?,?,?)", (fid, nm, gate, en, i))
                        conn.execute("UPDATE flows SET name=?, updated_at=? WHERE id=?",
                                     (name, now(), fid))
                        conn.commit()
                        self.send_json(flow_dict(conn, fid))
                    elif method == "DELETE":
                        n = conn.execute("SELECT COUNT(*) c FROM records WHERE flow_id=?",
                                         (fid,)).fetchone()["c"]
                        if n > 0:
                            return self.send_json(
                                {"error": "该产线流程下还有 %d 条记录，无法删除（请先清空）" % n}, 400)
                        if conn.execute("SELECT COUNT(*) c FROM flows").fetchone()["c"] <= 1:
                            return self.send_json({"error": "至少要保留一条产线流程"}, 400)
                        conn.execute("DELETE FROM steps WHERE flow_id=?", (fid,))
                        conn.execute("DELETE FROM attribute_defs WHERE flow_id=?", (fid,))
                        conn.execute("DELETE FROM flows WHERE id=?", (fid,))
                        if f["is_default"]:
                            conn.execute("UPDATE flows SET is_default=1 WHERE id="
                                         "(SELECT id FROM flows ORDER BY sort, id LIMIT 1)")
                        conn.commit()
                        self.send_json({"ok": True})
                    return
                if len(seg) == 3 and seg[1].isdigit() and seg[2] == "default":
                    if method != "POST":
                        return self.send_json({"error": "method not allowed"}, 405)
                    fid = int(seg[1])
                    if not conn.execute("SELECT 1 FROM flows WHERE id=?", (fid,)).fetchone():
                        return self.send_json({"error": "产线流程不存在"}, 404)
                    conn.execute("UPDATE flows SET is_default=0")
                    conn.execute("UPDATE flows SET is_default=1 WHERE id=?", (fid,))
                    conn.commit()
                    self.send_json({"ok": True})
                    return

            # ===== 统计 =====
            if seg[0] == "stat" and len(seg) == 1:
                fid = q.get("flow", [None])[0]
                fid = int(fid) if fid and fid.isdigit() else default_flow_id(conn)
                f = flow_dict(conn, fid) if fid else None
                if not f:
                    return self.send_json({"flow": None, "steps": [], "attachments": 0, "total": 0})
                items, total = [], 0
                for s in f["steps"]:
                    c = conn.execute("SELECT COUNT(*) c FROM records WHERE flow_id=? AND step_id=?",
                                     (fid, s["id"])).fetchone()["c"]
                    items.append({"id": s["id"], "name": s["name"], "count": c, "gate": s["gate"]})
                    total += c
                at = conn.execute("SELECT COUNT(*) c FROM attachments a JOIN records r ON a.record_id=r.id "
                                  "WHERE r.flow_id=?", (fid,)).fetchone()["c"]
                self.send_json({"flow": {"id": f["id"], "name": f["name"], "is_default": f["is_default"]},
                                "steps": items, "total": total, "attachments": at})
                return

            # ===== 属性定义 =====
            if seg[0] == "attr-defs":
                if len(seg) == 1:
                    if method == "GET":
                        fid = q.get("flow", [None])[0]
                        sid = q.get("step", [None])[0]
                        if not (fid and fid.isdigit() and sid and sid.isdigit()):
                            return self.send_json({"error": "需提供 flow 与 step"}, 400)
                        self.send_json(attr_defs(conn, int(fid), int(sid)))
                    elif method == "POST":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        try:
                            fid = int(body.get("flow_id"))
                            sid = int(body.get("step_id"))
                        except Exception:
                            return self.send_json({"error": "flow_id / step_id 必填"}, 400)
                        key = (body.get("key") or "").strip()
                        if not key:
                            return self.send_json({"error": "key 必填"}, 400)
                        if not conn.execute("SELECT 1 FROM steps WHERE id=? AND flow_id=?",
                                            (sid, fid)).fetchone():
                            return self.send_json({"error": "环节不存在"}, 404)
                        if conn.execute("SELECT 1 FROM attribute_defs WHERE flow_id=? AND step_id=? AND key=?",
                                        (fid, sid, key)).fetchone():
                            return self.send_json({"error": "该环节下已存在相同 key：" + key}, 409)
                        conn.execute("INSERT INTO attribute_defs(flow_id, step_id, key, name, atype, "
                                     "required, options, sort) VALUES(?,?,?,?,?,?,?,?)",
                                     (fid, sid, key, body.get("name") or key,
                                      body.get("atype") or "text",
                                      1 if body.get("required") else 0,
                                      json.dumps(body.get("options") or [], ensure_ascii=False),
                                      int(body.get("sort") or 0)))
                        conn.commit()
                        self.send_json({"ok": True, "id": conn.execute(
                            "SELECT last_insert_rowid()").fetchone()[0]}, 201)
                    return
                if len(seg) == 2 and seg[1].isdigit():
                    did = int(seg[1])
                    if method == "DELETE":
                        conn.execute("DELETE FROM attribute_defs WHERE id=?", (did,))
                        conn.commit()
                        self.send_json({"ok": True})
                    elif method == "PUT":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        cur = conn.execute("SELECT * FROM attribute_defs WHERE id=?", (did,)).fetchone()
                        if not cur:
                            return self.send_json({"error": "不存在"}, 404)
                        conn.execute("UPDATE attribute_defs SET key=?, name=?, atype=?, required=?, "
                                     "options=?, sort=? WHERE id=?",
                                     ((body.get("key") or cur["key"]).strip(),
                                      body.get("name") or cur["name"],
                                      body.get("atype") or cur["atype"],
                                      1 if body.get("required") else 0,
                                      json.dumps(body.get("options") or [], ensure_ascii=False),
                                      int(body.get("sort") or cur["sort"]), did))
                        conn.commit()
                        self.send_json({"ok": True})
                    return

            # ===== 附件 =====
            if (seg[0] == "attachments" and len(seg) in (2, 3) and seg[1].isdigit()
                    and (len(seg) == 2 or seg[2] == "file")):
                aid = int(seg[1])
                row = conn.execute("SELECT * FROM attachments WHERE id=?", (aid,)).fetchone()
                if not row:
                    return self.send_json({"error": "附件不存在"}, 404)
                if method == "GET":
                    disp = q.get("d", ["inline"])[0]
                    ctype = CTYPES.get(os.path.splitext(row["filename"])[1].lower(),
                                       row["ftype"] or "application/octet-stream")
                    self.send_file(row["path"], ctype, row["filename"], disp == "inline")
                elif method == "DELETE":
                    if os.path.exists(row["path"]):
                        try:
                            os.remove(row["path"])
                        except Exception:
                            pass
                    conn.execute("DELETE FROM attachments WHERE id=?", (aid,))
                    conn.commit()
                    self.send_json({"ok": True})
                return

            # ===== 记录 =====
            if seg[0] == "records":
                if len(seg) == 1:
                    if method == "GET":
                        fid = q.get("flow", [None])[0]
                        sid = q.get("step", [None])[0]
                        if not (fid and fid.isdigit()):
                            return self.send_json({"error": "需提供 flow"}, 400)
                        if not (sid and sid.isdigit()):
                            # 不给 step → 返回该流程下的【全部记录】（跨环节、跨层级）
                            #   用途：客户端清空一个流程前需要完整枚举（删除需自底向上）
                            rows = conn.execute("SELECT * FROM records WHERE flow_id=? ORDER BY id",
                                                (int(fid),)).fetchall()
                            out = []
                            for r in rows:
                                d = rowd(r)
                                d["attachments"] = load_atts(conn, r["id"])
                                d["attrs"] = load_attrs(conn, r["id"])
                                out.append(d)
                            return self.send_json(out)
                        p = q.get("parent", [None])[0]
                        self.send_json(list_records(conn, int(fid), int(sid),
                                                    int(p) if p and p.isdigit() else None))
                    elif method == "POST":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        try:
                            fid = int(body.get("flow_id"))
                            sid = int(body.get("step_id"))
                        except Exception:
                            return self.send_json({"error": "flow_id / step_id 必填"}, 400)
                        if not conn.execute("SELECT 1 FROM steps WHERE id=? AND flow_id=?",
                                            (sid, fid)).fetchone():
                            return self.send_json({"error": "环节不存在"}, 404)
                        title = (body.get("title") or "").strip()
                        if not title:
                            return self.send_json({"error": "名称必填"}, 400)
                        pid = body.get("parent_id")
                        pid = int(pid) if pid not in (None, "", 0) else None
                        if pid and not conn.execute("SELECT 1 FROM records WHERE id=? AND flow_id=?",
                                                    (pid, fid)).fetchone():
                            return self.send_json({"error": "父记录不存在"}, 404)
                        cols = ["flow_id", "step_id", "parent_id", "created_at", "updated_at"]
                        vals = [fid, sid, pid, now(), now()]
                        for f in CORE_FIELDS:
                            k = f["key"]
                            if k in body:
                                cols.append(k)
                                vals.append(body[k] if body[k] is not None else "")
                        conn.execute("INSERT INTO records(%s) VALUES(%s)"
                                     % (",".join(cols), ",".join("?" * len(cols))), vals)
                        rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                        if isinstance(body.get("attrs"), dict):
                            save_attrs(conn, rid, body["attrs"])
                        conn.commit()
                        self.send_json(record_full(conn, rid), 201)
                    return
                if len(seg) == 2 and seg[1].isdigit():
                    rid = int(seg[1])
                    if method == "GET":
                        d = record_full(conn, rid)
                        if not d:
                            return self.send_json({"error": "记录不存在"}, 404)
                        self.send_json(d)
                    elif method == "PUT":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        sets, vals = [], []
                        for f in CORE_FIELDS:
                            k = f["key"]
                            if k in body:
                                sets.append("%s=?" % k)
                                vals.append(body[k] if body[k] is not None else "")
                        if sets:
                            conn.execute("UPDATE records SET %s, updated_at=? WHERE id=?"
                                         % ",".join(sets), vals + [now(), rid])
                        if isinstance(body.get("attrs"), dict):
                            save_attrs(conn, rid, body["attrs"])
                        conn.commit()
                        d = record_full(conn, rid)
                        if not d:
                            return self.send_json({"error": "记录不存在"}, 404)
                        self.send_json(d)
                    elif method == "DELETE":
                        ok, msg = delete_record(conn, rid)
                        if not ok:
                            return self.send_json({"error": msg}, 400)
                        self.send_json({"ok": True})
                    return
                if len(seg) == 3 and seg[1].isdigit() and seg[2] == "attrs":
                    rid = int(seg[1])
                    if method == "PUT":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        if not conn.execute("SELECT 1 FROM records WHERE id=?", (rid,)).fetchone():
                            return self.send_json({"error": "记录不存在"}, 404)
                        save_attrs(conn, rid, body.get("attrs") or {})
                        conn.commit()
                        self.send_json(record_full(conn, rid))
                    return
                if len(seg) == 3 and seg[1].isdigit() and seg[2] == "attachments":
                    rid = int(seg[1])
                    if method == "POST":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        if not conn.execute("SELECT 1 FROM records WHERE id=?", (rid,)).fetchone():
                            return self.send_json({"error": "记录不存在"}, 404)
                        if not body.get("b64"):
                            return self.send_json({"error": "缺少文件内容"}, 400)
                        aid, err = save_attachment(conn, rid, body.get("attr_key"),
                                                   body.get("filename", "file"),
                                                   body.get("ftype", ""), body["b64"])
                        if err:
                            return self.send_json({"error": err}, 400)
                        conn.commit()
                        row = conn.execute("SELECT id, attr_key, filename, ftype, size, created_at "
                                           "FROM attachments WHERE id=?", (aid,)).fetchone()
                        self.send_json(rowd(row), 201)
                    return
                if len(seg) == 3 and seg[1].isdigit() and seg[2] == "review":
                    rid = int(seg[1])
                    if method == "PUT":
                        body, c = self.parse_body()
                        if c != 200:
                            return self.send_json({"error": "请求体无效"}, c)
                        r = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
                        if not r:
                            return self.send_json({"error": "记录不存在"}, 404)
                        st = step_of(conn, r["step_id"])
                        if not st or st["gate"] != "review":
                            return self.send_json({"error": "该环节未设评审门"}, 400)
                        action = body.get("action")
                        smap = {"submit": "评审中", "approve": "通过", "reject": "驳回"}
                        if action not in smap:
                            return self.send_json({"error": "action 无效"}, 400)
                        conn.execute("UPDATE records SET review_status=?, review_comment=?, updated_at=? "
                                     "WHERE id=?", (smap[action], body.get("comment", ""), now(), rid))
                        conn.commit()
                        self.send_json(record_full(conn, rid))
                    return

            self.send_json({"error": "not found"}, 404)
        except Exception as e:
            if getattr(self, "_responded", False):
                print("[route-error after headers sent] %s %s: %s" % (method, path, e), flush=True)
            else:
                try:
                    self.send_json({"error": "服务器内部错误: %s" % e}, 500)
                except Exception:
                    pass
        finally:
            conn.close()

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    init_db()
    print("%s server on :%d" % (SITE_NAME, PORT), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
