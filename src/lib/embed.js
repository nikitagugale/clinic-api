// A deterministic stand-in for an embeddings API: no network, no key, same answer every time.
// It hashes words (and word pairs) into a 1536-dimension vector, so two notes that share clinical vocabulary
// land close together under cosine similarity. A real embedding model understands meaning, not just shared words,
// but the database side (vector column, ivfflat index, cosine query) is identical.
export const DIM = 1536;

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'is', 'was', 'with', 'for', 'her', 'his', 'she', 'he', 'has', 'had', 'no', 'not', 'since', 'this', 'that', 'it', 'by', 'as', 'be']);

function stem(w) {
  return w.endsWith('ss') ? w : w.replace(/(ing|ed|es|s)$/, '');
}

// A little clinical vocabulary so related wording lands together: "tightness" is pain, "climbing stairs" is exertion.
const CONCEPTS = {
  tightness: 'pain', ach: 'pain', hurt: 'pain', sore: 'pain',
  climb: 'exertion', stair: 'exertion', uphill: 'exertion', walk: 'exertion', lift: 'exertion', exert: 'exertion', exertion: 'exertion',
  fever: 'fever', febril: 'fever',
};
// Body-part and symptom words carry more of the meaning of a note than "worse" or "after" do.
const HEAVY = new Set(['chest', 'back', 'knee', 'head', 'headache', 'migraine', 'cough', 'rash', 'skin', 'arm', 'forearm', 'throat', 'breath', 'pain', 'exertion', 'fever']);

function tokens(text) {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(stem)
    .map(w => CONCEPTS[w] ?? w);
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** @param {string} text @returns {number[]} a unit-length vector of DIM numbers */
export function embed(text) {
  const v = new Array(DIM).fill(0);
  const t = tokens(text);
  const add = (feature, weight) => {
    const h = fnv1a(feature);
    v[h % DIM] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  t.forEach((w, i) => {
    add(w, HEAVY.has(w) ? 2 : 1);
    if (i > 0) add(`${t[i - 1]}_${w}`, 0.5);
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

/** Formats a vector the way pgvector reads it: '[0.1,0.2,...]'. Pass it as a parameter and cast with ::vector. */
export function toPgVector(vec) {
  return `[${vec.map(x => Number(x.toFixed(6))).join(',')}]`;
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both are unit length
}
