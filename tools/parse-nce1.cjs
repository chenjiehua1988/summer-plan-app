// 解析 typing-practice words.js（NCE1 144课词表）并做质量分析
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || '/tmp/nce/tp-words.js', 'utf8');

// 提取 const nceWords = { ... }; 的平衡括号对象
const start = src.indexOf('nceWords');
const braceStart = src.indexOf('{', start);
let depth = 0, end = -1;
for (let i = braceStart; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const data = eval('(' + src.slice(braceStart, end + 1) + ')');
const ks = Object.keys(data).map(Number).sort((a, b) => a - b);
console.log('lessons:', ks.length, 'range:', ks[0] + '..' + ks[ks.length - 1]);

const counts = ks.map(k => data[k].words.length);
const total = counts.reduce((a, b) => a + b, 0);
console.log('totalWords:', total, 'avg:', (total / ks.length).toFixed(1));
const thin = ks.filter(k => data[k].words.length < 6).map(k => k + '(' + data[k].words.length + ')');
console.log('thin(<6):', thin.join(' ') || 'none');

[13, 25, 61, 73, 143].forEach(l => {
  if (data[l]) console.log('L' + l + ':', data[l].words.map(w => w.en).join(', '));
});

// 质量扫描
let junk = 0, emptyCn = 0, emptyEn = 0;
const junkSamples = [];
ks.forEach(k => data[k].words.forEach(w => {
  if (!w.en || !w.en.trim()) emptyEn++;
  else if (/\b(n|v|vi|vt|adj|adv|pron|prep|conj|int|num|art)\.\s*\S/.test(w.en)) {
    junk++;
    if (junkSamples.length < 15) junkSamples.push('L' + k + ' ' + JSON.stringify(w));
  }
  if (!w.cn || !w.cn.trim()) emptyCn++;
}));
console.log('en带词性碎片:', junk, '空cn:', emptyCn, '空en:', emptyEn);
junkSamples.forEach(s => console.log(' ', s));
