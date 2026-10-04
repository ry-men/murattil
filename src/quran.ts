// Texte du Coran (affichage) et découpage en mots, aligné sur les index du moteur.
import OVERRIDES from "./word-overrides.json";
export interface Verse { surah: number; ayah: number; text: string }
export interface Surah { n: number; ar: string; tr: string; verses: Verse[] }

const WAQF = new Set(["ۖ", "ۗ", "ۘ", "ۙ", "ۚ", "ۛ", "ۜ"]);
const isWaqf = (t: string) => t.length <= 2 && [...t].every((c) => WAQF.has(c));

let surahs: Surah[] | null = null;

const strip = (s: string) =>
  s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, "").replace(/ٱ/g, "ا");

export async function loadQuran(url: string): Promise<Surah[]> {
  if (surahs) return surahs;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quran.json: HTTP ${res.status}`);
  const raw = (await res.json()) as { surah: number; ayah: number; text_uthmani: string; surah_name: string; surah_name_en: string }[];
  const out: Surah[] = [];
  for (const v of raw) {
    let s = out[v.surah - 1];
    if (!s) s = out[v.surah - 1] = { n: v.surah, ar: strip(v.surah_name.replace(/^سُورَةُ\s*/, "")), tr: v.surah_name_en, verses: [] };
    s.verses.push({ surah: v.surah, ayah: v.ayah, text: v.text_uthmani.replace(/﻿/g, "") });
  }
  surahs = out;
  return out;
}

export function getSurah(n: number): Surah {
  if (!surahs) throw new Error("Coran non chargé");
  return surahs[n - 1];
}

/** Mots d'une ayah ; signes de pause et de prosternation collés au mot précédent, ۞ au suivant. */
export function splitWords(text: string): string[] {
  const out: string[] = [];
  let pre = "";
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (tok === "\u06DE") { pre = "\u06DE "; continue; }
    if ((isWaqf(tok) || tok === "\u06E9") && out.length) out[out.length - 1] += " " + tok;
    else { out.push(pre + tok); pre = ""; }
  }
  return out;
}

export const BISMILLAH_WORDS = 4;

/** L'ayah 1 (hors Fatiha et Tawba) commence par la basmala dans ce texte : le moteur ne la compte pas. */
export function hasBismillahPrefix(surah: number, ayah: number, text: string): boolean {
  return ayah === 1 && surah !== 1 && surah !== 9 && strip(text).startsWith("بسم الله الرحمن الرحيم");
}

/** Mots affichés pour une ayah (sans basmala). Vérifié : même nombre de mots que le moteur sur les 6236 ayahs. */
export function ayahWords(v: Verse): { words: string[]; bismillah: string | null } {
  const ov = (OVERRIDES as Record<string, string[]>)[`${v.surah}:${v.ayah}`];
  if (ov) return { words: ov, bismillah: null };
  const all = splitWords(v.text);
  if (hasBismillahPrefix(v.surah, v.ayah, v.text)) {
    return { words: all.slice(BISMILLAH_WORDS), bismillah: all.slice(0, BISMILLAH_WORDS).join(" ") };
  }
  return { words: all, bismillah: null };
}

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export const arNum = (n: number) => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);
