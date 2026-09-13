import { config } from "./_store.js";

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

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  let body = parseBody(req.body);

  if (body.adminPass === undefined) {
    return res.status(400).json({ error: "缺少管理口令" });
  }

  const c = await config.get();
  if (body.adminPass !== c.adminPass) {
    return res.status(403).json({ error: "管理口令不正确" });
  }

  const patch = {};
  if ("enabled" in body && typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if ("pass" in body && typeof body.pass === "string" && body.pass.length >= 4) patch.pass = body.pass;
  if ("adminPass" in body && typeof body.adminPass === "string" && body.adminPass.length >= 4) patch.adminPass = body.adminPass;
  if ("officialUrl" in body && typeof body.officialUrl === "string" &&
      (body.officialUrl.startsWith("http://") || body.officialUrl.startsWith("https://")))
    patch.officialUrl = body.officialUrl;
  if ("notice" in body && typeof body.notice === "string") patch.notice = body.notice;

  if (Object.keys(patch).length > 0) {
    const updated = await config.set(patch);
    const safe = { ...updated, pass: undefined, adminPass: undefined };
    return res.status(200).json({ ok: true, config: safe });
  }

  return res.status(200).json({ ok: true, config: { ...c, pass: undefined, adminPass: undefined } });
}
