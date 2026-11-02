/**
 * 映射函数自测（Node）：用合成关键点跑全部穴位映射，捕获 NaN / 越界 / 返回空。
 * 运行：npm test
 */
import { POINTS, faceCtx, handCtx, bodyCtx, toArr } from '../js/data.js';

/* 合成关键点 */
function synthFace() {
  const L = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = {
    1: [0.5, 0.55], 152: [0.5, 0.9], 10: [0.5, 0.12],
    33: [0.35, 0.4], 133: [0.43, 0.4], 263: [0.65, 0.4], 362: [0.57, 0.4],
    107: [0.44, 0.3], 336: [0.56, 0.3], 105: [0.4, 0.3], 70: [0.33, 0.31],
    61: [0.42, 0.68], 291: [0.58, 0.68], 0: [0.5, 0.66], 17: [0.5, 0.76],
    94: [0.5, 0.6], 98: [0.46, 0.61], 327: [0.54, 0.61],
    234: [0.18, 0.35], 172: [0.22, 0.72], 136: [0.27, 0.8], 132: [0.2, 0.5],
  };
  for (const [i, [x, y]] of Object.entries(set)) L[i] = { x, y, z: 0 };
  return L;
}
function synthHand() {
  const L = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = {
    0: [0.5, 0.85], 1: [0.56, 0.78], 2: [0.62, 0.7], 3: [0.68, 0.6], 4: [0.74, 0.52],
    5: [0.4, 0.5], 6: [0.39, 0.34], 7: [0.38, 0.26], 8: [0.38, 0.2],
    9: [0.5, 0.48], 10: [0.5, 0.32], 11: [0.5, 0.2],
    13: [0.6, 0.5], 14: [0.61, 0.34], 15: [0.62, 0.2],
    17: [0.68, 0.55], 18: [0.7, 0.4], 19: [0.7, 0.32],
  };
  for (const [i, [x, y]] of Object.entries(set)) L[i] = { x, y, z: 0 };
  return L;
}
function synthBody() {
  const L = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.95 }));
  const set = {
    0: [0.5, 0.08], 7: [0.42, 0.06], 8: [0.58, 0.06],
    11: [0.38, 0.2], 12: [0.62, 0.2], 13: [0.36, 0.38], 14: [0.64, 0.38],
    15: [0.35, 0.55], 16: [0.65, 0.55],
    17: [0.34, 0.6], 18: [0.66, 0.6], 19: [0.36, 0.6], 20: [0.64, 0.6],
    21: [0.38, 0.6], 22: [0.62, 0.6],
    23: [0.42, 0.55], 24: [0.58, 0.55], 25: [0.43, 0.75], 26: [0.57, 0.75],
    27: [0.43, 0.95], 28: [0.57, 0.95], 31: [0.44, 1.0], 32: [0.56, 1.0],
  };
  for (const [i, [x, y]] of Object.entries(set)) L[i] = { x, y, z: 0, visibility: 0.95 };
  return L;
}

let fail = 0, checked = 0;
const okRange = (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > -0.5 && p.x < 1.5 && p.y > -0.5 && p.y < 1.5;

for (const pt of POINTS) {
  for (const reg of pt.regions) {
    const m = pt.map?.[reg];
    if (!m) { console.log(`·  ${pt.name}(${pt.code}) [${reg}] 无实时映射（仅图文）`); continue; }
    const ctx = reg === 'face' ? faceCtx(synthFace())
      : reg === 'hand' ? handCtx(synthHand(), 'Right')
      : bodyCtx(synthBody());
    const arr = toArr(m(ctx) ?? []);
    checked++;
    if (!arr.length) { console.error(`✗  ${pt.name}(${pt.code}) [${reg}] 返回空`); fail++; continue; }
    arr.forEach((p, i) => {
      if (!okRange(p)) { console.error(`✗  ${pt.name}(${pt.code}) [${reg}] 第${i + 1}个点异常:`, p); fail++; }
    });
  }
}
console.log(`\n共检查 ${checked} 组映射，${fail ? `${fail} 处失败 ✗` : '全部通过 ✓'}`);
process.exit(fail ? 1 : 0);
