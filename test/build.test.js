// 組み立ての設定のテスト。
// 機種ごとの files が「除外（!〜）だけ」だと、electron-builder がフォルダ全体を足してしまい、
// 配布用の dmg や書き出したファイルまでアプリに入って数GBになる（0.9.0〜0.10.0 で起きた）。
const test = require('node:test');
const assert = require('node:assert');
const pkg = require('../package.json');

test('アプリに入れるファイルを、どの機種でも明記している', () => {
  const lists = { root: pkg.build.files, mac: pkg.build.mac.files, win: pkg.build.win.files };
  for (const [name, list] of Object.entries(lists)) {
    if (!list) continue;
    assert.ok(list.some((x) => !x.startsWith('!')), name + ' の files に入れる物がない（除外だけだとフォルダ全体が入る）');
    assert.ok(!list.includes('**/*'), name + ' にフォルダ全体を入れている');
    assert.ok(list.includes('app/**/*') && list.includes('main.js'), name + ' に app と main.js がない');
  }
});
