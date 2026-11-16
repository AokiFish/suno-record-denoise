/**
 * 试听哪几侧可播（纯函数，供 Workbench 与测试共用同一条规则）。
 *
 * 规则：原声永远可播；降噪后只有 processed 存在时可播。降噪引擎加载失败
 * 时 processed 恒为 null——这时原声必须照常播，不许因为缺一边就整体堵住。
 */
export interface PlayableSides {
  orig: boolean;
  proc: boolean;
}

export function playableSides(hasProcessed: boolean): PlayableSides {
  return { orig: true, proc: hasProcessed };
}
