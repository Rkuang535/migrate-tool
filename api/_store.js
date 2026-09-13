import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

// 使用环境变量初始化 Upstash Redis（兼容 Vercel KV 与 Upstash 两套变量名）
const getRedis = () => {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return new Redis({ url, token });
};

const CONFIG_KEY = "migration:config";
const CODE_KEY = (code) => `migration:code:${code}`;

const DEFAULT_CONFIG = {
  enabled: true,        // 总开关：false 时所有跳转/进入都关闭
  pass: "migrate2026",  // 访客口令
  adminPass: "admin2026", // 后台管理口令
  officialUrl: "https://www.runninghub.cn/wallet-migrate", // 官方目标地址
  notice: "",           // 可选的页面顶部公告
};

export const config = {
  async get() {
    try {
      const r = getRedis();
      const data = await r.get(CONFIG_KEY);
      return { ...DEFAULT_CONFIG, ...(data ? data : {}) };
    } catch (e) {
      // KV 未配置时退回默认配置（保证部署/本地容错）
      return { ...DEFAULT_CONFIG };
    }
  },
  async set(patch) {
    const r = getRedis();
    const cur = await this.get();
    const next = { ...cur, ...patch };
    await r.set(CONFIG_KEY, next);
    return next;
  },
};

// 一次性短码：写入后仅在有效期内可消费一次
export const codeStore = {
  async create(target, ttlSeconds = 600) {
    const r = getRedis();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const key = CODE_KEY(rand);
    // 直接以字符串存储并设置过期，消费时用 GETDEL 原子删除，天然一次性
    await r.set(key, target, { ex: ttlSeconds });
    return rand;
  },
  // 消费：原子读取并删除；已使用或不存在返回 null
  async consume(code) {
    const r = getRedis();
    const key = CODE_KEY(code);
    const target = await r.getdel(key);
    return target;
  },
};
