// 启动前检查界面是否需要重新构建：dist 不存在，或 src / shared / 配置文件比上次构建更新时自动执行 npm run build。
// start.cmd 只包含 ASCII 字符（cmd 解析 UTF-8 批处理文件有缺陷），中文提示统一由这里和服务端输出。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'index.html');

function newest(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return 0; }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = 0;
  for (const name of fs.readdirSync(target)) latest = Math.max(latest, newest(path.join(target, name)));
  return latest;
}

let built = 0;
try { built = fs.statSync(output).mtimeMs; } catch { /* 尚未构建 */ }
const sources = Math.max(...['src', 'shared', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json'].map(name => newest(path.join(root, name))));

if (built && built >= sources) process.exit(0);
console.log(built ? '检测到界面代码有更新，正在重新构建（约 10—30 秒）…' : '首次启动，正在构建界面（约 10—30 秒）…');
const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) {
  console.error('构建失败，请查看上方的错误信息。');
  process.exit(result.status || 1);
}
