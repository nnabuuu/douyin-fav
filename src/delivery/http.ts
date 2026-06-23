import http from "node:http";
import type { JobQueue } from "../application/job-queue.js";
import type { TokenAdmin } from "../application/token-admin.js";
import type { SyncService } from "../application/sync-service.js";
import type { Analyzer, ConfigStore, Exporter } from "../domain/ports.js";
import type { VideoResult, Platform } from "../domain/model.js";
import type { SystemCheck } from "../infrastructure/system-check.js";

const TOKEN = process.env.TOKEN || ""; // if set, gate /api/* with ?token=
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Deps {
  jobs: JobQueue<VideoResult>;
  admin: TokenAdmin;
  config: ConfigStore;
  sync: SyncService;
  analyzer: Analyzer;
  exporter: Exporter;
  systemCheck: SystemCheck;
}

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "content-type": type + "; charset=utf-8" });
  res.end(type.includes("json") ? JSON.stringify(body) : (body as string));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); } });
  });
}

export function createHttp(deps: Deps): http.Server {
  const { jobs, admin, config, sync, analyzer, exporter, systemCheck: sys } = deps;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const { pathname } = url;
    const method = req.method || "GET";

    if (method === "GET" && pathname === "/") return send(res, 200, PAGE, "text/html");
    if (method === "GET" && pathname === "/config") return send(res, 200, CONFIG_PAGE, "text/html");
    if (method === "GET" && pathname === "/setup") return send(res, 200, SETUP_PAGE, "text/html");

    if (pathname.startsWith("/api/")) {
      if (TOKEN && url.searchParams.get("token") !== TOKEN) return send(res, 401, { error: "bad token" });

      // ── setup wizard ──
      if (method === "GET" && pathname === "/api/setup/status") {
        const cfg = config.get();
        const valid = admin.list().filter((t) => t.status === "valid");
        let notion: { ok: boolean; detail: string };
        if (!cfg.notion.token || !cfg.notion.databaseId) {
          notion = { ok: false, detail: "未配置 token / 库" };
        } else {
          try { await exporter.has("__setup_probe__"); notion = { ok: true, detail: "已连接" }; }
          catch (e) { notion = { ok: false, detail: "连接失败: " + msg(e) }; }
        }
        return send(res, 200, {
          node: sys.node(), chromium: sys.chromium(), ffmpeg: sys.ffmpeg(), whisper: sys.whisper(),
          tokens: { ok: valid.length > 0, detail: valid.length ? `${valid.length} 个有效` : "无有效 token", count: valid.length },
          notion,
          folders: cfg.folders, schedule: cfg.schedule,
        });
      }
      if (method === "POST" && pathname === "/api/setup/install/chromium") return send(res, 200, await sys.installChromium());
      if (method === "POST" && pathname === "/api/setup/install/whisper") return send(res, 200, await sys.installWhisper());

      // ── config ──
      if (method === "GET" && pathname === "/api/config") return send(res, 200, config.get());
      if (method === "PUT" && pathname === "/api/config") {
        const patch = await readJson(req);
        return send(res, 200, config.update(patch));
      }
      // Notion connectivity test (the "保存并测试" buttons)
      if (method === "POST" && pathname === "/api/notion/test") {
        const { token, databaseId } = config.get().notion;
        if (!token || !databaseId) return send(res, 200, { ok: false, detail: "未配置 token / 库" });
        try { await exporter.has("__notion_test__"); return send(res, 200, { ok: true, detail: "已连接" }); }
        catch (e) { return send(res, 200, { ok: false, detail: "连接失败: " + msg(e) }); }
      }

      // ── auto-sync ──
      if (method === "POST" && pathname === "/api/sync/run") {
        sync.runOnce().catch(() => {}); // fire-and-forget; watch via /api/sync/status
        return send(res, 200, { started: true });
      }
      if (method === "GET" && pathname === "/api/sync/status") return send(res, 200, sync.status());
      if (method === "POST" && pathname === "/api/sync/start") { sync.start(); return send(res, 200, sync.status()); }
      if (method === "POST" && pathname === "/api/sync/stop") { sync.stop(); return send(res, 200, sync.status()); }

      // ── transcription jobs ──
      if (method === "POST" && pathname === "/api/jobs") {
        const body = await readJson(req);
        const input = String(body.url || "").trim();
        if (!input) return send(res, 400, { error: "missing url" });
        const job = jobs.submit(input);
        return send(res, 200, { id: job.id, status: job.status });
      }
      const jm = pathname.match(/^\/api\/jobs\/(\w+)$/);
      if (method === "GET" && jm) {
        const job = jobs.get(jm[1]);
        if (!job) return send(res, 404, { error: "no such job" });
        return send(res, 200, {
          status: job.status, ...jobs.position(job.id),
          log: job.log, result: job.result, error: job.error, errorKind: job.errorKind,
        });
      }
      // per-video manual export to Notion (the Transcribe page's "同步到 Notion" button)
      const em = pathname.match(/^\/api\/jobs\/(\w+)\/export-notion$/);
      if (method === "POST" && em) {
        const job = jobs.get(em[1]);
        if (!job) return send(res, 404, { error: "no such job" });
        if (job.status !== "done" || !job.result) return send(res, 400, { error: "job 未完成" });
        try {
          const { cleaned, summary } = await analyzer.analyze(job.result);
          const outcome = await exporter.export(job.result, cleaned, summary); // "created" | "skipped"
          return send(res, 200, { outcome });
        } catch (e) {
          return send(res, 200, { outcome: "error", detail: msg(e) }); // bad/expired Notion token, etc.
        }
      }

      // ── token pool ──
      if (method === "GET" && pathname === "/api/tokens") return send(res, 200, admin.list());
      if (method === "POST" && pathname === "/api/tokens") {
        const body = await readJson(req);
        const platform = (body.platform || "douyin") as Platform;
        const token = admin.beginAdd(platform, body.label);
        return send(res, 200, token); // status: logging_in — poll the token to watch login
      }
      const tm = pathname.match(/^\/api\/tokens\/(\w+)$/);
      if (tm) {
        if (method === "GET") {
          const t = admin.get(tm[1]);
          return t ? send(res, 200, t) : send(res, 404, { error: "no such token" });
        }
        if (method === "DELETE") {
          return send(res, 200, { ok: admin.remove(tm[1]) });
        }
      }
      const vm = pathname.match(/^\/api\/tokens\/(\w+)\/validate$/);
      if (method === "POST" && vm) {
        const t = await admin.validate(vm[1]);
        return t ? send(res, 200, t) : send(res, 404, { error: "no such token" });
      }
    }

    send(res, 404, { error: "not found" });
  });
}

// Minimal built-in page for transcription (token-pool UI is built separately in Claude Design).
const PAGE = `<!doctype html><meta charset=utf-8><title>抖音字幕</title>
<style>body{font:16px/1.6 system-ui;max-width:760px;margin:40px auto;padding:0 16px}
input{width:100%;padding:10px;font-size:16px}button{padding:10px 20px;font-size:16px;margin-top:8px}
pre{white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px}</style>
<h2>字幕提取</h2><p>粘贴抖音视频链接(/video/、?modal_id=、v.douyin.com 短链),回车。</p>
<input id=u placeholder="https://www.douyin.com/video/..."><button onclick=go()>提取</button>
<p id=s></p><pre id=o></pre>
<script>
const tok=new URLSearchParams(location.search).get('token')||''
const q=p=>tok?p+'?token='+tok:p
async function go(){const url=document.getElementById('u').value.trim();if(!url)return
 const s=document.getElementById('s'),o=document.getElementById('o');o.textContent='';s.textContent='提交中…'
 const r=await fetch(q('/api/jobs'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})})
 const j=await r.json();if(!r.ok){s.textContent='错误: '+(j.error||r.status);return}poll(j.id,s,o)}
async function poll(id,s,o){const r=await fetch(q('/api/jobs/'+id));const j=await r.json()
 let h=j.status
 if(j.status==='queued')h='排队中 — 第 '+j.position+' 位'+(j.ahead?'(前面 '+j.ahead+' 个)':'')
 else if(j.status==='running')h='处理中…'
 s.textContent=h+(j.log&&j.log.length?' — '+j.log[j.log.length-1]:'')
 if(j.status==='done'){const x=j.result;s.textContent='完成 ('+x.source+(x.cached?',缓存':'')+')'
  o.textContent=(x.desc?'【文案】\\n'+x.desc+'\\n\\n':'')+'【口播逐字稿】\\n'+x.transcript;return}
 if(j.status==='error'){s.textContent='失败: '+j.error;return}
 setTimeout(()=>poll(id,s,o),2000)}
document.getElementById('u').addEventListener('keydown',e=>{if(e.key==='Enter')go()})
</script>`;

// Minimal config + sync control page. The polished token-pool UI is built separately.
const CONFIG_PAGE = `<!doctype html><meta charset=utf-8><title>配置</title>
<style>body{font:15px/1.6 system-ui;max-width:820px;margin:32px auto;padding:0 16px}
textarea{width:100%;height:300px;font:13px/1.5 ui-monospace,monospace;padding:10px}
button{padding:8px 16px;font-size:15px;margin:6px 6px 0 0}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px}
a{color:#06c}</style>
<h2>douyin-fav 配置</h2>
<p>编辑 <code>config.json</code>。<code>notion.token</code> 填你的 Notion integration token、<code>notion.databaseId</code> 填目标库;<code>folders</code> 可加多个收藏夹。改完保存即生效。 · <a href="/">字幕提取</a></p>
<textarea id=c></textarea><br>
<button onclick=save()>保存</button>
<button onclick=runNow()>立即同步一轮</button>
<button onclick=start()>开启定时</button>
<button onclick=stop()>停止定时</button>
<button onclick=status()>查看状态</button>
<p id=s></p><pre id=o></pre>
<script>
const tok=new URLSearchParams(location.search).get('token')||''
const q=p=>tok?p+'?token='+tok:p
const s=document.getElementById('s'),o=document.getElementById('o'),c=document.getElementById('c')
async function load(){const r=await fetch(q('/api/config'));c.value=JSON.stringify(await r.json(),null,2)}
async function save(){try{const body=JSON.parse(c.value)
 const r=await fetch(q('/api/config'),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 c.value=JSON.stringify(await r.json(),null,2);s.textContent='已保存'}catch(e){s.textContent='JSON 错误: '+e.message}}
async function runNow(){await fetch(q('/api/sync/run'),{method:'POST'});s.textContent='已触发一轮,点“查看状态”看进度'}
async function start(){const r=await fetch(q('/api/sync/start'),{method:'POST'});o.textContent=JSON.stringify(await r.json(),null,2);s.textContent='定时已开启'}
async function stop(){const r=await fetch(q('/api/sync/stop'),{method:'POST'});o.textContent=JSON.stringify(await r.json(),null,2);s.textContent='定时已停止'}
async function status(){const r=await fetch(q('/api/sync/status'));o.textContent=JSON.stringify(await r.json(),null,2)}
load()
</script>`;

// Setup wizard — detects host prerequisites, installs what it can, guides the rest.
const SETUP_PAGE = `<!doctype html><meta charset=utf-8><title>setup 向导</title>
<style>
body{font:15px/1.6 system-ui;max-width:760px;margin:32px auto;padding:0 16px}
h3{margin:22px 0 6px;border-bottom:1px solid #eee;padding-bottom:4px}
.row{padding:5px 0}.st{margin-right:6px}.detail{color:#888}
.hint{margin:2px 0 8px 22px}.hint code{background:#f5f5f5;padding:2px 6px;border-radius:4px;user-select:all}
button{padding:5px 12px;font-size:14px;margin:2px 4px 2px 0;cursor:pointer}
input{padding:7px;font-size:14px;margin:2px 4px 2px 0}.form input{width:280px}
.banner{background:#e8f8ee;border:1px solid #b6e6c8;padding:10px 14px;border-radius:8px;margin-bottom:10px}
#msg{color:#06c;min-height:1.4em}#log{white-space:pre-wrap;background:#111;color:#8f8;padding:10px;border-radius:8px;font:12px/1.4 ui-monospace;max-height:200px;overflow:auto;margin-top:8px}
a{color:#06c}
</style>
<h2>douyin-fav 安装向导</h2>
<p>服务已在跑(这页就是它发的)。其余步骤都能在这里点完。 · <a id=cfglink href=/config>配置</a> · <a id=homelink href=/>字幕提取</a></p>
<div id=app>加载中…</div>
<p id=msg></p><div id=log></div>
<script>
var tok=new URLSearchParams(location.search).get('token')||''
function q(p){return tok?p+(p.indexOf('?')>=0?'&':'?')+'token='+tok:p}
function el(id){return document.getElementById(id)}
function dot(ok){return ok?'✅':'❌'}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')}
function row(label,st,actions){
  var h='<div class=row><span class=st>'+dot(st.ok)+'</span><b>'+label+'</b> <span class=detail>'+esc(st.detail)+'</span> '+(actions||'')+'</div>'
  if(st.fixHint&&!st.ok)h+='<div class=hint><code>'+esc(st.fixHint)+'</code></div>'
  return h
}
async function load(){
  var s=await (await fetch(q('/api/setup/status'))).json()
  var cfg={}; try{cfg=await (await fetch(q('/api/config'))).json()}catch(e){}
  el('cfglink').href=q('/config'); el('homelink').href=q('/')
  render(s,cfg)
}
function render(s,cfg){
  var allOk=s.node.ok&&s.chromium.ok&&s.ffmpeg.ok&&s.whisper.ok&&s.tokens.ok&&s.notion.ok
  var h=allOk?'<div class=banner>🎉 全部就绪。去 ④ 开启定时,或 ⑤ 立即同步一轮。</div>':''
  h+='<h3>① 环境依赖</h3>'
  h+=row('Node',s.node)
  h+=row('Chromium',s.chromium,s.chromium.ok?'<button data-act=recheck>重新检测</button>':'<button data-act=install data-tool=chromium>安装</button>')
  h+=row('ffmpeg',s.ffmpeg,'<button data-act=recheck>重新检测</button>')
  h+=row('whisper',s.whisper,(s.whisper.ok?'':'<button data-act=install data-tool=whisper>尝试安装</button> ')+'<button data-act=recheck>重新检测</button>')
  h+='<h3>② 抖音登录(扫码)</h3>'
  h+=row('token 池',s.tokens,'<button data-act=addtoken>+ 扫码加 token</button>')
  h+='<h3>③ Notion</h3>'
  h+=row('连接',s.notion)
  h+='<div class=form><input id=ntok type=password placeholder="Notion integration token"> '
  h+='<input id=ndb placeholder=databaseId value="'+esc(cfg.notion&&cfg.notion.databaseId)+'"> '
  h+='<button data-act=savenotion>保存并测试</button></div>'
  h+='<div class=hint><b>三步,第②步最容易漏:</b><br>① <a href="https://www.notion.so/my-integrations" target=_blank>notion.so/my-integrations</a> 新建 integration,复制 Internal Secret。<br>② <b>打开目标库 → 右上 ··· → Connections → 把这个 integration 加上</b>(把库共享给它)。<u>漏了这步,测试会「连接失败 / 找不到库」</u>——刚建的库默认没共享给任何 integration。<br>③ 把 secret 和库 ID 填上面,「保存并测试」,上面 Notion 那行变 ✅ 才算通。</div>'
  h+='<h3>④ 收藏夹与定时</h3>'
  h+='<div class=detail>收藏夹:<br>'+((s.folders||[]).map(esc).join('<br>')||'(无)')+'</div>'
  h+='<div class=detail>定时:'+(s.schedule.enabled?'已开启':'未开启')+' · 每 '+s.schedule.intervalMin+' 分钟 · 每轮 '+s.schedule.perRun+' 条</div>'
  h+='<button data-act=startsched>开启定时</button> <a href="'+q('/config')+'">去 /config 改收藏夹/节奏</a>'
  h+='<h3>⑤ 完成</h3><button data-act=runsync>立即同步一轮</button>'
  el('app').innerHTML=h
}
el('app').addEventListener('click',function(e){
  var a=e.target.getAttribute('data-act'); if(!a)return
  if(a==='recheck')load()
  else if(a==='install')doInstall(e.target.getAttribute('data-tool'))
  else if(a==='addtoken')addToken()
  else if(a==='savenotion')saveNotion()
  else if(a==='startsched')startSched()
  else if(a==='runsync')runSync()
})
async function doInstall(tool){
  el('msg').textContent='安装 '+tool+' 中…(下载可能几十秒,别关页面)'; el('log').textContent=''
  var r=await (await fetch(q('/api/setup/install/'+tool),{method:'POST'})).json()
  el('msg').textContent=r.ok?('✅ '+tool+' 安装完成'):('❌ '+tool+' 安装失败,看下方日志')
  el('log').textContent=r.log||''; load()
}
async function addToken(){
  var r=await (await fetch(q('/api/tokens'),{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json()
  el('msg').textContent='已弹出浏览器窗口,请在里面扫码登录…'
  var n=0,t=setInterval(async function(){ n++
    var tk=await (await fetch(q('/api/tokens/'+r.id))).json()
    if(tk.status==='valid'||tk.status==='invalid'||n>80){clearInterval(t)
      el('msg').textContent=tk.status==='valid'?'✅ 登录成功':('登录未完成('+tk.status+'),可重试'); load()}
  },3000)
}
async function saveNotion(){
  var n={},tk=el('ntok').value.trim(),db=el('ndb').value.trim()
  if(tk)n.token=tk; if(db)n.databaseId=db   // empty field must not wipe existing config
  if(!tk&&!db){el('msg').textContent='填了 token(和库)再保存';return}
  await fetch(q('/api/config'),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({notion:n})})
  el('msg').textContent='已保存,正在测试连接…'; load()
}
async function startSched(){ await fetch(q('/api/sync/start'),{method:'POST'}); el('msg').textContent='✅ 定时已开启'; load() }
async function runSync(){ await fetch(q('/api/sync/run'),{method:'POST'}); el('msg').textContent='已触发一轮,去 /config「查看状态」看进度' }
load()
</script>`;
