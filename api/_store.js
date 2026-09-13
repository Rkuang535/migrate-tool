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
const STAT_KEY = (day) => `migration:stat:${day}`; // 每天访问次数的 key
const VISIT_KEY = "migration:visits:v2"; // 访问明细 key（v2 用单字符串存 JSON 数组；v1 是 list 类型，与 GET 类型冲突，故弃用）
const MAX_VISITS = 100; // 明细最多保留条数，防止无限增长

// 返回当天日期字符串（Asia/IOC 格式 yyyy-mm-dd）
function todayIDC() {
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

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

// 访问统计：记录每天通过访客口令成功进入页面的人数
export const statsStore = {
  // 今日访问次数 +1（每天一个独立 key，天然按月滚动保留）
  async record() {
    const r = getRedis();
    const key = STAT_KEY(todayIDC());
    return r.incr(key); // 返回自增后的值
  },
  // 读取最近 N 天的访问记录，返回 [{day, count}]（按日期升序）
  async recent(days = 7) {
    const r = getRedis();
    const dates = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
      const local = new Date(d.getTime() + 8 * 3600 * 1000);
      dates.push(local.toISOString().slice(0, 10));
    }
    // 批量取，避免 N+1 请求
    const result = await r.mget(dates.map((day) => STAT_KEY(day)));
    return dates.map((day, idx) => ({
      day,
      count: Number(result[idx] || 0),
    }));
  },
};

// 访问明细：记录每次成功进入人的时间 / IP / 设备 / 归属地，最多保留 MAX_VISITS 条
// 用单个 string key 存整段 JSON 数组（与 config 存储同构，已验证可靠），
// 不使用 list：@upstash/redis 会自动反序列化 lrange 的元素，再 JSON.parse 会得到空数组
export const visitStore = {
  async add({ ip, device, loc }) {
    const r = getRedis();
    const now = new Date();
    const local = new Date(now.getTime() + 8 * 3600 * 1000);
    const time = local.toISOString().slice(0, 19).replace("T", " ");
    const item = { time, ip: ip || "未知", device: device || "未知", loc: loc || "未知" };
    // 读出当前数组（兼容 SDK 自动反序列化成数组、或返回原始字符串两种情况）
    let list = [];
    try {
      const cur = await r.get(VISIT_KEY);
      if (Array.isArray(cur)) list = cur;
      else if (typeof cur === "string") {
        const p = JSON.parse(cur);
        if (Array.isArray(p)) list = p;
      }
    } catch (e) { list = []; }
    // 头插法：最新记录在最前；裁掉超出条数，避免无限增长
    list.unshift(item);
    if (list.length > MAX_VISITS) list = list.slice(0, MAX_VISITS);
    // 显式存字符串，不依赖 SDK 对数组的自动序列化
    await r.set(VISIT_KEY, JSON.stringify(list));
  },
  // 读取最近的明细（第 0 条为最新）
  async recent(limit = 100) {
    const r = getRedis();
    try {
      const cur = await r.get(VISIT_KEY);
      let list = [];
      if (Array.isArray(cur)) list = cur;
      else if (typeof cur === "string") {
        const p = JSON.parse(cur);
        if (Array.isArray(p)) list = p;
      }
      return list
        .slice(0, Math.max(1, limit))
        .filter((x) => x && typeof x === "object");
    } catch (e) {
      return [];
    }
  },
};
