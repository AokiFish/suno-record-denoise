// 把 ffmpeg.wasm 单线程 core 三件套从已装的 @ffmpeg/core 包拷到 public/ffmpeg/。
//
// 为什么不直接入库：三件套合计 24 MB（二进制），进 Git 会撑大仓库、
// 推库易被拒；且它们与 node_modules/@ffmpeg/core/dist/ 里的文件逐字节相同
//（sha256 已核对），入库纯属重复。postinstall 时自动生成，构建（vite build）
// 再原样拷进 dist/ffmpeg/。Cloudflare Pages 的 npm install 同样会触发 postinstall，
// 所以部署端不需要任何额外配置。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', '@ffmpeg', 'core', 'dist');
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
