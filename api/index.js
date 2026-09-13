import { config, codeStore, statsStore, visitStore } from "./_store.js";

export const configApi = { runtime: "nodejs" };

function parseBody(raw) {
  if (!raw) return {};
  try {
    const s = Buffer.isBuffer(raw) ? raw.toString() : (typeof raw === "string" ? raw : JSON.stringify(raw));
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// 校验访客口令，通过则返回一次性短码
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const method = req.method;

  // —— 总开关状态（公开，前端用） ——
  if (method === "GET" && req.url.startsWith("/api/status")) {
    const c = await config.get();
    return res.status(200).json({ enabled: !!c.enabled, notice: c.notice || "" });
  }

  // —— 访客：提交口令换取一次性短码 ——
  if (method === "POST" && req.url.startsWith("/api/enter")) {
    let body = parseBody(req.body);
    const c = await config.get();
    if (!c.enabled) {
      return res.status(403).json({ error: "服务当前已停用" });
    }
    if (body.pass !== c.pass) {
      return res.status(401).json({ error: "口令不正确，请确认后重试" });
    }
    // 访问成功：记录当日访问统计 + 访问明细（时间/IP/设备/归属地）
    try { await statsStore.record(); } catch (e) {}
    try {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.headers["x-real-ip"] || "";
      const ua = req.headers["user-agent"] || "";
      const device = deviceFromUA(ua);
      const loc = await ipLocate(ip);
      await visitStore.add({ ip, device, loc });
    } catch (e) {}
    const code = await codeStore.create(c.officialUrl);
    return res.status(200).json({ ok: true, code, target: `/go/${code}` });
  }

  // —— 短码一次性消费跳转 ——
  if (method === "GET" && req.url.startsWith("/go/")) {
    const code = req.url.split("/go/")[1]?.split(/[?#]/)[0] || "";
    const c = await config.get();
    if (!c.enabled) {
      return html(res, 200, "服务已停用", "该迁移服务当前已停用，请联系管理员。");
    }
    if (!code) return html(res, 400, "无效链接", "链接无效，请<a href='/'>返回引导页</a>重新获取。");
    const target = await codeStore.consume(code);
    if (!target) {
      return html(res, 200, "链接已失效", "这个链接已使用或已过期，请<a href='/'>返回引导页</a>重新获取。");
    }
    return res.redirect(302, target);
  }

  // —— 访问统计（管理后台用，需管理口令）——
  if (method === "GET" && req.url.startsWith("/api/stats")) {
    const url = new URL(req.url, "http://x");
    const adminPass = url.searchParams.get("adminPass") || "";
    const c = await config.get();
    if (adminPass !== c.adminPass) {
      return res.status(403).json({ error: "管理口令不正确" });
    }
    const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10) || 7, 1), 30);
    const daily = await statsStore.recent(days);
    return res.status(200).json({ ok: true, daily });
  }

  // —— 访问明细（管理后台用，需管理口令）——
  if (method === "GET" && req.url.startsWith("/api/visits")) {
    const url = new URL(req.url, "http://x");
    const adminPass = url.searchParams.get("adminPass") || "";
    const c = await config.get();
    if (adminPass !== c.adminPass) {
      return res.status(403).json({ error: "管理口令不正确" });
    }
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 100);
    const visits = await visitStore.recent(limit);
    return res.status(200).json({ ok: true, visits });
  }

  // —— 不支持的请求 ——
  return res.status(404).json({ error: "Not Found" });
}

function html(res, status, title, msg) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(status).send(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>
    <body style="font-family:system-ui;background:#f2f5fa;color:#22304a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
    <div style="text-align:center;padding:30px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.08)">
      <h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#6b7280">${msg}</p></div></body></html>`
  );
}

// 从 User-Agent 识别设备 / 浏览器类型（含国内主流浏览器与 App 内置浏览器）
function deviceFromUA(ua) {
  ua = ua || "";
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua);
  // 顺序很重要：先匹配 App 内置/国产浏览器（它们大多也含 Chrome 字样），再匹配通用内核
  const rules = [
    [/MicroMessenger/i, "微信"],
    [/QQ\/\d|QQBrowser|MQQBrowser/i, "QQ浏览器"],
    [/UCBrowser|UBrowser/i, "UC浏览器"],
    [/BIDUBrowser|Baidu/i, "百度浏览器"],
    [/Sogou|MetaSr/i, "搜狗浏览器"],
    [/HuaweiBrowser/i, "华为浏览器"],
    [/MiuiBrowser/i, "小米浏览器"],
    [/HeyTapBrowser/i, "OPPO浏览器"],
    [/VivoBrowser/i, "vivo浏览器"],
    [/SamsungBrowser/i, "三星浏览器"],
    [/Weibo/i, "微博"],
    [/aweme|BytedanceWebview|ByteFullSdk|news_article/i, "抖音/头条"],
    [/EdgA|Edg/i, "Edge"],
    [/OPR|Opera/i, "Opera"],
    [/Firefox/i, "Firefox"],
    [/Chrome|CriOS/i, "Chrome"],
    [/Safari/i, "Safari"],
  ];
  let browser = "未知";
  for (const [re, name] of rules) {
    if (re.test(ua)) { browser = name; break; }
  }
  return (isMobile ? "手机·" : "电脑·") + browser;
}

// 通过 ip-api 免费接口查询归属地（尽力而为，失败返回"未知"）
async function ipLocate(ip) {
  if (!ip || ip === "::1" || ip === "127.0.0.1" || ip.startsWith("10.") ||
      ip.startsWith("192.168.") || ip.startsWith("172.16.")) {
    return "内网/本机";
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(`https://ipapi.co/${ip}/json/`, { signal: ctrl.signal });
    const d = await r.json();
    if (d && d.city) {
      return [d.country_name, d.region, d.city].filter(Boolean).join(" ");
    }
  } catch (e) {
    // 网络失败或接口限流则放弃
  } finally {
    clearTimeout(timer);
  }
  return "未知";
}
