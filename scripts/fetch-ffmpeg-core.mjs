// 把 ffmpeg.wasm 官方单线程 core（@ffmpeg/core-st）三件套从已装的包拷到
// public/ffmpeg/。
//
// 为什么是 core-st：@ffmpeg/core@0.11.0 是多线程版，要 SharedArrayBuffer，
// 没有 COOP/COEP 跨域隔离的页面一加载就炸（v2 的真机 bug：Node 自带
// SharedArrayBuffer，所以 Node 测试全过、真机才炸）。@ffmpeg/core-st@0.11.1
// 是官方单线程版，不用 SharedArrayBuffer、不用 COOP/COEP，纯静态托管就能跑。
// core-st 的 JS 里 0 次出现 SharedArrayBuffer（多线程版有 4 次），已实地核对。
//
// 为什么不直接入库：三件套合计约 24 MB（二进制），进 Git 会撑大仓库、
// 推库易被拒；且它们与 node_modules/@ffmpeg/core-st/dist/ 里的文件逐字节相同
//（sha256 已核对），入库纯属重复。postinstall 时自动生成，构建（vite build）
// 再原样拷进 dist/ffmpeg/。Cloudflare Pages 的 npm install 同样会触发 postinstall，
// 所以部署端不需要任何额外配置。
//
// 注意：core-st 的 dist 里 ffmpeg-core.worker.js 是 0 字节占位文件（单线程版
// 不起 pthread worker），但浏览器 loader 会按 corePath 同名推导它的路径，
// 所以三个文件都要拷，缺一不可。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', '@ffmpeg', 'core-st', 'dist');
const destDir = join(root, 'public', 'ffmpeg');
const FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

mkdirSync(destDir, { recursive: true });
for (const f of FILES) {
  const src = join(srcDir, f);
  const dest = join(destDir, f);
  if (!existsSync(src)) {
    throw new Error(`fetch-ffmpeg-core: 缺少 ${src}，先跑 npm install --legacy-peer-deps`);
  }
  if (existsSync(dest) && sha256(src) === sha256(dest)) {
    console.log(`fetch-ffmpeg-core: ${f} 已是最新，跳过`);
    continue;
  }
  copyFileSync(src, dest);
  console.log(`fetch-ffmpeg-core: 已拷 ${f}`);
}
