/** 技能白名单的作用域:与当前场景无关的技能不该收窄工具面。
 *  这条曾经真的挂过 —— 一个只声明 chat 工具的写作技能,把 coding 场景的工具全掐没了。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillToolAllowList, loadSkills, resetSkillCache } from '../src/skills.js';

test('内置写作技能:约束 chat 场景,但不碰 coding 场景', async () => {
  resetSkillCache();
  const chatPool = ['web_search', 'write_document', 'ask_user'];
  const codingPool = ['read_file', 'write_file', 'edit_file', 'bash', 'delegate'];

  const inChat = await skillToolAllowList(chatPool);
  assert.ok(inChat, 'chat 场景下写作技能应当生效');
  assert.ok(inChat!.has('web_search'));

  const inCoding = await skillToolAllowList(codingPool);
  assert.equal(inCoding, null, '写作技能与 coding 场景无交集,不该参与收窄');
});

test('不传可用工具集时退回全局收窄(向后兼容)', async () => {
  resetSkillCache();
  const all = await skillToolAllowList();
  assert.ok(all === null || all.size > 0);
});

test('与场景无关的技能也不进提示词', async () => {
  resetSkillCache();
  assert.match(await loadSkills(['web_search', 'write_document', 'ask_user']), /报告写作/);
  assert.doesNotMatch(await loadSkills(['read_file', 'write_file', 'edit_file', 'bash']), /报告写作/);
});
