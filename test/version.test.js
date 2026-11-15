'use strict';
// 版の番号は3か所に書いてある。ずれると「古いファイル」の警告が誤って出るので揃っているか確かめる
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

test('package.json・index.html・app.js の版が揃っている', () => {
  const v = require('../package.json').version;
  const html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'app/app.js'), 'utf8');
  assert.match(html, new RegExp('data-version="' + v.replace(/\./g, '\\.') + '">Ver\\. ' + v.replace(/\./g, '\\.') + '<'));
  assert.match(js, new RegExp("APP_VERSION = '" + v.replace(/\./g, '\\.') + "'"));
  const tags = html.match(/\?v=[\d.]+/g);
  assert.ok(tags.length >= 6 && tags.every((t) => t === '?v=' + v), tags.join(','));
});
