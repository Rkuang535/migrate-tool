import { config, codeStore } from "./_store.js";

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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const method = req.method;

  if (method === "GET" && req.url.startsWith("/api/status")) {
    const c = await config.get();
    return res.status(200).json({ enabled: !!c.enabled, notice: c.notice || "" });
  }

  if (method === "POST" && req.url.startsWith("/api/enter")) {
    let body = parseBody(req.body);
    const c = await config.get();
    if (!c.enabled) {
      return res.status(403).json({ error: "服务当前已停用" });
    }
    if (body.pass !== c.pass) {
      return res.status(401).json({ error: "口令不正确，请确认后重试" });
    }
    const code = await codeStore.create(c.officialUrl);
    return res.status(200).json({ ok: true, code, target: `/go/${code}` });
  }

  if (method === "GET" && req.url.startsWith("/go/")) {
    const code = req.url.split("/go/")[1]?.split(/[?#]/)[0] || "";
    const c = await config.get();
    if (!c.enabled) {
      return html(res, 200, "服务已停用", "该迁移服务当前已停用，请联系管理员。");
    }
    if (!code) return html(res, 400, "无效链接", "链接无效，请返回引导页重新获取。");
    const target = await codeStore.consume(code);
    if (!target) {
      return html(res, 200, "链接已失效", "这个链接已使用或已过期，请返回引导页重新获取。");
    }
    return res.redirect(302, target);
  }

  return res.status(404).json({ error: "Not Found" });
}

function html(res, status, title, msg) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const body = `<!doctype html><html lang=zh-CN><meta charset=utf-8><title>${title}</title>" +
    "<body style=font-family:system-ui;background:#f2f5fa;color:#22304a;display:flex;align-items:center;justify-content:center;height:100vh;margin:0>" +
    "<div style=text-align:center;padding:30px;background:#fff;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.08)>" +
    "<h2 style=margin:0 0 8px>${title}</h2><p style=margin:0;color:#6b7280>${msg}</p></div></body></html>`;
  return res.status(status).send(body);
}
