// 組み立てた .app に、その場で使える署名（ad-hoc 署名）を付ける。
// Apple Silicon の Mac は、署名のないアプリや署名の壊れたアプリを起動しないため。
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin' || process.platform !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'inherit' });
};
