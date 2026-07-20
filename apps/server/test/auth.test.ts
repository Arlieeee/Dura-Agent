/** auth 单测:scrypt 哈希、旧格式升级、token 签发/过期/防篡改。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashPass, verifyPass, signToken, verifyToken } from '../src/auth.js';

test('hashPass 随机盐:同口令两次哈希不同,但都能通过校验', () => {
  const h1 = hashPass('pass1234'); const h2 = hashPass('pass1234');
  assert.notEqual(h1, h2);
  assert.equal(verifyPass('pass1234', h1), true);
  assert.equal(verifyPass('pass1234', h2), true);
});

test('错误口令不通过', () => {
  assert.equal(verifyPass('wrong', hashPass('pass1234')), false);
});

test('旧版 sha256 哈希:正确口令返回 upgrade,错误口令 false', () => {
  const legacy = createHash('sha256').update('pass1234|dura-agent-dev-secret').digest('hex');
  assert.equal(verifyPass('pass1234', legacy), 'upgrade');
  assert.equal(verifyPass('wrong', legacy), false);
});

test('token 往返:签发后可验证出 userId', () => {
  assert.equal(verifyToken(signToken('usr_abc')), 'usr_abc');
});

test('token 防篡改:改 userId / 改 exp / 改签名均无效', () => {
  const [uid, exp, sig] = signToken('usr_abc').split('.');
  assert.equal(verifyToken(`usr_evil.${exp}.${sig}`), null);
  assert.equal(verifyToken(`${uid}.${Number(exp) + 9999}.${sig}`), null);
  assert.equal(verifyToken(`${uid}.${exp}.${'0'.repeat(32)}`), null);
  assert.equal(verifyToken('garbage'), null);
  assert.equal(verifyToken(''), null);
});

test('过期 token 无效(手工构造过去的 exp)', async () => {
  const { createHmac } = await import('node:crypto');
  const exp = Math.floor(Date.now() / 1000) - 10;
  const sig = createHmac('sha256', 'dura-agent-dev-secret').update(`usr_abc|${exp}`).digest('hex').slice(0, 32);
  assert.equal(verifyToken(`usr_abc.${exp}.${sig}`), null);
});
