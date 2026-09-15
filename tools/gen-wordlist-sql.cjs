// 生成 lesson_words 批量导入 SQL（新概念一/二分课词表）
// NCE1 来源: jingguokaren-cloud/typing-practice words.js（144课，课标题与教材目录核对一致）
// NCE2 来源: hhl666888/New-Concept-English-Vocabulary-Learning nce-vocabulary-data.json
//            （96课，L1/L2/L3/L4/L5/L20/L50 抽验与官方词表逐词一致）
// 冲突策略: on conflict do nothing —— 已手工录入的课（如新概念二 L27）不会被覆盖
const fs = require('fs');

// ---------- 解析 words.js（平衡括号提取对象） ----------
function parseWordsJs(path) {
  const src = fs.readFileSync(path, 'utf8');
  const start = src.indexOf('nceWords');
  const braceStart = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return eval('(' + src.slice(braceStart, end + 1) + ')');
}

// ---------- NCE1 清洗 ----------
// "handbag   n.(" + cn "女用)手提包"  → handbag (女用)手提包
// "January   n.1"  + cn "月"          → January 1月
// "is   v.be"      + cn "动词…"       → is 动词…
const POS_RE = /\s+(?=(?:n|v|vi|vt|adj|adv|pron|prep|conj|int|num|art)\.)/;
function cleanNce1(en, cn) {
  let word = en, def = String(cn || '');
  const parts = en.split(POS_RE);
  if (parts.length > 1) {
    word = parts[0].trim();
    const tail = en.slice(word.length).trim(); // 如 "n.(" / "n.1" / "v.be"
    let prefix = '';
    const dm = tail.match(/(\d+)\s*$/);        // "n.1" 的数字属于中文（1月）
    if (dm) prefix += dm[1];
    if (/[(〔]\s*$/.test(tail)) prefix += '('; // 释义被劈开，补回开括号
    def = prefix + def;
  }
  def = def.replace(/〕/g, ')');
  word = word.replace(/\s+/g, ' ');
  def = def.replace(/\s+/g, ' ').trim();
  return [word, def].filter(Boolean).join(' ');
}

// ---------- NCE2 ----------
function fmtNce2(w) {
  return [w.word, w.pos, w.def].map(s => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' ');
}

// ---------- 生成 SQL ----------
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const rows = [];
let n1Words = 0, n2Words = 0, n1Lessons = 0, n2Lessons = 0;

const nce1 = parseWordsJs("C:\\Users\\40713\\AppData\\Local\\Temp\\nce\\tp-words.js");
Object.keys(nce1).map(Number).sort((a, b) => a - b).forEach(lessonNo => {
  const words = (nce1[lessonNo].words || [])
    .map(w => cleanNce1(w.en, w.cn)).filter(Boolean);
  if (!words.length) return; // 无新词的练习课不建行
  n1Lessons++; n1Words += words.length;
  rows.push(`  ('新概念一', ${lessonNo}, ${q(JSON.stringify(words))}::text)`);
});

const all = require("C:\\Users\\40713\\AppData\\Local\\Temp\\nce\\nce-vocab-data.json");
Object.keys(all.NCE2).map(Number).sort((a, b) => a - b).forEach(lessonNo => {
  const words = ((all.NCE2[lessonNo] || {}).vocabulary || []).map(fmtNce2).filter(Boolean);
  if (!words.length) return;
  n2Lessons++; n2Words += words.length;
  rows.push(`  ('新概念二', ${lessonNo}, ${q(JSON.stringify(words))}::text)`);
});

const sql = `-- ============================================================
-- 批量导入新概念一/二分课词表到 lesson_words
-- 新概念一: ${n1Lessons} 课 / ${n1Words} 词（含无新词练习课不建行）
-- 新概念二: ${n2Lessons} 课 / ${n2Words} 词
-- 冲突策略: 已存在的课（手工录入过的，如新概念二 L27）保持不变
-- 生成时间: ${new Date().toISOString().slice(0, 10)}
-- ============================================================
insert into lesson_words (family_id, book, lesson_no, words)
select f.id, v.book, v.lesson_no, v.words::jsonb
from families f
join (values
${rows.join(',\n')}
) as v(book, lesson_no, words) on true
on conflict (family_id, book, lesson_no) do nothing;

-- 导入后自检：应显示两本书的课数与词数
select book, count(*) as 课数, sum(jsonb_array_length(words)) as 词数
from lesson_words group by book order by book;
`;

fs.writeFileSync('wordlist_import.sql', sql);
console.log('NCE1:', n1Lessons, '课', n1Words, '词');
console.log('NCE2:', n2Lessons, '课', n2Words, '词');
console.log('SQL rows:', rows.length, '→ wordlist_import.sql');
