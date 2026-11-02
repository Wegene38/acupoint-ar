/**
 * 寻穴 AcuPoint AR —— 穴位数据库与比例映射算法
 *
 * 原理：以 MediaPipe 关键点为"骨性锚点"，按中医骨度分寸法用比例定位穴位。
 * - face:  FaceLandmarker 468 点（面部）
 * - hand:  HandLandmarker 21 点（手/腕/前臂延伸）
 * - body:  PoseLandmarker 33 点（躯干/四肢，肩→肘9寸 肘→腕12寸 膝→踝16寸 等）
 *
 * 所有坐标为画面归一化坐标 (0~1)。映射仅估算"约位置"，需结合酸胀感确认。
 */

/* ---------------- 数学工具 ---------------- */
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (v, s) => ({ x: v.x * s, y: v.y * s });
export const len = (v) => Math.hypot(v.x, v.y);
export const unit = (v) => { const l = len(v) || 1e-6; return { x: v.x / l, y: v.y / l }; };
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const perp = (v) => ({ x: -v.y, y: v.x });
/** 关于直线 A->B 的镜像反射（用于面部左右对称） */
export function reflect(p, A, B) {
  const ab = sub(B, A), ap = sub(p, A);
  const ab2 = ab.x * ab.x + ab.y * ab.y || 1e-9;
  const t = (ap.x * ab.x + ap.y * ab.y) / ab2;
  const proj = { x: A.x + ab.x * t, y: A.y + ab.y * t };
  return { x: 2 * proj.x - p.x, y: 2 * proj.y - p.y };
}
export const toArr = (r) => (r == null ? [] : Array.isArray(r) ? r : [r]);

/* ---------------- 常量 ---------------- */
export const REGIONS = {
  face: { name: '面部', icon: '🙂', hint: '将面部置于取景框内，光线充足效果更佳' },
  hand: { name: '手部', icon: '✋', hint: '将手掌或手背置于镜头前，五指自然张开' },
  body: { name: '全身', icon: '🧍', hint: '后退一步，让上半身或全身完整入镜' },
};

export const MERIDIANS = {
  LU: { name: '手太阴肺经', color: '#f5c542' },
  LI: { name: '手阳明大肠经', color: '#ff8c42' },
  ST: { name: '足阳明胃经', color: '#5b9bff' },
  SP: { name: '足太阴脾经', color: '#a3d977' },
  HT: { name: '手少阴心经', color: '#ff5d73' },
  SI: { name: '手太阳小肠经', color: '#ff8fb1' },
  BL: { name: '足太阳膀胱经', color: '#6f7bff' },
  KI: { name: '足少阴肾经', color: '#38c6ff' },
  PC: { name: '手厥阴心包经', color: '#b78bff' },
  TE: { name: '手少阳三焦经', color: '#2dd4bf' },
  GB: { name: '足少阳胆经', color: '#4ade80' },
  LR: { name: '足厥阴肝经', color: '#22a06b' },
  CV: { name: '任脉', color: '#ff7ac8' },
  GV: { name: '督脉', color: '#c4a6ff' },
  EX: { name: '经外奇穴', color: '#9aa5b1' },
};

/* ---------------- 上下文构建（每帧一次） ---------------- */

/** 面部上下文：以鼻尖→下颌为正中线，可镜像生成左右对称穴 */
export function faceCtx(L) {
  const browMid = mid(L[107], L[336]);
  const mouthMid = mid(L[61], L[291]);
  const noseB = L[94] ?? L[2];
  return {
    L, browMid,
    noseB,
    up: unit(sub(browMid, mouthMid)),
    down: unit(sub(mouthMid, mid(L[33], L[263]))),
    faceLen: dist(L[10], L[152]),
    eyeW: dist(L[33], L[133]),
    mouthW: dist(L[61], L[291]),
    alarW: dist(L[98], L[327]),
    sideR: unit(sub(L[33], noseB)),          // 朝"一侧脸颊"的水平方向
    R: (p) => reflect(p, L[1], L[152]),      // 镜像到对侧
  };
}

/** 判断手掌是否朝向镜头（依据拇指/小指在画面中的相对位置与左右手信息） */
export function palmFacing(L, label) {
  const w = dist(L[17], L[2]) || 1e-6;
  const conf = Math.abs(L[17].x - L[2].x) / w;
  const isAnatRight = label === 'Left'; // MediaPipe 以镜像输入为前提，原始前摄画面下左右互换
  const palm = isAnatRight ? L[17].x - L[2].x < 0 : L[17].x - L[2].x > 0;
  return { palm, conf };
}

/** 手部上下文（每只手一个） */
export function handCtx(L, label) {
  const { palm, conf } = palmFacing(L, label ?? 'Right');
  return { L, label: label ?? 'Right', palm, conf, handLen: dist(L[0], L[9]) };
}

/** 全身上下文：骨度分寸基准（肩→肘9寸 肘→腕12寸 髋→膝18寸 膝→踝16寸） */
export function bodyCtx(L) {
  const shMid = mid(L[11], L[12]);
  const hpMid = mid(L[23], L[24]);
  const torsoLen = dist(shMid, hpMid);
  const navel = lerp(shMid, hpMid, 0.66);   // 脐（估）
  const xiphoid = lerp(shMid, hpMid, 0.40); // 剑突（估）
  const earMid = mid(L[7], L[8]);
  const neckMid = (L[7]?.visibility ?? 0) > 0.5
    ? lerp(earMid, shMid, 0.25)
    : add(shMid, mul(unit(sub(shMid, hpMid)), torsoLen * 0.22));
  return {
    L, shMid, hpMid, torsoLen, navel, xiphoid, neckMid,
    cun2: dist(L[11], L[12]) * 0.13,         // "2寸"横向参考（肩宽比例）
    sides: [
      { sh: L[11], el: L[13], wr: L[15], pk: L[17], ix: L[19], th: L[21], hp: L[23], kn: L[25], an: L[27], ft: L[31] },
      { sh: L[12], el: L[14], wr: L[16], pk: L[18], ix: L[20], th: L[22], hp: L[24], kn: L[26], an: L[28], ft: L[32] },
    ],
    vis: (i) => L[i]?.visibility ?? 0,
  };
}

/** 肢体"外侧"方向：垂直于肢体轴线、背离躯干中线的一侧 */
function limbOut(s, prox, dist0, midRef) {
  const t = unit(sub(dist0, prox));
  const n = perp(t);
  return (n.x * (dist0.x - midRef.x) + n.y * (dist0.y - midRef.y) > 0) ? n : { x: -n.x, y: -n.y };
}
const armOut = (c, s) => limbOut(s, s.el, s.wr, c.shMid);
const legOut = (c, s) => limbOut(s, s.kn, s.an, c.hpMid);

/* ---------------- 穴位数据 ---------------- */
export const POINTS = [

  /* ============ 面部 ============ */
  {
    id: 'gv20', code: 'GV20', name: '百会', pinyin: 'Bǎi Huì', meridian: 'GV', regions: ['face'], key: true,
    location: '头顶正中，两耳尖连线与头正中线的交点处。',
    effects: '提神醒脑、升阳举陷。常用于头晕、失眠健忘、精神不振。',
    tips: '以指腹轻揉 1~2 分钟，微热为度。',
    map: { face: (c) => add(c.L[10], mul(c.up, c.faceLen * 0.32)) },
  },
  {
    id: 'gv24', code: 'GV24', name: '神庭', pinyin: 'Shén Tíng', meridian: 'GV', regions: ['face'],
    location: '前发际正中直上 0.5 寸。',
    effects: '安神宁心。常用于失眠、头晕、鼻塞。',
    tips: '睡前轻按 30 秒，有助放松。',
    map: { face: (c) => lerp(c.browMid, c.L[10], 0.42) },
  },
  {
    id: 'ex-hn3', code: 'EX-HN3', name: '印堂', pinyin: 'Yìn Táng', meridian: 'EX', regions: ['face'], key: true,
    location: '两眉头连线的中点。',
    effects: '宁心安神、明目通鼻。常用于失眠、头痛、鼻塞、眉棱骨痛。',
    tips: '用中指按揉 1 分钟，睡前按可助眠。',
    map: { face: (c) => c.browMid },
  },
  {
    id: 'bl2', code: 'BL2', name: '攒竹', pinyin: 'Cuán Zhú', meridian: 'BL', regions: ['face'],
    location: '眉头凹陷中，眶上切迹处。',
    effects: '明目利窍。常用于眼疲劳、头痛、眉棱骨痛。',
    tips: '眼酸胀时轻按 30 秒。',
    map: { face: (c) => { const p = add(lerp(c.L[107], c.L[105], 0.1), mul(c.up, c.faceLen * 0.02)); return [p, c.R(p)]; } },
  },
  {
    id: 'ex-hn4', code: 'EX-HN4', name: '鱼腰', pinyin: 'Yú Yāo', meridian: 'EX', regions: ['face'],
    location: '瞳孔直上，眉毛正中。',
    effects: '明目消肿。常用于眼睑跳动、眼疲劳。',
    tips: '轻揉即可，勿用力按压眼球上方。',
    map: { face: (c) => [c.L[105], c.R(c.L[105])] },
  },
  {
    id: 'te23', code: 'TE23', name: '丝竹空', pinyin: 'Sī Zhú Kōng', meridian: 'TE', regions: ['face'],
    location: '眉梢外侧凹陷处。',
    effects: '明目止痛。常用于头痛、眼病、面瘫。',
    tips: '由内向外轻推眉梢，缓解眼疲劳。',
    map: { face: (c) => [c.L[70], c.R(c.L[70])] },
  },
  {
    id: 'ex-hn5', code: 'EX-HN5', name: '太阳', pinyin: 'Tài Yáng', meridian: 'EX', regions: ['face'], key: true,
    location: '眉梢与外眼角之间向后约一横指的凹陷处。',
    effects: '清肝明目、止痛。常用于头痛、偏头痛、眼疲劳。',
    tips: '双手拇指或中指画圈按揉 1~2 分钟。',
    map: { face: (c) => { const p = lerp(mid(c.L[70], c.L[33]), c.L[234], 0.22); return [p, c.R(p)]; } },
  },
  {
    id: 'bl1', code: 'BL1', name: '睛明', pinyin: 'Jīng Míng', meridian: 'BL', regions: ['face'],
    location: '目内眦（内眼角）内上方凹陷处。',
    effects: '明目。常用于视力疲劳、近视、迎风流泪。',
    tips: '力度务必轻柔，避免压迫眼球。',
    map: { face: (c) => { const p = lerp(c.L[133], c.L[107], 0.28); return [p, c.R(p)]; } },
  },
  {
    id: 'st2', code: 'ST2', name: '四白', pinyin: 'Sì Bái', meridian: 'ST', regions: ['face'],
    location: '瞳孔直下约 1 寸，眶下孔凹陷处。',
    effects: '祛风明目。常用于面瘫、眼疲劳、面部色斑。',
    tips: '按至微酸，可配合眼保健操。',
    map: { face: (c) => { const p = add(mid(c.L[33], c.L[133]), mul(c.down, c.eyeW * 0.62)); return [p, c.R(p)]; } },
  },
  {
    id: 'li20', code: 'LI20', name: '迎香', pinyin: 'Yíng Xiāng', meridian: 'LI', regions: ['face'], key: true,
    location: '鼻翼外缘中点旁开，鼻唇沟中。',
    effects: '通鼻窍、散风热。常用于鼻塞、鼻炎、面痒。',
    tips: '感冒鼻塞时上下搓按 1 分钟。',
    map: { face: (c) => { const p = add(add(c.noseB, mul(c.sideR, c.alarW * 0.52)), mul(c.down, c.faceLen * 0.02)); return [p, c.R(p)]; } },
  },
  {
    id: 'gv26', code: 'GV26', name: '人中', pinyin: 'Rén Zhōng', meridian: 'GV', regions: ['face'], key: true,
    location: '人中沟上 1/3 与下 2/3 交点处。',
    effects: '醒脑开窍。常用于昏迷急救、急性腰扭伤。',
    tips: '急救时以指甲掐按，平时不宜多按。',
    map: { face: (c) => mid(c.noseB, c.L[0]) },
  },
  {
    id: 'st4', code: 'ST4', name: '地仓', pinyin: 'Dì Cāng', meridian: 'ST', regions: ['face'],
    location: '口角旁约 0.4 寸，上直对瞳孔。',
    effects: '祛风通络。常用于面瘫、流涎、牙痛。',
    tips: '沿口角向外轻推。',
    map: { face: (c) => { const p = add(c.L[61], mul(c.sideR, c.mouthW * 0.2)); return [p, c.R(p)]; } },
  },
  {
    id: 'cv24', code: 'CV24', name: '承浆', pinyin: 'Chéng Jiāng', meridian: 'CV', regions: ['face'], key: true,
    location: '下唇下方，颏唇沟正中凹陷处。',
    effects: '生津敛液。常用于面瘫、牙痛、口腔溃疡。',
    tips: '轻按 30 秒。',
    map: { face: (c) => mid(c.L[17], c.L[152]) },
  },
  {
    id: 'st6', code: 'ST6', name: '颊车', pinyin: 'Jiá Chē', meridian: 'ST', regions: ['face'],
    location: '下颌角前上方约一横指，咀嚼时咬肌隆起处。',
    effects: '祛风通络、止痛。常用于牙痛、面瘫、腮腺炎。',
    tips: '牙痛时重力按揉 1 分钟。',
    map: { face: (c) => { const p = mid(c.L[172], c.L[136]); return [p, c.R(p)]; } },
  },
  {
    id: 'si19', code: 'SI19', name: '听宫', pinyin: 'Tīng Gōng', meridian: 'SI', regions: ['face'],
    location: '耳屏正前方，下颌骨髁状突后缘凹陷处（张口呈凹陷）。',
    effects: '聪耳开窍。常用于耳鸣、耳聋、牙痛。',
    tips: '张口取穴，轻揉 30 秒。',
    map: { face: (c) => [c.L[132], c.R(c.L[132])] },
  },
  {
    id: 'gb20', code: 'GB20', name: '风池', pinyin: 'Fēng Chí', meridian: 'GB', regions: ['face'],
    location: '后颈部枕骨下方，胸锁乳突肌与斜方肌上端之间的凹陷中。',
    effects: '疏风解表、醒脑明目。常用于头痛眩晕、颈椎僵硬、眼疲劳。',
    tips: '位于后脑，正面无法实时标注——请双手抱头，拇指置于枕下凹陷处按压。',
    map: null,
  },
  {
    id: 'ex-anmian', code: 'EX-HN', name: '安眠', pinyin: 'Ān Mián', meridian: 'EX', regions: ['face'],
    location: '耳垂后方凹陷（翳风）与风池连线的中点。',
    effects: '安神助眠。常用于失眠、眩晕、头痛。',
    tips: '位于耳后，请以拇指按揉 1~2 分钟助眠。',
    map: null,
  },

  /* ============ 手部 ============ */
  {
    id: 'li4', code: 'LI4', name: '合谷', pinyin: 'Hé Gǔ', meridian: 'LI', regions: ['hand', 'body'], surface: 'dorsal', key: true,
    location: '手背第 1、2 掌骨之间，第 2 掌骨桡侧的中点处（虎口）。',
    effects: '疏风解表、行气止痛。"头面合谷收"，常用于头痛、牙痛、感冒、面部疾患。',
    tips: '另一手拇指按压，酸胀为度，每次 1~3 分钟。⚠️ 孕妇慎按。',
    map: {
      hand: (c) => lerp(mid(c.L[2], c.L[5]), mid(c.L[5], c.L[0]), 0.5),
      body: (c) => c.sides.map((s) => lerp(mid(s.th, s.ix), s.wr, 0.25)),
    },
  },
  {
    id: 'pc8', code: 'PC8', name: '劳宫', pinyin: 'Láo Gōng', meridian: 'PC', regions: ['hand'], surface: 'palm', key: true,
    location: '掌心横纹中，第 2、3 掌骨之间；握拳屈指时中指尖所指处。',
    effects: '清心安神。常用于失眠心烦、口臭、手心发热。',
    tips: '对搓双手至发热后按压，安神助眠。',
    map: { hand: (c) => lerp(c.L[9], c.L[0], 0.48) },
  },
  {
    id: 'pc6', code: 'PC6', name: '内关', pinyin: 'Nèi Guān', meridian: 'PC', regions: ['hand', 'body'], surface: 'palm', key: true,
    location: '前臂掌侧，腕横纹上 2 寸，两筋（掌长肌腱与桡侧腕屈肌腱）之间。',
    effects: '宁心安神、和胃止呕。常用于心悸、失眠、恶心呕吐、晕车。',
    tips: '晕车恶心时重力按揉 2 分钟。⚠️ 孕妇慎重按。',
    map: {
      hand: (c) => add(c.L[0], mul(unit(sub(c.L[0], mid(c.L[5], c.L[17]))), c.handLen * 0.38)),
      body: (c) => c.sides.map((s, i) => (c.vis(i ? 16 : 15) > 0.3 ? lerp(s.wr, s.el, 2 / 12) : null)).filter(Boolean),
    },
  },
  {
    id: 'ht7', code: 'HT7', name: '神门', pinyin: 'Shén Mén', meridian: 'HT', regions: ['hand', 'body'], surface: 'palm', key: true,
    location: '腕掌侧横纹尺侧端，尺侧腕屈肌腱桡侧凹陷处。',
    effects: '养心安神。常用于失眠、健忘、心悸、焦虑。',
    tips: '睡前轻按 1 分钟，助眠名穴。',
    map: {
      hand: (c) => lerp(c.L[0], c.L[17], 0.35),
      body: (c) => c.sides.map((s) => lerp(s.wr, s.pk, 0.28)),
    },
  },
  {
    id: 'lu9', code: 'LU9', name: '太渊', pinyin: 'Tài Yuān', meridian: 'LU', regions: ['hand', 'body'], surface: 'palm',
    location: '腕掌侧横纹桡侧端，桡动脉搏动处。',
    effects: '补肺益气、止咳化痰。常用于咳嗽、气喘、咽痛。',
    tips: '轻按即可，避开明显动脉搏动处。',
    map: {
      hand: (c) => lerp(c.L[0], c.L[2], 0.38),
      body: (c) => c.sides.map((s) => lerp(s.wr, s.th, 0.25)),
    },
  },
  {
    id: 'pc7', code: 'PC7', name: '大陵', pinyin: 'Dà Líng', meridian: 'PC', regions: ['hand', 'body'], surface: 'palm',
    location: '腕掌侧横纹正中，两筋之间。',
    effects: '宁心安神、清胃火。常用于心痛、失眠、口臭。',
    tips: '按揉 30 秒至 1 分钟。',
    map: {
      hand: (c) => lerp(c.L[0], c.L[9], 0.16),
      body: (c) => c.sides.map((s) => s.wr),
    },
  },
  {
    id: 'lu10', code: 'LU10', name: '鱼际', pinyin: 'Yú Jì', meridian: 'LU', regions: ['hand'], surface: 'palm',
    location: '第 1 掌骨桡侧中点，赤白肉际处（大鱼际肌中部）。',
    effects: '清肺热、利咽喉。常用于咽喉肿痛、咳嗽、发热。',
    tips: '双手鱼际对搓 1 分钟至发热。',
    map: { hand: (c) => lerp(mid(c.L[0], c.L[2]), mid(c.L[2], c.L[4]), 0.4) },
  },
  {
    id: 'ex-ue10', code: 'EX-UE10', name: '四缝', pinyin: 'Sì Fèng', meridian: 'EX', regions: ['hand'], surface: 'palm',
    location: '第 2~5 指掌面，近侧指间关节横纹的中点处。',
    effects: '消食导滞、祛痰化积。常用于小儿疳积、消化不良。',
    tips: '小儿捏脊配合，轻揉即可。',
    map: { hand: (c) => [c.L[6], c.L[10], c.L[14], c.L[18]] },
  },
  {
    id: 'lu11', code: 'LU11', name: '少商', pinyin: 'Shào Shāng', meridian: 'LU', regions: ['hand'], surface: 'both', key: true,
    location: '拇指末节桡侧，指甲根角旁 0.1 寸。',
    effects: '清肺利咽、醒脑开窍。常用于咽喉肿痛、发热、急救。',
    tips: '咽痛时掐按出血数滴为传统用法，日常轻掐即可。',
    map: { hand: (c) => c.L[4] },
  },
  {
    id: 'li1', code: 'LI1', name: '商阳', pinyin: 'Shāng Yáng', meridian: 'LI', regions: ['hand'], surface: 'both',
    location: '食指末节桡侧，指甲根角旁 0.1 寸。',
    effects: '泻热开窍。常用于咽喉肿痛、牙痛、手指麻木。',
    tips: '轻掐 10 秒，可反复。',
    map: { hand: (c) => add(c.L[8], mul(unit(sub(c.L[4], c.L[8])), dist(c.L[8], c.L[5]) * 0.25)) },
  },
  {
    id: 'pc9', code: 'PC9', name: '中冲', pinyin: 'Zhōng Chōng', meridian: 'PC', regions: ['hand'], surface: 'both',
    location: '中指末端最高点（中央）。',
    effects: '醒神开窍、清心泻热。常用于中暑、心痛、昏迷。',
    tips: '急症时掐按，日常轻揉。',
    map: { hand: (c) => c.L[11] },
  },
  {
    id: 'te1', code: 'TE1', name: '关冲', pinyin: 'Guān Chōng', meridian: 'TE', regions: ['hand'], surface: 'both',
    location: '无名指末节尺侧，指甲根角旁 0.1 寸。',
    effects: '泻热开窍。常用于头痛、目赤、咽喉肿痛。',
    tips: '轻掐 10 秒。',
    map: { hand: (c) => add(c.L[15], mul(unit(sub(c.L[19], c.L[15])), dist(c.L[15], c.L[14]) * 0.3)) },
  },
  {
    id: 'ht9', code: 'HT9', name: '少冲', pinyin: 'Shào Chōng', meridian: 'HT', regions: ['hand'], surface: 'both',
    location: '小指末节桡侧，指甲根角旁 0.1 寸。',
    effects: '宁心安神。常用于心悸、心痛、昏迷。',
    tips: '轻掐 10 秒。',
    map: { hand: (c) => add(c.L[19], mul(unit(sub(c.L[11], c.L[19])), dist(c.L[19], c.L[18]) * 0.3)) },
  },
  {
    id: 'si1', code: 'SI1', name: '少泽', pinyin: 'Shào Zé', meridian: 'SI', regions: ['hand'], surface: 'both',
    location: '小指末节尺侧，指甲根角旁 0.1 寸。',
    effects: '通乳开窍、清热。常用于产后乳少、热病、昏迷。',
    tips: '轻掐 10 秒。',
    map: { hand: (c) => add(c.L[19], mul(unit(sub(c.L[15], c.L[19])), dist(c.L[19], c.L[18]) * 0.3)) },
  },
  {
    id: 'si3', code: 'SI3', name: '后溪', pinyin: 'Hòu Xī', meridian: 'SI', regions: ['hand'], surface: 'dorsal', key: true,
    location: '手内侧，第 5 掌指关节尺侧近端赤白肉际凹陷处（握拳时掌横纹尺侧端）。',
    effects: '舒经活络、清心安神。常用于颈肩僵硬、腰痛、盗汗。',
    tips: '低头族按此穴 + 活动颈部，每次 1~2 分钟。',
    map: { hand: (c) => add(lerp(c.L[17], c.L[0], 0.18), mul(unit(sub(c.L[17], c.L[13])), dist(c.L[17], c.L[13]) * 0.22)) },
  },
  {
    id: 'li3', code: 'LI3', name: '三间', pinyin: 'Sān Jiān', meridian: 'LI', regions: ['hand'], surface: 'dorsal',
    location: '第 2 掌指关节桡侧近端凹陷处。',
    effects: '泻热止痛。常用于牙痛、咽喉肿痛、腹胀。',
    tips: '轻按 30 秒。',
    map: { hand: (c) => add(lerp(c.L[5], c.L[0], 0.28), mul(unit(sub(c.L[2], c.L[5])), dist(c.L[5], c.L[17]) * 0.18)) },
  },
  {
    id: 'li2', code: 'LI2', name: '二间', pinyin: 'Èr Jiān', meridian: 'LI', regions: ['hand'], surface: 'dorsal',
    location: '第 2 掌指关节桡侧远端凹陷处。',
    effects: '清热消肿。常用于牙痛、鼻衄、目痛。',
    tips: '轻按 30 秒。',
    map: { hand: (c) => add(lerp(c.L[5], c.L[6], 0.45), mul(unit(sub(c.L[2], c.L[5])), dist(c.L[5], c.L[6]) * 0.3)) },
  },
  {
    id: 'li5', code: 'LI5', name: '阳溪', pinyin: 'Yáng Xī', meridian: 'LI', regions: ['hand'], surface: 'dorsal',
    location: '腕背横纹桡侧，拇指上翘时"鼻烟窝"凹陷中。',
    effects: '清热散风。常用于手腕痛（腱鞘炎）、头痛、耳鸣。',
    tips: '鼠标手可常按。',
    map: { hand: (c) => lerp(c.L[0], c.L[2], 0.42) },
  },
  {
    id: 'te4', code: 'TE4', name: '阳池', pinyin: 'Yáng Chí', meridian: 'TE', regions: ['hand'], surface: 'dorsal',
    location: '腕背横纹中，指伸肌腱尺侧缘凹陷中。',
    effects: '清热通络、通调三焦。常用于手腕痛、手足冷。',
    tips: '手脚冰凉者常按。',
    map: { hand: (c) => lerp(c.L[0], c.L[9], 0.2) },
  },
  {
    id: 'si5', code: 'SI5', name: '阳谷', pinyin: 'Yáng Gǔ', meridian: 'SI', regions: ['hand'], surface: 'dorsal',
    location: '腕背横纹尺侧端，尺骨茎突与三角骨之间凹陷中。',
    effects: '清热安神。常用于手腕痛、颈颔肿、耳鸣。',
    tips: '轻按 30 秒。',
    map: { hand: (c) => lerp(c.L[0], c.L[17], 0.38) },
  },
  {
    id: 'si4', code: 'SI4', name: '腕骨', pinyin: 'Wàn Gǔ', meridian: 'SI', regions: ['hand'], surface: 'dorsal',
    location: '手背尺侧，第 5 掌骨基底与钩骨之间赤白肉际凹陷中。',
    effects: '祛湿退黄。常用于腕痛指挛、黄疸、消渴。',
    tips: '轻按 30 秒。',
    map: { hand: (c) => lerp(c.L[17], c.L[0], 0.38) },
  },
  {
    id: 'te5', code: 'TE5', name: '外关', pinyin: 'Wài Guān', meridian: 'TE', regions: ['hand', 'body'], surface: 'dorsal', key: true,
    location: '前臂背侧，腕背横纹上 2 寸，尺骨与桡骨之间（与内关相对）。',
    effects: '疏风清热、通经活络。常用于热病、偏头痛、耳鸣、肩颈痛。',
    tips: '按揉 1~2 分钟，微酸为度。',
    map: {
      hand: (c) => add(add(c.L[0], mul(unit(sub(c.L[0], mid(c.L[5], c.L[17]))), c.handLen * 0.38)), mul(unit(sub(c.L[17], c.L[5])), c.handLen * 0.12)),
      body: (c) => c.sides.map((s) => { const fa = dist(s.wr, s.el); return add(lerp(s.wr, s.el, 2 / 12), mul(armOut(c, s), (fa * 0.5) / 12)); }),
    },
  },

  /* ============ 全身 ============ */
  {
    id: 'gb21', code: 'GB21', name: '肩井', pinyin: 'Jiān Jǐng', meridian: 'GB', regions: ['body'], key: true,
    location: '肩胛区，第 7 颈椎棘突与肩峰最外侧点连线的中点。',
    effects: '通络止痛、升提气血。常用于肩背酸痛、颈项强痛。',
    tips: '拿捏 1~2 分钟。⚠️ 孕妇禁按。',
    map: { body: (c) => c.sides.map((s) => mid(c.neckMid, s.sh)) },
  },
  {
    id: 'li15', code: 'LI15', name: '肩髃', pinyin: 'Jiān Yú', meridian: 'LI', regions: ['body'],
    location: '肩峰前下方凹陷处，手臂外展时凹陷明显。',
    effects: '通经活络。常用于肩痛、上肢不遂。',
    tips: '外展手臂找准凹陷后按揉。',
    map: { body: (c) => c.sides.map((s) => add(lerp(s.sh, s.el, 0.15), mul(unit(sub(s.sh, c.shMid)), dist(s.sh, s.el) * (0.6 / 9)))) },
  },
  {
    id: 'li11', code: 'LI11', name: '曲池', pinyin: 'Qū Chí', meridian: 'LI', regions: ['body'], key: true,
    location: '肘横纹外侧端，屈肘时尺泽与肱骨外上髁连线中点。',
    effects: '清热解表、通经活络。常用于肘臂痛、高血压、发热、湿疹。',
    tips: '屈肘取穴，按揉 1~2 分钟。',
    map: { body: (c) => c.sides.map((s) => { const fa = dist(s.wr, s.el); return add(lerp(s.el, s.wr, 0.06), mul(armOut(c, s), (fa * 0.6) / 12)); }) },
  },
  {
    id: 'li10', code: 'LI10', name: '手三里', pinyin: 'Shǒu Sān Lǐ', meridian: 'LI', regions: ['body'],
    location: '前臂背面桡侧，肘横纹下 2 寸。',
    effects: '通经活络、调理肠胃。常用于肘臂麻木、腹胀、腹泻。',
    tips: '按揉 1 分钟。',
    map: { body: (c) => c.sides.map((s) => { const fa = dist(s.wr, s.el); return add(lerp(s.el, s.wr, 2 / 12), mul(armOut(c, s), (fa * 0.4) / 12)); }) },
  },
  {
    id: 'lu7', code: 'LU7', name: '列缺', pinyin: 'Liè Quē', meridian: 'LU', regions: ['body'],
    location: '前臂桡侧，腕横纹上 1.5 寸，桡骨茎突上方（两手虎口交叉食指尖所至）。',
    effects: '宣肺利气。"头项寻列缺"，常用于颈项强痛、咳嗽、偏头痛。',
    tips: '虎口交叉取穴更准。',
    map: { body: (c) => c.sides.map((s) => { const fa = dist(s.wr, s.el); return add(lerp(s.wr, s.el, 1.5 / 12), mul(unit(sub(s.th, s.wr)), (fa * 0.8) / 12)); }) },
  },
  {
    id: 'cv12', code: 'CV12', name: '中脘', pinyin: 'Zhōng Wǎn', meridian: 'CV', regions: ['body'], key: true,
    location: '上腹部前正中线上，脐中上 4 寸。',
    effects: '健脾和胃、消食导滞。常用于胃痛、腹胀、消化不良。',
    tips: '掌摩 3~5 分钟，饭后 1 小时内不宜重按。',
    map: { body: (c) => lerp(c.navel, c.xiphoid, 0.5) },
  },
  {
    id: 'cv8', code: 'CV8', name: '神阙', pinyin: 'Shén Què', meridian: 'CV', regions: ['body'], key: true,
    location: '脐窝正中。',
    effects: '温阳救逆、健运脾胃。常用于腹痛、腹泻、虚寒体质。',
    tips: '宜掌摩或艾灸，禁针刺。',
    map: { body: (c) => c.navel },
  },
  {
    id: 'cv6', code: 'CV6', name: '气海', pinyin: 'Qì Hǎi', meridian: 'CV', regions: ['body'],
    location: '下腹部前正中线上，脐中下 1.5 寸。',
    effects: '益气补肾。常用于虚劳乏力、腹痛、月经不调。',
    tips: '掌摩 2~3 分钟。',
    map: { body: (c) => lerp(c.navel, c.hpMid, 0.3) },
  },
  {
    id: 'cv4', code: 'CV4', name: '关元', pinyin: 'Guān Yuán', meridian: 'CV', regions: ['body'], key: true,
    location: '下腹部前正中线上，脐中下 3 寸。',
    effects: '培元固本、温补下焦。常用于虚寒腹痛、遗尿、月经不调。',
    tips: '⚠️ 孕妇慎按。睡前掌摩 2 分钟。',
    map: { body: (c) => lerp(c.navel, c.hpMid, 0.6) },
  },
  {
    id: 'st25', code: 'ST25', name: '天枢', pinyin: 'Tiān Shū', meridian: 'ST', regions: ['body'],
    location: '腹中部，脐中旁开 2 寸。',
    effects: '调理肠腑、通便止泻（双向调节）。常用于便秘、腹泻、腹痛。',
    tips: '便秘时顺时针摩腹配合按压。',
    map: { body: (c) => c.sides.map((s) => add(c.navel, mul(unit(sub(s.hp, c.hpMid)), c.cun2))) },
  },
  {
    id: 'sp10', code: 'SP10', name: '血海', pinyin: 'Xuè Hǎi', meridian: 'SP', regions: ['body'],
    location: '股前区，髌底内侧端上 2 寸（大腿内侧隆起肌肉顶端）。',
    effects: '活血调经、祛风止痒。常用于月经不调、皮肤瘙痒、膝痛。',
    tips: '按揉 1~2 分钟。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => { const leg = dist(s.kn, s.an); const up = unit(sub(s.hp, s.kn)); return add(add(s.kn, mul(up, (leg * 2) / 16)), mul(mul(legOut(c, s), -1), (leg * 0.5) / 16)); }) },
  },
  {
    id: 'st34', code: 'ST34', name: '梁丘', pinyin: 'Liáng Qiū', meridian: 'ST', regions: ['body'],
    location: '股前区，髌底外侧端上 2 寸。',
    effects: '理气和胃、通络。常用于急性胃痛、膝肿痛。',
    tips: '急性胃痛时可重力按压。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => { const leg = dist(s.kn, s.an); const up = unit(sub(s.hp, s.kn)); return add(add(s.kn, mul(up, (leg * 2) / 16)), mul(legOut(c, s), (leg * 0.5) / 16)); }) },
  },
  {
    id: 'st36', code: 'ST36', name: '足三里', pinyin: 'Zú Sān Lǐ', meridian: 'ST', regions: ['body'], key: true,
    location: '小腿外侧，犊鼻（外膝眼）下 3 寸，胫骨前嵴外一横指。',
    effects: '健脾和胃、扶正培元。"长寿第一穴"，常用于胃痛腹胀、虚劳、日常保健。',
    tips: '每天按揉 2~3 分钟，酸胀为度。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => { const leg = dist(s.kn, s.an); const down = unit(sub(s.an, s.kn)); return add(add(s.kn, mul(down, (leg * 3) / 16)), mul(legOut(c, s), (leg * 1) / 16)); }) },
  },
  {
    id: 'gb34', code: 'GB34', name: '阳陵泉', pinyin: 'Yáng Líng Quán', meridian: 'GB', regions: ['body'],
    location: '小腿外侧，腓骨头前下方凹陷中。',
    effects: '舒筋活络。"筋会阳陵泉"，常用于下肢麻木抽筋、胁痛、肩痛。',
    tips: '小腿抽筋时即刻重力按压。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => { const leg = dist(s.kn, s.an); const down = unit(sub(s.an, s.kn)); return add(add(s.kn, mul(down, (leg * 3) / 16)), mul(legOut(c, s), (leg * 1.9) / 16)); }) },
  },
  {
    id: 'st40', code: 'ST40', name: '丰隆', pinyin: 'Fēng Lóng', meridian: 'ST', regions: ['body'],
    location: '小腿外侧，外踝尖上 8 寸，胫骨前嵴外二横指。',
    effects: '化痰要穴。常用于痰多咳嗽、眩晕、高血脂。',
    tips: '痰湿体质常按。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => { const leg = dist(s.kn, s.an); return add(lerp(s.kn, s.an, 0.5), mul(legOut(c, s), (leg * 0.8) / 16)); }) },
  },
  {
    id: 'sp6', code: 'SP6', name: '三阴交', pinyin: 'Sān Yīn Jiāo', meridian: 'SP', regions: ['body'], key: true,
    location: '小腿内侧，内踝尖上 3 寸，胫骨内侧缘后际。',
    effects: '健脾益肾、调经助眠。常用于失眠、月经不调、消化不良。',
    tips: '⚠️ 孕妇禁按。睡前按揉 1 分钟。',
    map: { body: (c) => c.sides.filter((s) => c.vis(27) > 0.4).map((s) => { const leg = dist(s.kn, s.an); const up = unit(sub(s.kn, s.an)); return add(add(s.an, mul(up, (leg * 3) / 16)), mul(mul(legOut(c, s), -1), (leg * 0.6) / 16)); }) },
  },
  {
    id: 'gb39', code: 'GB39', name: '悬钟', pinyin: 'Xuán Zhōng', meridian: 'GB', regions: ['body'],
    location: '小腿外侧，外踝尖上 3 寸，腓骨前缘。',
    effects: '"髓会"，益髓壮骨。常用于颈项强痛、下肢痿痹。',
    tips: '落枕时配合活动颈部按压。',
    map: { body: (c) => c.sides.filter((s) => c.vis(27) > 0.4).map((s) => { const leg = dist(s.kn, s.an); const up = unit(sub(s.kn, s.an)); return add(add(s.an, mul(up, (leg * 3) / 16)), mul(legOut(c, s), (leg * 0.6) / 16)); }) },
  },
  {
    id: 'lr3', code: 'LR3', name: '太冲', pinyin: 'Tài Chōng', meridian: 'LR', regions: ['body'], key: true,
    location: '足背第 1、2 跖骨间，跖骨底结合部前方凹陷中。',
    effects: '疏肝理气、平肝熄风。常用于急躁易怒、头痛眩晕、高血压。',
    tips: '生气后从太冲向趾缝方向推揉 2 分钟。',
    map: { body: (c) => c.sides.filter((s) => c.vis(31) > 0.4).map((s) => lerp(s.an, s.ft, 0.7)) },
  },
  {
    id: 'gb31', code: 'GB31', name: '风市', pinyin: 'Fēng Shì', meridian: 'GB', regions: ['body'],
    location: '股外侧，直立垂手、手掌并拢伸直时中指尖所到处。',
    effects: '祛风除湿。常用于下肢痿痹、遍身瘙痒。',
    tips: '自然站立体位取穴最准。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => { const th = dist(s.hp, s.kn); return add(lerp(s.hp, s.kn, 0.45), mul(legOut(c, s), (th * 0.4) / 18)); }) },
  },
  {
    id: 'bl40', code: 'BL40', name: '委中', pinyin: 'Wěi Zhōng', meridian: 'BL', regions: ['body'], style: 'back',
    location: '膝后区，腘横纹中点。',
    effects: '"腰背委中求"，舒筋活络。常用于腰背痛、下肢痿痹。',
    tips: '位于膝盖背面，请俯卧或对照文字定位。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => lerp(s.kn, s.an, 0.05)) },
  },
  {
    id: 'bl57', code: 'BL57', name: '承山', pinyin: 'Chéng Shān', meridian: 'BL', regions: ['body'], style: 'back',
    location: '小腿后区，腓肠肌两肌腹与肌腱交角处（"人"字沟顶点）。',
    effects: '舒筋解痉。常用于小腿抽筋、痔疮、腰腿痛。',
    tips: '位于小腿后侧，踮脚时凹陷明显。',
    map: { body: (c) => c.sides.filter((s) => c.vis(25) > 0.4).map((s) => lerp(s.kn, s.an, 0.45)) },
  },
  {
    id: 'ki1', code: 'KI1', name: '涌泉', pinyin: 'Yǒng Quán', meridian: 'KI', regions: ['body'], style: 'back',
    location: '足底，足趾跖屈时凹陷处（足底前 1/3 与后 2/3 交点）。',
    effects: '滋阴降火、引火归元。常用于失眠、高血压、头晕。',
    tips: '睡前搓涌泉 100 次助眠。',
    map: { body: (c) => c.sides.filter((s) => c.vis(31) > 0.4).map((s) => lerp(s.an, s.ft, 0.55)) },
  },
  {
    id: 'gv14', code: 'GV14', name: '大椎', pinyin: 'Dà Zhuī', meridian: 'GV', regions: ['body'], style: 'back',
    location: '后正中线上，第 7 颈椎棘突下凹陷中（低头时颈后最突出骨下方）。',
    effects: '解表退热、升阳。常用于感冒发热、颈项强直。',
    tips: '低头摸到最突出颈椎骨，其下凹陷即是。',
    map: { body: (c) => lerp(c.neckMid, c.shMid, 0.55) },
  },
  {
    id: 'gv5', code: 'GV5', name: '命门', pinyin: 'Mìng Mén', meridian: 'GV', regions: ['body'], style: 'back',
    location: '腰部后正中线上，第 2 腰椎棘突下（约与肚脐相对）。',
    effects: '温肾壮阳。常用于腰痛、畏寒、精力不足。',
    tips: '搓热手掌捂按腰部。',
    map: { body: (c) => c.navel },
  },
  {
    id: 'bl23', code: 'BL23', name: '肾俞', pinyin: 'Shèn Shū', meridian: 'BL', regions: ['body'], style: 'back',
    location: '腰部，第 2 腰椎棘突下旁开 1.5 寸（约与肚脐同高，脊柱旁二横指）。',
    effects: '益肾气、强腰脊。常用于腰酸、耳鸣、疲乏。',
    tips: '双手搓热后上下擦腰 2 分钟。',
    map: { body: (c) => c.sides.map((s) => add(c.navel, mul(unit(sub(s.hp, c.hpMid)), c.cun2 * 0.75))) },
  },
];

/** 手部穴位层级过滤：palm / dorsal / both，配合"自动识别掌面"设置 */
export function surfaceOK(pt, ctx, setting) {
  if (pt.surface === 'both' || setting === 'all') return true;
  const facing = setting === 'auto' ? ctx.palm : setting === 'palm';
  if (setting === 'auto' && ctx.conf < 0.12) return true; // 方向不确定时全部显示
  return pt.surface === (facing ? 'palm' : 'dorsal');
}
