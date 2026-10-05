// Texte coloré selon les règles de tajwid.
// Données : cpfair/quran-tajweed (CC-BY 4.0), recalées exactement sur notre texte par scripts/gen_tajweed.py.
// Une ayah dont le texte ne correspond pas exactement n'est pas colorée (jamais d'approximation).
type Data = { rules: string[]; ayahs: Record<string, number[][]> };
let data: Data | null = null;
let loading: Promise<void> | null = null;

export const RULE_FR: Record<string, string> = {
  madd_2: "Madd naturel (2)",
  madd_246: "Madd 'arid / lin (2, 4, 6)",
  madd_muttasil: "Madd muttasil (4, 5)",
  madd_munfasil: "Madd munfasil (4, 5)",
  madd_6: "Madd lazim (6)",
  ghunnah: "Ghunna",
  ikhfa: "Ikhfa",
  ikhfa_shafawi: "Ikhfa shafawi",
  iqlab: "Iqlab",
  idghaam_ghunnah: "Idgham avec ghunna",
  idghaam_no_ghunnah: "Idgham sans ghunna",
  idghaam_shafawi: "Idgham shafawi",
  idghaam_mutajaanisain: "Idgham mutajanisayn",
  idghaam_mutaqaaribain: "Idgham mutaqaribayn",
  qalqalah: "Qalqala",
  hamzat_wasl: "Hamzat al-wasl (non prononcée)",
  lam_shamsiyyah: "Lam shamsiyya (non prononcé)",
  silent: "Lettre non prononcée",
};

export function tajweedReady(): boolean { return !!data; }

export function loadTajweedColors(base: string): Promise<void> {
  if (data) return Promise.resolve();
  loading ??= fetch(new URL("tajweed.json", base).toString())
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { data = d as Data | null; })
    .catch(() => { loading = null; });
  return loading;
}

/** Nœuds pour un morceau de mot (texte qui commence à `offset` dans le mot), avec les couleurs de règles. */
export function colorize(surah: number, ayah: number, word: number, text: string, offset = 0): Node[] {
  const items = data?.ayahs[`${surah}:${ayah}`]?.filter((x) => x[0] === word);
  if (!items?.length) return [document.createTextNode(text)];
  const rule: (string | null)[] = new Array(text.length).fill(null);
  for (const [, s, e, r] of items) {
    for (let k = Math.max(s, offset); k < Math.min(e, offset + text.length); k++) rule[k - offset] = data!.rules[r];
  }
  const out: Node[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i + 1;
    while (j < text.length && rule[j] === rule[i]) j++;
    const piece = text.slice(i, j);
    if (rule[i]) {
      const sp = document.createElement("span");
      sp.className = `tjc tjc-${rule[i]}`;
      sp.textContent = piece;
      out.push(sp);
    } else out.push(document.createTextNode(piece));
    i = j;
  }
  return out;
}

/** Légende (règles présentes dans les données). */
export function legend(): HTMLElement {
  const ul = document.createElement("ul");
  ul.className = "tjc-legend";
  for (const [k, fr] of Object.entries(RULE_FR)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="tjc tjc-${k}">●</span> `;
    li.append(fr);
    ul.append(li);
  }
  return ul;
}
