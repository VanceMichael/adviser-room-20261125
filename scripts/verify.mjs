import { spawnSync } from 'node:child_process';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('顾问室：本地合成环境验证');
console.log('1) 语法检查；2) 合作方电子签署协议；3) 业务授权/分段/成员更换/交接测试');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = spawnSync(npm, ['run', 'build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const test = spawnSync(npm, ['test'], { stdio: 'inherit' });
if (test.status !== 0) {
  console.error('\n验证未通过：请保留上面的 TAP 输出。');
  process.exit(test.status ?? 1);
}

console.log('\n✅ 本地自动验证通过。');
console.log('手动体验：npm run dev');
console.log('业务地址：http://127.0.0.1:4318/health；签署替身：http://127.0.0.1:4317/health');
console.log('完整中文接口与 curl 流程见 docs/api.md 和 README.md。');
