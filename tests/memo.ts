// Tests unitaires sans modèle ni audio : révision espacée, progression, calibrage personnel, sauvegarde.
// Lancer : npx tsx tests/memo.ts
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { units, unitStatus, fromMemory, weakPoints, juzProgress, mergePassage, activityGrid, minutesToday, streakDays, JUZ_STARTS } from "../src/memo";
import { buildCalib, isSuppressed, relaxedRules } from "../src/calib";
import type { SessionRecord, TajwidRec } from "../src/store";

const quran = JSON.parse(readFileSync("public/quran.json", "utf8")) as { surah: number; ayah: number }[];
const count = new Map<number, number>();
for (const v of quran) count.set(v.surah, Math.max(count.get(v.surah) ?? 0, v.ayah));
const ayahCount = (s: number) => count.get(s)!;
const DAY = 86400000;
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok ·", name); };

const rec = (over: Partial<SessionRecord>): SessionRecord => ({
  id: String(Math.random()), date: new Date().toISOString(), mode: "hifz", surah: 112, from: 1, to: 4, durationSec: 60,
  ayahs: ["112:1", "112:2", "112:3", "112:4"], mistakes: [], hints: 0, validated: 15, total: 15, ...over,
});
const tj = (over: Partial<TajwidRec>): TajwidRec => ({ surah: 112, ayah: 1, word: 0, word_text: "قُلْ", category: "tajwid", message: "Ghunna : trop courte", confidence: 9, ...over });

ok("juz : 30 juz, 6236 ayahs, rien de mémorisé", () => {
  const j = juzProgress([], [], ayahCount);
  assert.equal(j.length, 30);
  assert.equal(JUZ_STARTS.length, 30);
  assert.equal(j.reduce((s, x) => s + x.total, 0), 6236);
  assert.equal(j.reduce((s, x) => s + x.done, 0), 0);
  assert.equal(j[0].total, 148); // Al-Fatiha (7) + Al-Baqara 1 à 141
});
ok("juz : Juz 'Amma complet = sourates 78 à 114", () => {
  const j = juzProgress(Array.from({ length: 37 }, (_, i) => 78 + i), [], ayahCount);
  assert.equal(j[29].done, j[29].total);
  assert.equal(j[29].total, 564);
  assert.equal(j[28].done, 0);
});
ok("juz : un passage appris compte ayah par ayah", () => {
  const j = juzProgress([], [{ surah: 67, from: 1, to: 5 }], ayahCount);
  assert.equal(j[28].done, 5);
});
ok("passages : fusion des voisins, pas des éloignés", () => {
  assert.deepEqual(mergePassage([{ surah: 67, from: 1, to: 3 }], { surah: 67, from: 4, to: 6 }), [{ surah: 67, from: 1, to: 6 }]);
  assert.deepEqual(mergePassage([{ surah: 67, from: 1, to: 3 }], { surah: 67, from: 10, to: 12 }).length, 2);
  assert.deepEqual(mergePassage([{ surah: 67, from: 1, to: 3 }], { surah: 68, from: 4, to: 6 }).length, 2);
});
ok("révision : une séance texte visible ou avec indices ne fait pas avancer l'intervalle", () => {
  const u = units([112], ayahCount, () => "Al-Ikhlas")[0];
  assert.equal(unitStatus(u, [rec({})]).streak, 1);
  assert.equal(unitStatus(u, [rec({ display: "visible" })]).streak, 0);
  assert.equal(unitStatus(u, [rec({ hints: 3 })]).streak, 0);
  assert.equal(fromMemory(rec({ display: "peek", hints: 1 })), true);
});
ok("révision : intervalle 1, 2, 4 jours puis retour à 1 après un échec", () => {
  const u = units([112], ayahCount, () => "Al-Ikhlas")[0];
  const at = (d: number, over: Partial<SessionRecord> = {}) => rec({ date: new Date(Date.now() - d * DAY).toISOString(), ...over });
  assert.equal(unitStatus(u, [at(5), at(3)]).intervalDays, 4);
  assert.equal(unitStatus(u, [at(5), at(3), at(1, { validated: 10 })]).intervalDays, 1);
  assert.ok(unitStatus(u, []).dueInDays <= 0);
});
ok("« pas une faute » : ne pèse ni sur la réussite ni sur les points faibles", () => {
  const u = units([112], ayahCount, () => "Al-Ikhlas")[0];
  assert.equal(unitStatus(u, [rec({ tajwid: [tj({}), tj({ word: 1 })] })]).streak, 0);
  assert.equal(unitStatus(u, [rec({ tajwid: [tj({ fp: true }), tj({ word: 1, fp: true })] })]).streak, 1);
  assert.equal(weakPoints([rec({ tajwid: [tj({ fp: true })] })]).topRules.length, 0);
  assert.equal(weakPoints([rec({ tajwid: [tj({})] })]).topRules.length, 1);
});
ok("calibrage : rien n'est masqué sans retours", () => {
  const c = buildCalib([rec({ tajwid: [tj({}), tj({ word: 1 })] })]);
  assert.equal(isSuppressed(tj({ word: 2 }), c), false);
  assert.equal(relaxedRules(c).length, 0);
});
ok("calibrage : 3 retours sur une règle masquent les fautes peu sûres, pas les très sûres", () => {
  const c = buildCalib([rec({ tajwid: [tj({ fp: true, confidence: 9 }), tj({ word: 1, fp: true, confidence: 11 }), tj({ word: 2, fp: true, confidence: 10 }), tj({ word: 3 })] })]);
  assert.equal(relaxedRules(c).length, 1);
  assert.equal(isSuppressed(tj({ ayah: 2, confidence: 10.5 }), c), true);
  assert.equal(isSuppressed(tj({ ayah: 2, confidence: 14 }), c), false);
  assert.equal(isSuppressed(tj({ ayah: 2, message: "Madd muttasil : 2 temps au lieu de 4", confidence: 6 }), c), false);
});
ok("calibrage : retours minoritaires = règle gardée ; même mot marqué 2 fois = masqué", () => {
  const many = Array.from({ length: 8 }, (_, i) => tj({ ayah: 3, word: i }));
  const c = buildCalib([rec({ tajwid: [...many, tj({ fp: true }), tj({ word: 1, fp: true }), tj({ word: 2, fp: true })] })]);
  assert.equal(isSuppressed(tj({ ayah: 4, confidence: 5 }), c), false);
  const c2 = buildCalib([rec({ tajwid: [tj({ fp: true })] }), rec({ tajwid: [tj({ fp: true })] }), rec({ tajwid: many })]);
  assert.equal(isSuppressed(tj({ confidence: 30 }), c2), true);
});
ok("calibrage : un mot oublié n'est jamais masqué par règle", () => {
  const m = (w: number, fp = true) => tj({ word: w, category: "mot", message: "Mot oublié", fp, confidence: undefined });
  const c = buildCalib([rec({ tajwid: [m(0), m(1), m(2), m(3), m(4)] })]);
  assert.equal(isSuppressed(tj({ ayah: 2, category: "mot", message: "Mot oublié", confidence: undefined }), c), false);
});
ok("activité : 12 semaines du lundi au dimanche, aujourd'hui compté", () => {
  const now = new Date(2026, 10, 15, 10); // dimanche 15 nov. 2026
  const g = activityGrid([rec({ date: now.toISOString(), durationSec: 600 })], 12, now);
  assert.equal(g.length, 84);
  assert.equal(g[83].key, "2026-11-15");
  assert.equal(g[83].minutes, 10);
  assert.equal(g.filter((d) => d.future).length, 0);
  assert.equal(minutesToday([rec({ date: now.toISOString(), durationSec: 600 })], now), 10);
  assert.equal(streakDays([rec({ date: now.toISOString() }), rec({ date: new Date(+now - DAY).toISOString() })], now), 2);
});
console.log(`${n} tests réussis`);
