/** 账号鉴权:scrypt 盐化口令 + 带过期的 HMAC token(全部 node:crypto,零新依赖)。
 *  - 口令:`s2$<salt>$<scryptHex>`;旧版 sha256(pass|SECRET) 哈希在登录成功时自动升级
 *  - token:`<userId>.<expEpochSec>.<sig>`,sig = HMAC(userId|exp);过期/篡改一律无效
 *  - 生产(NODE_ENV=production)必须显式设置 AUTH_SECRET,否则拒绝启动 */
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DEFAULT_SECRET = 'my-agent-dev-secret';
const SECRET = process.env.AUTH_SECRET ?? DEFAULT_SECRET;
if (process.env.NODE_ENV === 'production' && SECRET === DEFAULT_SECRET) {
  console.error('[auth] 生产模式必须设置 AUTH_SECRET(否则任何人都能伪造 token)。启动中止。');
  process.exit(1);
}

const TOKEN_TTL_S = Number(process.env.TOKEN_TTL_HOURS ?? 24 * 7) * 3600;

/* ---------- 口令 ---------- */
export function hashPass(p: string): string {
  const salt = randomBytes(16).toString('hex');
  return `s2$${salt}$${scryptSync(p, salt, 32).toString('hex')}`;
}
const legacyHash = (p: string) => createHash('sha256').update(p + '|' + SECRET).digest('hex');

/** 校验口令。旧格式命中返回 'upgrade'(调用方应重存新哈希),新格式命中返回 true。 */
export function verifyPass(p: string, stored: string): boolean | 'upgrade' {
  if (stored.startsWith('s2$')) {
    const [, salt, hex] = stored.split('$');
    const a = scryptSync(p, salt, 32); const b = Buffer.from(hex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return legacyHash(p) === stored ? 'upgrade' : false;   // 兼容 sha256 旧账号
}

/* ---------- token ---------- */
const sig = (userId: string, exp: number) =>
  createHmac('sha256', SECRET).update(`${userId}|${exp}`).digest('hex').slice(0, 32);

export function signToken(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  return `${userId}.${exp}.${sig(userId, exp)}`;
}
export function verifyToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, s] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp)) return null;
  if (exp * 1000 < Date.now()) return null;                       // 过期
  const expect = sig(userId, exp);
  const a = Buffer.from(s); const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}
