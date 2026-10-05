import "@fontsource/amiri-quran/400.css";
import "./style.css";
import type { CorrectionAction, CorrectionState, CorrectionIssue } from "./core/index";
import { Mic, type MicStatus } from "./audio";
import { isModelCached } from "./model-cache";
import { loadQuran, getSurah, ayahWords, hasBismillahPrefix, arNum, type Surah } from "./quran";
import { loadHistory, saveSession, updateSession, clearHistory, loadPrefs, savePrefs, setDefaultServer, getDefaultServer, customServer, type Mistake, type SessionRecord, type MissedWord } from "./store";
import { exportDiagnostic } from "./diagnostic";
import { buildSegments, analyzeSession, checkServer, segmentForAyah, analyzeOne, wav, type TajwidError } from "./tajwid";
import { enqueue, pending as pendingSegments, remove as removeSegment, countFor } from "./queue";
import { units, unitStatus, dueToday, streakDays, minutesThisWeek, weakPoints, surahAccuracy, pickTestQuestion, type UnitStatus } from "./memo";

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BASE = document.baseURI;
const MODEL_KEY = "zipformer-a0w-ep1-a05-int8";
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function show(screen: string) {
  document.body.dataset.screen = screen;
  window.scrollTo(0, 0);
}

let toastTimer: number | undefined;
function toast(msg: string, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Moteur (Web Worker)
// ---------------------------------------------------------------------------
type EngineState = "unknown" | "absent" | "loading" | "ready" | "error";
let engineState: EngineState = "unknown";
let worker: Worker | null = null;
let readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
let stopWaiter: (() => void) | null = null;
let engineRestarts = 0;

function setEngine(s: EngineState, detail = "") {
  engineState = s;
  const pill = $("engine-pill");
  pill.className = "pill " + (s === "ready" ? "ok" : s === "error" ? "bad" : "");
  pill.textContent = s === "ready" ? "Hors ligne · prêt" : s === "loading" ? "Préparation…" : s === "absent" ? "Moteur à installer" : s === "error" ? "Erreur moteur" : "Vérification…";
  $("engine-card").hidden = s === "ready" || s === "unknown";
  if (detail) $("engine-detail").textContent = detail;
  $("btn-install").hidden = s === "loading" || s === "ready";
  $("btn-install").textContent = s === "error" ? "Réessayer" : "Télécharger maintenant";
}

function spawnWorker() {
  worker?.terminate();
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => {
    e.preventDefault?.();
    onWorkerCrash(String(e.message || "crash"));
  };
}

function ensureEngine(): Promise<void> {
  if (engineState === "ready" && worker) return Promise.resolve();
  const p = new Promise<void>((resolve, reject) => readyWaiters.push({ resolve, reject }));
  if (engineState !== "loading") {
    setEngine("loading", "Téléchargement du moteur…");
    $("engine-card").querySelector<HTMLElement>(".progress")!.hidden = false;
    spawnWorker();
    worker!.postMessage({ type: "init", base: BASE });
  }
  return p;
}

function onWorkerCrash(reason: string) {
  console.error("Worker crash:", reason);
  const wasReady = engineState === "ready";
  engineState = "unknown";
  if (wasReady && engineRestarts < 5) {
    engineRestarts++;
    // Relance transparente : le modèle est en cache, ça prend quelques secondes.
    toast("Moteur relancé automatiquement");
    void ensureEngine().then(() => applySessionToWorker()).catch(() => undefined);
  } else {
    setEngine("error", "Le moteur s'est arrêté. " + reason);
    readyWaiters.forEach((w) => w.reject(new Error(reason)));
    readyWaiters = [];
  }
}

function setProgress(pct: number) {
  const bar = $("engine-card").querySelector<HTMLElement>(".bar")!;
  bar.style.width = pct + "%";
  $("engine-detail").textContent = pct < 100 ? `Téléchargement : ${pct} %` : "Démarrage du moteur…";
  if (session.active && engineState === "loading") $("r-wait-text").textContent = pct < 100 ? `Préparation du moteur : ${pct} % (une seule fois)` : "Démarrage du moteur…";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onWorkerMessage(msg: any) {
  switch (msg.type) {
    case "loading":
      setProgress(msg.percent);
      break;
    case "loading_status":
      break;
    case "ready":
      setEngine("ready");
      void navigator.storage?.persist?.().catch(() => undefined);
      startVerifier();
      startMini();
      readyWaiters.forEach((w) => w.resolve());
      readyWaiters = [];
      break;
    case "error":
      if (msg.fatal) {
        setEngine("error", "Échec : " + msg.message + ". Vérifie ta connexion puis réessaie.");
        readyWaiters.forEach((w) => w.reject(new Error(msg.message)));
        readyWaiters = [];
      } else console.warn("Moteur :", msg.message);
      break;
    case "stopped":
      stopWaiter?.();
      stopWaiter = null;
      break;
    case "verse_match":
      logEvent({ type: "verse_match", surah: msg.surah, ayah: msg.ayah, c: msg.confidence }, msg.at);
      noteAyahTime(msg.surah, msg.ayah, msg.at);
      onVerseMatch(msg.surah, msg.ayah);
      break;
    case "verse_candidate":
      onCandidate(msg);
      break;
    case "word_progress":
      onWordProgress(msg.surah, msg.ayah, msg.matched_indices as number[]);
      logEvent({ type: "word_progress", surah: msg.surah, ayah: msg.ayah, w: msg.word_index, m: msg.matched_indices }, msg.at);
      noteAyahTime(msg.surah, msg.ayah, msg.at);
      break;
    case "verdicts":
      onVerdicts(msg.data as Int16Array);
      break;
    case "correction":
      logEvent({ type: "correction", phase: msg.state.phase, issue: msg.state.issue }, msg.at);
      onCorrection(msg.state as CorrectionState, msg.totalWords as number);
      break;
  }
}

// ---------------------------------------------------------------------------
// Séance
// ---------------------------------------------------------------------------
const session = {
  active: false,
  mode: "libre" as "libre" | "hifz",
  surah: null as number | null,
  from: 1,
  to: 1,
  hide: true,
  showAll: false,
  startedAt: 0,
  timer: 0 as number | undefined,
  rendered: null as number | null,
  progress: new Map<string, Set<number>>(),
  hinted: new Set<string>(),
  ayahs: [] as string[],
  current: null as { surah: number; ayah: number } | null,
  mistakes: [] as Mistake[],
  hints: 0,
  correction: null as CorrectionState | null,
  lastScroll: 0,
  verdicts: new Map<string, number>(),
  audio: [] as Int16Array[],
  audioLen: 0,
  log: [] as Record<string, unknown>[],
  ayahAt: new Map<string, number>(),
  display: "hidden" as "hidden" | "peek" | "visible",
  cue: 0,
  tjErrors: new Map<string, TajwidError[]>(),
  tjAnalyzed: new Set<string>(),
  tjAsked: new Set<string>(),
  tjPending: [] as { surah: number; from: number; to: number; wav: Blob }[],
  tjLive: "off" as "off" | "checking" | "on" | "wait",
  tjEngine: "server" as "server" | "mini",
  atelier: null as null | { surah: number; ayah: number; endTimer?: number },
  recId: "" as string,
  test: null as null | { count: number; len: number; scope: number[]; idx: number; asked: Set<string>; results: { surah: number; from: number; to: number; validated: number; total: number; hints: number }[] },
  /** Ce que le 2e modèle a entendu pour chaque mot : ratio de ressemblance et squelette identique. */
  heard: new Map<string, { r: number; exact: boolean; text: string }>(),
  verifyAsked: new Set<string>(),
};

const MAX_AUDIO = 16000 * 60 * 20; // 20 min max gardées pour le diagnostic
function logEvent(e: Record<string, unknown>, at?: number) {
  if (session.active) session.log.push({ t: +((at ?? session.audioLen / 16000).toFixed(2)), ...e });
}

const mic = new Mic({
  workletUrl: new URL("audio-processor.js", BASE).toString(),
  phoneFilters: () => loadPrefs().phoneFilters,
  onChunk: (samples) => {
    if (!session.active) return;
    if (session.audioLen < MAX_AUDIO) {
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
      session.audio.push(pcm);
    }
    session.audioLen += samples.length;
    if (engineState === "ready" && worker) worker.postMessage({ type: "audio", samples }, [samples.buffer]);
  },
  onLevel: (rms) => {
    const v = Math.min(1, Math.max(0, (rms - 0.003) * 18));
    $("meter-fill").style.width = Math.round(v * 100) + "%";
  },
  onStatus: (s: MicStatus, detail?: string) => {
    const pill = $("mic-pill");
    const map: Record<MicStatus, [string, string]> = {
      off: ["", "Micro coupé"],
      starting: ["", "Micro…"],
      on: ["ok", "● Micro actif"],
      recovering: ["warn", "Reconnexion…"],
      denied: ["bad", "Micro refusé"],
      error: ["bad", "Micro indisponible"],
    };
    pill.className = "pill " + map[s][0];
    pill.textContent = map[s][1];
    if (s === "recovering" && session.active) console.info("Micro relancé :", detail);
    if (s === "denied") toast("Autorise le micro dans les réglages du navigateur.", 5000);
  },
});

function applySessionToWorker() {
  if (!worker) return;
  worker.postMessage({ type: "set_mode", mode: session.mode === "hifz" ? "correction" : "tracking" });
  worker.postMessage({
    type: "set_expected",
    passage: session.mode === "hifz" && session.surah ? { surah: session.surah, ayah: session.from, ayahEnd: session.to } : null,
  });
  worker.postMessage({ type: "set_slip", on: session.mode === "hifz" && loadPrefs().sensitive });
  worker.postMessage({ type: "reset" });
}

async function startSession(mode: "libre" | "hifz", surah: number | null, from = 1, to = 1, opts: { cue?: number; title?: string; atelier?: boolean } = {}) {
  Object.assign(session, {
    active: true, mode, surah, from, to, showAll: false, rendered: null,
    progress: new Map(), hinted: new Set(), ayahs: [], current: null, mistakes: [], hints: 0, correction: null,
    verdicts: new Map(), audio: [], audioLen: 0, log: [], ayahAt: new Map(), heard: new Map(), verifyAsked: new Set(),
    tjErrors: new Map(), tjAnalyzed: new Set(), tjAsked: new Set(), tjPending: [], cue: opts.cue ?? 0, recId: "",
  });
  const prefs = loadPrefs();
  session.display = mode === "hifz" && !opts.atelier ? (opts.cue ? "hidden" : prefs.display) : "visible";
  if (!opts.atelier) session.atelier = null;
  document.body.classList.toggle("atelier", !!opts.atelier);
  $("btn-stop").textContent = opts.atelier ? "Analyser" : "Terminer";
  session.hide = session.display !== "visible";
  document.body.classList.toggle("hifz", mode === "hifz");
  $("r-text").replaceChildren();
  $("r-text").classList.toggle("hidden-text", session.display === "hidden");
  $("r-text").classList.toggle("peek-text", session.display === "peek");
  if (opts.atelier) { session.tjLive = "off"; tjBar(); } else startLiveTajwid();
  $("btn-toggle-hide").textContent = "Afficher";
  $("btn-hint").hidden = !(mode === "hifz" && session.hide);
  $("btn-toggle-hide").hidden = !(mode === "hifz" && session.hide);
  $("r-candidate").textContent = "";
  $("r-timer").textContent = "0:00";
  if (mode === "hifz" && surah) {
    renderPassage(surah, from, to);
    const s = getSurah(surah);
    $("r-title").textContent = opts.title ?? `${s.tr} · ${s.ar}`;
    $("r-sub").textContent = opts.atelier ? "Récite lentement, en murattal" : opts.cue ? "Retrouve la suite et récite" : `Ayahs ${from} à ${to}`;
    $("r-wait").hidden = true;
    // Test de mémoire : les premiers mots servent d'amorce (pas comptés comme indices).
    if (opts.cue) ayahEl(surah, from)?.querySelectorAll<HTMLElement>(".w").forEach((w, i) => { if (i < opts.cue!) w.classList.add("hint", "cue"); });
  } else {
    $("r-title").textContent = "Écoute…";
    $("r-sub").textContent = "Récite quelques mots";
    $("r-wait").hidden = false;
    $("r-wait-text").textContent = "Récite quelques mots. L'app retrouve l'ayah toute seule.";
  }
  show("recite");

  try {
    if (engineState !== "ready") {
      $("r-wait").hidden = false;
      $("r-wait-text").textContent = "Préparation du moteur…";
    }
    await ensureEngine();
  } catch {
    toast("Le moteur n'a pas pu démarrer.", 4000);
    session.active = false;
    show("home");
    return;
  }
  if (!session.active) return;
  if (mode === "hifz") $("r-wait").hidden = true;
  else $("r-wait-text").textContent = "Récite quelques mots. L'app retrouve l'ayah toute seule.";
  applySessionToWorker();
  try {
    await mic.start();
  } catch {
    session.active = false;
    toast("Impossible d'ouvrir le micro.", 4000);
    show("home");
    return;
  }
  session.startedAt = Date.now();
  clearInterval(session.timer);
  session.timer = window.setInterval(() => {
    $("r-timer").textContent = fmtTime((Date.now() - session.startedAt) / 1000);
  }, 1000);
}

async function endSession() {
  if (!session.active) return;
  session.active = false;
  clearInterval(session.timer);
  closeSheet();
  await mic.stop();
  if (worker && engineState === "ready") {
    await new Promise<void>((resolve) => {
      stopWaiter = resolve;
      worker!.postMessage({ type: "stop" });
      setTimeout(resolve, 5000);
    });
  }
  if (verifier && session.current) {
    const { surah: su, ayah: a } = session.current;
    void track(scheduleVerify(su, a, session.audioLen / 16000));
    // Ayahs jugées bonnes au passage puis révisées par le moteur : on les fait vérifier maintenant.
    const fromA = session.mode === "hifz" ? session.from : Math.max(1, a - 60);
    for (let x = fromA; x < a; x++) void track(scheduleVerify(su, x));
    $("btn-stop").textContent = "Vérification…";
    await Promise.race([Promise.all([...verifyPending]), new Promise((r) => setTimeout(r, verifierReady ? 15000 : 8000))]);
    $("btn-stop").textContent = "Terminer";
    // L'ayah en cours devient « passée » pour le bilan.
    paintAyah(su, a);
  }
  if (session.tjLive !== "off" && session.current) {
    const { surah: su, ayah: a } = session.current;
    const fromA = session.mode === "hifz" ? session.from : Math.max(1, a - 60);
    for (let x = fromA; x < a; x++) void trackTj(scheduleTajwid(su, x));
    void trackTj(scheduleTajwid(su, a, session.audioLen / 16000));
    if (session.tjLive === "on" || session.tjLive === "checking") {
      $("btn-stop").textContent = "Analyse tajwid…";
      await Promise.race([Promise.all([...tjInflight]), new Promise((r) => setTimeout(r, 20000))]);
      $("btn-stop").textContent = "Terminer";
    }
  }
  const duration = session.startedAt ? (Date.now() - session.startedAt) / 1000 : 0;
  const stats = computeWordStats();
  const rec: SessionRecord = {
    id: String(Date.now()),
    date: new Date().toISOString(),
    mode: session.mode,
    surah: session.surah ?? session.current?.surah ?? null,
    from: session.mode === "hifz" ? session.from : firstAyah(),
    to: session.mode === "hifz" ? session.to : lastAyah(),
    durationSec: Math.round(duration),
    ayahs: [...session.ayahs],
    mistakes: session.mistakes,
    hints: session.hints,
    validated: stats.validated,
    total: stats.total,
    missed: stats.missed,
  };
  if (session.test) rec.mode = "test";
  if (session.tjAnalyzed.size) rec.tajwid = [...session.tjErrors.values()].flat().map((e) => ({ surah: e.surah, ayah: e.ayah, word: e.word, word_text: e.word_text, category: e.category, message: e.message }));
  lastDiag = { audio: session.audio, log: session.log, record: rec, verdicts: [...session.verdicts], ayahAt: [...session.ayahAt] };
  if (duration > 8 || rec.ayahs.length) saveSession(rec);
  session.recId = rec.id;
  for (const p of session.tjPending.splice(0)) await enqueue({ sessionId: rec.id, surah: p.surah, from: p.from, to: p.to, wav: p.wav, createdAt: Date.now() });
  if (session.test) session.test.results.push({ surah: rec.surah ?? 0, from: session.from, to: session.to, validated: rec.validated ?? 0, total: rec.total ?? 0, hints: rec.hints });
  if (session.atelier) { rec.mode = "atelier"; updateSession(rec.id, { mode: "atelier" }); void showAtelierResult(rec); return; }
  renderSummary(rec);
  renderHistory();
  show("summary");
  void processQueue();
}

let lastDiag: { audio: Int16Array[]; log: Record<string, unknown>[]; record: SessionRecord; verdicts: [string, number][]; ayahAt: [string, number][] } | null = null;

/** Mots récités : validés / non reconnus / faux probables. La fin non récitée de la dernière ayah ne compte pas. */
function computeWordStats(): { total: number; validated: number; missed: MissedWord[] } {
  const out = { total: 0, validated: 0, missed: [] as MissedWord[] };
  const cur = session.current;
  if (!cur) return out;
  const surah = cur.surah;
  const ayahs = session.mode === "hifz"
    ? Array.from({ length: Math.max(0, cur.ayah - session.from + 1) }, (_, i) => session.from + i)
    : [...new Set(session.ayahs.filter((k) => k.startsWith(surah + ":")).map((k) => Number(k.split(":")[1])))].sort((a, b) => a - b);
  for (const a of ayahs) {
    const words = ayahWords(getSurah(surah).verses[a - 1]).words;
    let last = words.length - 1;
    if (a === cur.ayah) {
      last = -1;
      words.forEach((_, i) => { const st = wordState(surah, a, i); if (st === 0 || st === 1) last = i; });
    }
    for (let i = 0; i <= last; i++) {
      out.total++;
      const st = wordState(surah, a, i);
      if (st === 0 || st === 1) out.validated++;
      else out.missed.push({ surah, ayah: a, word: i, text: words[i], kind: st === 2 ? "bad" : "miss" });
    }
  }
  return out;
}

const firstAyah = () => (session.ayahs.length ? Number(session.ayahs[0].split(":")[1]) : null);
const lastAyah = () => (session.ayahs.length ? Number(session.ayahs[session.ayahs.length - 1].split(":")[1]) : null);

// ---------------------------------------------------------------------------
// Rendu du texte
// ---------------------------------------------------------------------------
function renderPassage(surah: number, from: number, to: number) {
  const s = getSurah(surah);
  const root = $("r-text");
  root.replaceChildren();
  const head = document.createElement("div");
  head.className = "surah-head";
  head.innerHTML = `<span>${s.ar}</span>`;
  root.append(head);
  const first = s.verses[from - 1];
  if (first && (hasBismillahPrefix(surah, from, first.text) || (from === 1 && surah !== 1 && surah !== 9))) {
    const b = document.createElement("div");
    b.className = "bsm";
    b.textContent = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ";
    root.append(b);
  }
  const body = document.createElement("p");
  body.className = "verses";
  for (let a = from; a <= to; a++) {
    const v = s.verses[a - 1];
    if (!v) continue;
    const span = document.createElement("span");
    span.className = "ayah";
    span.dataset.a = String(a);
    const { words } = ayahWords(v);
    words.forEach((w, i) => {
      const ws = document.createElement("span");
      ws.className = "w";
      ws.dataset.w = String(i);
      // Première lettre (avec ses voyelles) séparée : sert au mode « premières lettres ».
      const m = w.match(/^(\u06DE\s)?.[\u064B-\u065F\u0670\u06D6-\u06ED]*/u);
      const first = m ? m[0] : w.slice(0, 1);
      const a1 = document.createElement("span"); a1.className = "w1"; a1.textContent = first;
      const a2 = document.createElement("span"); a2.className = "wr"; a2.textContent = w.slice(first.length);
      ws.append(a1, a2);
      span.append(ws, " ");
    });
    const end = document.createElement("span");
    end.className = "end";
    end.textContent = "۝" + arNum(a);
    span.append(end, " ");
    body.append(span);
  }
  root.append(body);
  session.rendered = surah;
}

function ayahEl(surah: number, ayah: number): HTMLElement | null {
  if (session.rendered !== surah) return null;
  return $("r-text").querySelector<HTMLElement>(`.ayah[data-a="${ayah}"]`);
}

function wordEl(surah: number, ayah: number, w: number): HTMLElement | null {
  return ayahEl(surah, ayah)?.querySelector<HTMLElement>(`.w[data-w="${w}"]`) ?? null;
}

function scrollToEl(el: Element | null, force = false) {
  if (!el) return;
  const now = performance.now();
  if (!force && now - session.lastScroll < 600) return;
  session.lastScroll = now;
  const box = $("r-scroll");
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (force || r.top < b.top + b.height * 0.2 || r.bottom > b.top + b.height * 0.65) {
    box.scrollTo({ top: box.scrollTop + r.top - b.top - b.height * 0.35, behavior: "smooth" });
  }
}

function setCurrentAyah(surah: number, ayah: number) {
  const prev = session.current;
  session.current = { surah, ayah };
  const s = getSurah(surah);
  if (session.mode === "libre") {
    $("r-title").textContent = `${s.tr} · ${s.ar}`;
  }
  $("r-sub").textContent = session.mode === "hifz" ? `Ayah ${ayah} · passage ${session.from}–${session.to}` : `Ayah ${ayah} sur ${s.verses.length}`;
  if (prev && prev.surah === surah && prev.ayah === ayah) return;
  $("r-text").querySelectorAll(".ayah.active").forEach((e) => e.classList.remove("active"));
  ayahEl(surah, ayah)?.classList.add("active");
  // Les ayahs dépassées : chaque mot est repeint (validé, non reconnu, faux probable).
  if (prev && prev.surah === surah && ayah > prev.ayah) {
    for (let a = (session.mode === "hifz" ? session.from : prev.ayah); a < ayah; a++) paintAyah(surah, a);
    for (let a = prev.ayah; a < ayah; a++) { void track(scheduleVerify(surah, a)); void trackTj(scheduleTajwid(surah, a)); }
  }
}

// ---------------------------------------------------------------------------
// Double vérification (2e modèle, FastConformer)
// ---------------------------------------------------------------------------
let verifier: Worker | null = null;
let verifierReady = false;
let verifyId = 0;
const verifyJobs = new Map<number, { surah: number; ayah: number; resolve: () => void }>();
const verifyPending = new Set<Promise<void>>();
function track(p: Promise<void>): Promise<void> {
  verifyPending.add(p);
  void p.finally(() => verifyPending.delete(p));
  return p;
}

function noteAyahTime(surah: number, ayah: number, at?: number) {
  if (typeof at !== "number" || !session.active) return;
  const k = `${surah}:${ayah}`;
  if (!session.ayahAt.has(k)) session.ayahAt.set(k, at);
}

function startVerifier() {
  if (verifier || !loadPrefs().verify) return;
  verifier = new Worker(new URL("./verify-worker.ts", import.meta.url), { type: "module" });
  verifier.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") verifierReady = true;
    else if (m.type === "error") { console.warn("Vérificateur :", m.message); verifier?.terminate(); verifier = null; }
    else if (m.type === "result") {
      const job = verifyJobs.get(m.id);
      if (!job) return;
      verifyJobs.delete(m.id);
      logEvent({ type: "verify", surah: job.surah, ayah: job.ayah, found: m.found, hyp: m.transcript });
      if (lastDiag) lastDiag.log.push({ type: "verify", surah: job.surah, ayah: job.ayah, found: m.found, hyp: m.transcript });
      for (const [w, r, exact] of m.found as [number, number, boolean][]) session.heard.set(`${job.surah}:${job.ayah}:${w}`, { r, exact, text: "" });
      paintAyah(job.surah, job.ayah);
      job.resolve();
    }
  };
  verifier.onerror = () => { verifier?.terminate(); verifier = null; verifierReady = false; };
  verifier.postMessage({ type: "init", base: BASE });
}

function sliceAudio(t0: number, t1: number): Float32Array {
  const a = Math.max(0, Math.floor(t0 * 16000)), b = Math.min(session.audioLen, Math.floor(t1 * 16000));
  const out = new Float32Array(Math.max(0, b - a));
  let pos = 0;
  for (const c of session.audio) {
    const end = pos + c.length;
    if (end > a && pos < b) {
      const from = Math.max(a, pos), to = Math.min(b, end);
      for (let i = from; i < to; i++) out[i - a] = c[i - pos] / 32768;
    }
    pos = end;
    if (pos >= b) break;
  }
  return out;
}

/** Réécoute une ayah avec le 2e modèle si des mots n'ont pas été validés. */
function scheduleVerify(surah: number, ayah: number, endAt?: number): Promise<void> {
  if (!verifier) return Promise.resolve();
  const key = `${surah}:${ayah}`;
  const start = session.ayahAt.get(key);
  if (start === undefined || session.verifyAsked.has(key)) return Promise.resolve();
  const verses = getSurah(surah).verses;
  const words = ayahWords(verses[ayah - 1]).words;
  const notOk = words.map((_, i) => i).filter((i) => { const st = wordState(surah, ayah, i); return st !== 0 && st !== 1; });
  if (!notOk.length) return Promise.resolve();
  // On fait vérifier tous les mots : le moteur principal peut encore réviser son avis plus tard.
  const targets = words.map((_, i) => i);
  const prevAt = session.ayahAt.get(`${surah}:${ayah - 1}`);
  const nextAt = session.ayahAt.get(`${surah}:${ayah + 1}`);
  const t0 = (prevAt ?? start - 3) - 0.5;
  let t1 = endAt ?? (nextAt !== undefined ? nextAt + 0.8 : session.audioLen / 16000);
  // On attend d'avoir l'audio du début de l'ayah suivante (sert de repère d'alignement).
  if (endAt === undefined && session.active && t1 * 16000 > session.audioLen) {
    const wait = (t1 * 16000 - session.audioLen) / 16 + 100;
    return new Promise((r) => setTimeout(() => void scheduleVerify(surah, ayah).then(r), wait));
  }
  t1 = Math.min(t1, t0 + 28);
  session.verifyAsked.add(key);
  const samples = sliceAudio(t0, t1);
  if (samples.length < 8000) return Promise.resolve();
  const before = ayah > 1 ? ayahWords(verses[ayah - 2]).words : [];
  const after = ayah < verses.length ? ayahWords(verses[ayah]).words.slice(0, 3) : [];
  const id = ++verifyId;
  return new Promise<void>((resolve) => {
    verifyJobs.set(id, { surah, ayah, resolve });
    verifier!.postMessage({ type: "job", id, samples, before, words, after, targets }, [samples.buffer]);
  });
}

/** État d'un mot : 0 ok, 1 incertain, 2 faux, 3 sauté, 4 en attente, -1 inconnu. */
function wordState(surah: number, ayah: number, w: number): number {
  const key = `${surah}:${ayah}:${w}`;
  const v = session.verdicts.get(key);
  let st = v !== undefined && v !== 4 ? v : session.progress.get(`${surah}:${ayah}`)?.has(w) ? 0 : (v ?? -1);
  if (st === 0 || st === 1) return st;
  // Double vérification : un mot « non entendu » est repêché si le 2e modèle l'entend clairement ;
  // un mot jugé « faux » ne l'est que si le 2e modèle entend exactement les bonnes lettres.
  const h = session.heard.get(key);
  if (h && (h.exact || (st !== 2 && rescueOk(surah, ayah, w, h.r)))) st = 0;
  return st;
}

function rescueOk(surah: number, ayah: number, w: number, r: number): boolean {
  if (r >= 0.75) return true;
  // Mots courts (لا, إن…) : on tolère seulement une voyelle longue en moins/en plus.
  return r >= 0.6 && ayahWords(getSurah(surah).verses[ayah - 1]).words[w].replace(/[^\u0621-\u064A]/g, "").length <= 4;
}

function isPassed(surah: number, ayah: number): boolean {
  const c = session.current;
  return !!c && c.surah === surah && ayah < c.ayah;
}

function paintAyah(surah: number, ayah: number) {
  const el = ayahEl(surah, ayah);
  if (!el) return;
  const passed = isPassed(surah, ayah);
  el.querySelectorAll<HTMLElement>(".w").forEach((w, i) => {
    const st = wordState(surah, ayah, i);
    const ok = st === 0 || st === 1;
    w.classList.toggle("ok", ok);
    const bad = passed && st === 2;
    if (bad && !w.classList.contains("bad") && session.mode === "hifz") vibrate();
    w.classList.toggle("bad", bad);
    w.classList.toggle("miss", passed && !ok && st !== 2);
  });
}

function onVerdicts(data: Int16Array) {
  if (!session.active && document.body.dataset.screen !== "recite") return;
  const touched = new Set<string>();
  for (let i = 0; i < data.length; i += 4) {
    const key = `${data[i]}:${data[i + 1]}:${data[i + 2]}`;
    if (session.verdicts.get(key) !== data[i + 3]) {
      session.verdicts.set(key, data[i + 3]);
      touched.add(`${data[i]}:${data[i + 1]}`);
    }
  }
  for (const k of touched) {
    const [su, a] = k.split(":").map(Number);
    if (session.rendered === su) paintAyah(su, a);
  }
}

function onVerseMatch(surah: number, ayah: number) {
  if (!session.active) return;
  if (session.mode === "libre" && session.rendered !== surah) {
    const s = getSurah(surah);
    renderPassage(surah, 1, s.verses.length);
    $("r-wait").hidden = true;
  }
  const key = `${surah}:${ayah}`;
  if (!session.ayahs.includes(key)) session.ayahs.push(key);
  setCurrentAyah(surah, ayah);
  scrollToEl(ayahEl(surah, ayah)?.querySelector(".w:not(.ok)") ?? ayahEl(surah, ayah));
}

function onCandidate(msg: { candidates: { surah: number; ayah: number; confidence: number }[]; stable: boolean }) {
  if (!session.active || session.mode !== "libre" || session.rendered) return;
  const c = msg.candidates[0];
  if (!c) return;
  const s = getSurah(c.surah);
  $("r-candidate").textContent = `${msg.stable ? "Probablement" : "Peut-être"} : ${s.tr} ${c.ayah}`;
}

function onWordProgress(surah: number, ayah: number, matched: number[]) {
  if (!session.active) return;
  if (session.mode === "libre" && session.rendered !== surah) onVerseMatch(surah, ayah);
  const key = `${surah}:${ayah}`;
  let set = session.progress.get(key);
  if (!set) session.progress.set(key, (set = new Set()));
  for (const i of matched) set.add(i);
  if (!session.current || session.current.surah !== surah || session.current.ayah !== ayah) setCurrentAyah(surah, ayah);
  const el = ayahEl(surah, ayah);
  if (!el) return;
  const words = el.querySelectorAll<HTMLElement>(".w");
  let next = -1;
  words.forEach((w, i) => {
    const st = wordState(surah, ayah, i);
    const ok = set!.has(i) || st === 0 || st === 1;
    w.classList.toggle("ok", ok);
    if (!ok && next < 0) next = i;
  });
  $("r-text").querySelectorAll(".w.cur").forEach((w) => w.classList.remove("cur"));
  if (next >= 0) words[next].classList.add("cur");
  // Atelier : l'ayah est entièrement récitée -> analyse automatique après un court silence.
  if (session.atelier && session.active && surah === session.atelier.surah && ayah === session.atelier.ayah) {
    clearTimeout(session.atelier.endTimer);
    if (next < 0) session.atelier.endTimer = window.setTimeout(() => void endSession(), 1300);
  }
  scrollToEl(next >= 0 ? words[next] : words[words.length - 1]);
}

// ---------------------------------------------------------------------------
// Erreurs (mode Hifz)
// ---------------------------------------------------------------------------
const KIND: Record<CorrectionIssue["kind"], { label: string; title: string; desc: string }> = {
  possible_omission: { label: "Mot oublié ?", title: "Un mot semble manquer.", desc: "Reprends l'ayah depuis le début, avec le mot surligné." },
  possible_substitution: { label: "Mot différent ?", title: "Ce mot ne correspond pas.", desc: "Reprends l'ayah depuis le début et vérifie le mot surligné." },
  possible_vowel: { label: "Haraka ?", title: "Vérifie la voyelle de ce mot.", desc: "Reprends l'ayah et fais attention à la haraka du mot surligné." },
  possible_repetition: { label: "Mot répété", title: "Ce mot a été dit deux fois.", desc: "Reprends l'ayah en disant le mot une seule fois." },
  possible_skipped_ayah: { label: "Ayah sautée ?", title: "Cette ayah semble sautée.", desc: "Récite-la avant de continuer." },
  unclear_ayah: { label: "Ayah non suivie", title: "Je n'ai pas pu suivre cette ayah.", desc: "Récite-la depuis le début, à rythme régulier." },
};

function issueWords(issue: CorrectionIssue): string[] {
  return ayahWords(getSurah(issue.surah).verses[issue.ayah - 1]).words;
}

function onCorrection(state: CorrectionState, totalWords: number) {
  session.correction = state;
  if (session.atelier) { if (state.phase !== "idle") worker?.postMessage({ type: "correction_action", action: "dismiss" }); return; }
  if (!session.active || session.mode !== "hifz") {
    if (state.phase !== "idle") worker?.postMessage({ type: "correction_action", action: "close" });
    return;
  }
  if (state.phase === "idle" || !state.issue) {
    closeSheet();
    return;
  }
  const issue = state.issue;
  const words = issueWords(issue);
  const wholeAyah = issue.kind === "possible_skipped_ayah" || issue.kind === "unclear_ayah";
  // Si l'index du moteur ne correspond pas au texte affiché : on s'abstient.
  if (words.length !== totalWords || (!wholeAyah && !words[issue.word])) {
    worker?.postMessage({ type: "correction_action", action: "close" });
    return;
  }
  if (state.phase === "error") {
    const id = `${issue.surah}:${issue.ayah}:${issue.word}:${issue.kind}`;
    if (!session.mistakes.some((m) => `${m.surah}:${m.ayah}:${m.word}:${m.kind}` === id)) {
      session.mistakes.push({
        surah: issue.surah, ayah: issue.ayah, word: issue.word, kind: issue.kind,
        text: wholeAyah ? `Ayah ${issue.ayah}` : words[issue.word], corrected: false,
      });
    }
    if (wholeAyah) ayahEl(issue.surah, issue.ayah)?.querySelectorAll(".w").forEach((w) => w.classList.add("err"));
    else wordEl(issue.surah, issue.ayah, issue.word)?.classList.add("err");
    vibrate();
  }
  if (state.phase === "corrected") {
    const m = session.mistakes.find((x) => x.surah === issue.surah && x.ayah === issue.ayah && x.word === issue.word);
    if (m) m.corrected = true;
    ayahEl(issue.surah, issue.ayah)?.querySelectorAll(".w.err").forEach((w) => w.classList.add("fixed"));
  }
  openSheet(state, words);
}

function vibrate() {
  try { navigator.vibrate?.(80); } catch { /* */ }
}

function openSheet(state: CorrectionState, words: string[]) {
  const issue = state.issue!;
  const k = KIND[issue.kind];
  const wholeAyah = issue.kind === "possible_skipped_ayah" || issue.kind === "unclear_ayah";
  const sheet = $<HTMLDialogElement>("sheet");
  sheet.dataset.phase = state.phase;
  $("sheet-kind").textContent = state.phase === "retrying" ? "À toi · micro actif" : state.phase === "corrected" ? "Corrigé ✓" : `${k.label} · ayah ${issue.ayah}`;
  const verse = $("sheet-verse");
  verse.replaceChildren();
  words.forEach((w, i) => {
    const s = document.createElement("span");
    s.textContent = w;
    if (wholeAyah || i === issue.word) s.className = "hl";
    // En mode caché, on ne montre que la partie déjà récitée et le mot en cause.
    if (session.hide && !session.showAll && !wholeAyah && i > issue.word) s.className = "blur";
    verse.append(s, " ");
  });
  $("sheet-title").textContent = state.phase === "retrying" ? "Prends ton temps." : state.phase === "corrected" ? "C'est corrigé." : k.title;
  $("sheet-desc").textContent = state.phase === "retrying"
    ? `Récite l'ayah ${issue.ayah} depuis le début. Je vérifie à nouveau.`
    : state.phase === "corrected" ? "Tu peux reprendre là où tu étais." : k.desc;
  const p = $<HTMLButtonElement>("sheet-primary");
  const s2 = $<HTMLButtonElement>("sheet-secondary");
  const set = (b: HTMLButtonElement, action: CorrectionAction, label: string) => { b.dataset.action = action; b.textContent = label; };
  if (state.phase === "retrying") { set(p, "stop_retry", "Arrêter l'essai"); set(s2, "review_later", "Revoir plus tard"); }
  else if (state.phase === "corrected") { set(p, "continue", "Continuer la récitation"); set(s2, "retry", "Encore une fois"); }
  else { set(p, "retry", "Reprendre l'ayah"); set(s2, "dismiss", "C'était correct"); }
  if (!sheet.open) sheet.show();
}

function closeSheet() {
  const sheet = $<HTMLDialogElement>("sheet");
  if (sheet.open) sheet.close();
}

function sheetAction(action: CorrectionAction) {
  const issue = session.correction?.issue;
  if (action === "dismiss" && issue) {
    session.mistakes = session.mistakes.filter((m) => !(m.surah === issue.surah && m.ayah === issue.ayah && m.word === issue.word && m.kind === issue.kind));
    ayahEl(issue.surah, issue.ayah)?.querySelectorAll(".w.err").forEach((w) => w.classList.remove("err"));
  }
  worker?.postMessage({ type: "correction_action", action });
}

// ---------------------------------------------------------------------------
// Indice / afficher
// ---------------------------------------------------------------------------
function giveHint() {
  if (session.mode !== "hifz" || !session.surah) return;
  const ayah = session.current?.ayah ?? session.from;
  for (let a = ayah; a <= session.to; a++) {
    const el = ayahEl(session.surah, a);
    const w = el?.querySelector<HTMLElement>(".w:not(.ok):not(.hint):not(.miss):not(.bad)");
    if (w) {
      w.classList.add("hint");
      session.hints++;
      scrollToEl(w, true);
      return;
    }
  }
}

function toggleShowAll() {
  session.showAll = !session.showAll;
  $("r-text").classList.toggle("hidden-text", session.display === "hidden" && !session.showAll);
  $("r-text").classList.toggle("peek-text", session.display === "peek" && !session.showAll);
  $("btn-toggle-hide").textContent = session.showAll ? "Cacher" : "Afficher";
}

// ---------------------------------------------------------------------------
// Bilan et historique
// ---------------------------------------------------------------------------
const KIND_SHORT: Record<string, string> = {
  possible_omission: "oublié", possible_substitution: "différent", possible_vowel: "haraka",
  possible_repetition: "répété", possible_skipped_ayah: "ayah sautée", unclear_ayah: "ayah non suivie",
};

function rangeLabel(r: SessionRecord): string {
  if (!r.surah) return "Aucune ayah reconnue";
  const s = getSurah(r.surah);
  const range = r.from && r.to ? (r.from === r.to ? ` · ayah ${r.from}` : ` · ayahs ${r.from}–${r.to}`) : "";
  return `${s.tr}${range}`;
}

let lastRecord: SessionRecord | null = null;
function renderSummary(r: SessionRecord) {
  lastRecord = r;
  const missed = r.missed ?? [];
  $("sum-time").textContent = fmtTime(r.durationSec);
  $("sum-ayahs").textContent = String(r.ayahs.length);
  $("sum-valid").textContent = r.total ? `${r.validated}/${r.total}` : "0";
  $("sum-review").textContent = String(missed.length + r.mistakes.length);
  $("sum-range").textContent = rangeLabel(r) + (r.hints ? ` · ${r.hints} indice${r.hints > 1 ? "s" : ""}` : "");
  const list = $("sum-list");
  list.replaceChildren();
  if (!missed.length && !r.mistakes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = r.total ? "Tous les mots ont été validés. Bārak Allāhu fīk." : "Aucun mot reconnu pendant cette séance.";
    list.append(li);
  }
  const add = (ref: string, word: string, kind: string, cls: string) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="m-ref"></span><span class="m-word" lang="ar" dir="rtl"></span><span class="m-kind ${cls}"></span>`;
    li.querySelector(".m-ref")!.textContent = ref;
    li.querySelector(".m-word")!.textContent = word;
    li.querySelector(".m-kind")!.textContent = kind;
    list.append(li);
  };
  for (const m of r.mistakes) add(`${m.surah}:${m.ayah}`, m.text, (KIND_SHORT[m.kind] ?? m.kind) + (m.corrected ? " · corrigé" : ""), m.corrected ? "ok" : "");
  for (const m of missed.slice(0, 60)) add(`${m.surah}:${m.ayah}`, m.text, m.kind === "bad" ? "mot faux ?" : "non reconnu", m.kind === "bad" ? "" : "warn");
  $("btn-again").textContent = r.mode === "hifz" ? "Recommencer ce passage" : r.mode === "test" ? "Refaire un test" : "Réviser ce passage en Hifz";
  $("btn-again").hidden = !r.surah;
  renderTestSummary(r);
  $("btn-diag").hidden = !lastDiag || !lastDiag.audio.length;
  renderTajwidBox(r);
}

// ---------------------------------------------------------------------------
// Analyse tajwid (serveur Quran Muaalem, facultatif)
// ---------------------------------------------------------------------------
const CAT_FR: Record<string, string> = { harf: "lettre", haraka: "haraka", tajwid: "tajwid", mot: "mot oublié", sifa: "qualité de lettre" };

function renderTajwidList(errors: TajwidError[] | SessionRecord["tajwid"]) {
  const list = $("tajwid-list");
  list.replaceChildren();
  for (const e of errors ?? []) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="m-ref"></span><span class="m-word" lang="ar" dir="rtl"></span><span class="m-kind t-msg"></span>`;
    li.querySelector(".m-ref")!.textContent = `${e.surah}:${e.ayah}`;
    li.querySelector(".m-word")!.textContent = e.word_text;
    li.querySelector(".m-kind")!.textContent = `${CAT_FR[e.category] ?? e.category} · ${e.message}`;
    list.append(li);
  }
}

function renderTajwidBox(r: SessionRecord) {
  const url = loadPrefs().tajwidUrl;
  const info = $("tajwid-info");
  const btn = $<HTMLButtonElement>("btn-tajwid");
  btn.disabled = false;
  btn.textContent = "Lancer l'analyse tajwid";
  renderTajwidList(r.tajwid);
  void countFor(r.id).then((n) => {
    if (!n || lastRecord?.id !== r.id) return;
    info.textContent = (r.tajwid?.length ? `${r.tajwid.length} point(s) à revoir. ` : "") + `${n} ayah${n > 1 ? "s" : ""} en attente : analysée${n > 1 ? "s" : ""} automatiquement dès que tu seras en ligne.`;
    btn.hidden = true;
  });
  if (r.tajwid) {
    info.textContent = r.tajwid.length ? `${r.tajwid.length} point${r.tajwid.length > 1 ? "s" : ""} à revoir (modèle Quran Muaalem).` : "Aucune erreur de lettre, de haraka ou de tajwid détectée.";
    btn.hidden = true;
    return;
  }
  if (!url) {
    info.textContent = "Analyse lettre par lettre (harf, harakat, madd, ghunna…) : le serveur tajwid n'est pas encore installé. Elle s'activera toute seule.";
    btn.hidden = true;
    return;
  }
  const canRun = !!lastDiag && lastDiag.record.id === r.id && lastDiag.audio.length > 0;
  info.textContent = canRun ? "Envoie l'audio de cette séance au serveur pour repérer les fautes de lettres, de harakat et de tajwid." : "L'audio de cette séance n'est plus disponible.";
  btn.hidden = !canRun;
}

async function runTajwid() {
  const url = loadPrefs().tajwidUrl;
  const d = lastDiag;
  if (!url || !d) return;
  const btn = $<HTMLButtonElement>("btn-tajwid");
  btn.disabled = true;
  btn.textContent = "Connexion au serveur…";
  if (!(await checkServer(url))) {
    toast("Serveur tajwid injoignable. Il démarre peut-être : réessaie dans une minute.", 5000);
    btn.disabled = false;
    btn.textContent = "Réessayer l'analyse";
    return;
  }
  const segs = buildSegments(d.audio, d.ayahAt);
  if (!segs.length) { toast("Rien à analyser dans cette séance."); btn.disabled = false; return; }
  const res = await analyzeSession(url, d.audio, segs, (k, n) => { btn.textContent = `Analyse… ${k}/${n}`; });
  d.record.tajwid = res.errors.map((e) => ({ surah: e.surah, ayah: e.ayah, word: e.word, word_text: e.word_text, category: e.category, message: e.message }));
  updateSession(d.record.id, { tajwid: d.record.tajwid });
  if (res.failed) toast(`${res.failed} segment${res.failed > 1 ? "s" : ""} non analysé${res.failed > 1 ? "s" : ""} (serveur).`, 4000);
  renderTajwidBox(d.record);
  renderHistory();
}

function renderHistory() {
  const list = $("history");
  list.replaceChildren();
  const all = loadHistory();
  $("btn-clear").hidden = !all.length;
  if (!all.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Pas encore de séance. Bismillah !";
    list.append(li);
    return;
  }
  for (const r of all.slice(0, 15)) {
    const li = document.createElement("li");
    const d = new Date(r.date);
    const when = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    li.innerHTML = `<div><strong></strong><span class="muted"></span></div><div class="h-right"><span class="tag ${r.mode}">${r.mode === "hifz" ? "Hifz" : "Libre"}</span><span class="muted"></span></div>`;
    li.querySelector("strong")!.textContent = rangeLabel(r);
    li.querySelectorAll(".muted")[0].textContent = `${when} · ${fmtTime(r.durationSec)}`;
    li.querySelectorAll(".muted")[1].textContent = r.total ? `${r.validated}/${r.total} mots` : `${r.ayahs.length} ayahs`;
    if (r.surah) li.addEventListener("click", () => openSetup(r.surah!, r.from ?? 1, r.to ?? getSurah(r.surah!).verses.length));
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// Choix du passage
// ---------------------------------------------------------------------------
let surahs: Surah[] = [];

function fillSetup() {
  const sel = $<HTMLSelectElement>("sel-surah");
  sel.replaceChildren(...surahs.map((s) => {
    const o = document.createElement("option");
    o.value = String(s.n);
    o.textContent = `${s.n}. ${s.tr} · ${s.ar} (${s.verses.length})`;
    return o;
  }));
}

function openSetup(surah?: number, from?: number, to?: number) {
  const p = loadPrefs();
  if (p.tajwidUrl && p.liveTajwid && navigator.onLine) void checkServer(p.tajwidUrl, 45000); // réveil du serveur
  const s = surah ?? p.surah;
  const max = getSurah(s).verses.length;
  $<HTMLSelectElement>("sel-surah").value = String(s);
  $<HTMLInputElement>("in-from").value = String(Math.min(from ?? (surah ? 1 : p.from), max));
  $<HTMLInputElement>("in-to").value = String(Math.min(to ?? (surah ? max : p.to), max));
  $<HTMLSelectElement>("sel-display").value = p.display;
  $<HTMLInputElement>("chk-live-tajwid").checked = p.liveTajwid;
  $<HTMLSelectElement>("sel-tj-engine").value = p.tajwidEngine;
  $<HTMLInputElement>("chk-filters").checked = p.phoneFilters;
  $<HTMLInputElement>("chk-sensitive").checked = p.sensitive;
  $<HTMLInputElement>("chk-verify").checked = p.verify;
  $<HTMLInputElement>("in-tajwid").value = customServer();
  $<HTMLInputElement>("in-tajwid").placeholder = getDefaultServer() ? "Automatique (serveur Murattil)" : "https://…modal.run";
  updateSetup();
  show("setup");
}

function readSetup() {
  const surah = Number($<HTMLSelectElement>("sel-surah").value) || 1;
  const max = getSurah(surah).verses.length;
  let from = Math.max(1, Math.min(max, Number($<HTMLInputElement>("in-from").value) || 1));
  let to = Math.max(1, Math.min(max, Number($<HTMLInputElement>("in-to").value) || max));
  if (to < from) [from, to] = [to, from];
  return { surah, from, to, max, display: $<HTMLSelectElement>("sel-display").value as "hidden" | "peek" | "visible", liveTajwid: $<HTMLInputElement>("chk-live-tajwid").checked, tajwidEngine: $<HTMLSelectElement>("sel-tj-engine").value as "auto" | "mini" | "server", phoneFilters: $<HTMLInputElement>("chk-filters").checked, sensitive: $<HTMLInputElement>("chk-sensitive").checked, verify: $<HTMLInputElement>("chk-verify").checked, tajwidUrl: $<HTMLInputElement>("in-tajwid").value.trim() };
}

function updateSetup() {
  const { surah, from, to, max } = readSetup();
  $<HTMLInputElement>("in-from").max = String(max);
  $<HTMLInputElement>("in-to").max = String(max);
  const v = getSurah(surah).verses[from - 1];
  const words = ayahWords(v).words.slice(0, 4).join(" ");
  $("setup-preview").textContent = `${words} …`;
  $("setup-preview").title = `Début de l'ayah ${from}`;
  $("btn-start-hifz").textContent = `Commencer · ${to - from + 1} ayah${to > from ? "s" : ""}`;
}


// ---------------------------------------------------------------------------
// Tajwid en direct (serveur Quran Muaalem) + file d'attente hors ligne
// ---------------------------------------------------------------------------
const tjInflight = new Set<Promise<void>>();
let tjChain: Promise<void> = Promise.resolve();
function trackTj(p: Promise<void>): Promise<void> {
  tjInflight.add(p);
  void p.finally(() => tjInflight.delete(p));
  return p;
}

function tjBar() {
  const bar = $("tj-bar");
  const st = session.tjLive;
  bar.hidden = st === "off";
  bar.className = "tj-bar " + (st === "on" ? "on" : st === "wait" ? "wait" : "");
  const n = session.tjAnalyzed.size, e = [...session.tjErrors.values()].reduce((s, x) => s + x.length, 0);
  const where = session.tjEngine === "mini" ? "sur le téléphone" : "serveur";
  bar.textContent = st === "checking" ? (session.tjEngine === "mini" ? `Tajwid sur le téléphone : préparation du modèle${miniPct ? ` (${miniPct} %)` : ""}…` : "Tajwid en direct : connexion au serveur…")
    : st === "on" ? `Tajwid en direct (${where}) · ${n} ayah${n > 1 ? "s" : ""} analysée${n > 1 ? "s" : ""}${e ? ` · ${e} point${e > 1 ? "s" : ""} à revoir` : ""}`
    : `Tajwid : hors ligne, ${session.tjPending.length} ayah${session.tjPending.length > 1 ? "s" : ""} en attente (analysées plus tard)`;
}

let tjCheck: Promise<boolean> = Promise.resolve(false);
let tjRetry: number | undefined;
function startLiveTajwid(force?: "server") {
  const p = loadPrefs();
  clearInterval(tjRetry);
  // Moteur (auto) : muaalem-mini s'il est prêt (hors ligne, sans attente) ; sinon le serveur ;
  // sinon le mini en cours de chargement.
  if (force) session.tjEngine = force;
  else if (p.tajwidEngine !== "auto") session.tjEngine = p.tajwidEngine;
  else session.tjEngine = miniState === "ready" ? "mini" : p.tajwidUrl ? "server" : miniState === "loading" ? "mini" : "server";
  if (!p.liveTajwid) { session.tjLive = "off"; tjBar(); return; }
  if (session.tjEngine === "mini") { session.tjLive = miniState === "ready" ? "on" : "checking"; tjBar(); return; }
  session.tjLive = p.tajwidUrl ? "checking" : "off";
  tjBar();
  if (session.tjLive === "off") return;
  // Le premier appel réveille aussi le serveur (démarrage à froid jusqu'à ~40 s sur GPU serverless).
  tjCheck = checkServer(p.tajwidUrl, 45000).then((ok) => {
    if (session.tjLive !== "off") { session.tjLive = ok && navigator.onLine ? "on" : "wait"; tjBar(); }
    return ok;
  });
  // Hors ligne ou serveur indisponible : on réessaie toutes les 30 s et on rattrape les ayahs en attente.
  tjRetry = window.setInterval(async () => {
    if (!session.active) { clearInterval(tjRetry); return; }
    if (session.tjLive !== "wait" || !navigator.onLine) return;
    if (!(await checkServer(p.tajwidUrl, 15000))) return;
    session.tjLive = "on";
    const late = session.tjPending.splice(0);
    for (const it of late) void trackTj(sendTajwid(it.surah, it.from, it.wav));
    tjBar();
  }, 30000);
}

/** Met une ayah de côté ; si la séance est déjà enregistrée, directement dans la file persistante. */
function park(surah: number, ayah: number, blob: Blob) {
  if (!session.active && session.recId) void enqueue({ sessionId: session.recId, surah, from: ayah, to: ayah, wav: blob, createdAt: Date.now() });
  else session.tjPending.push({ surah, from: ayah, to: ayah, wav: blob });
  tjBar();
}

function sendTajwid(surah: number, ayah: number, blob: Blob): Promise<void> {
  if (session.tjEngine === "mini") return sendMini(surah, ayah, blob).then((r) => { if (r) applyTajwid(r.analyzed, r.errors); });
  const url = loadPrefs().tajwidUrl;
  const job = tjChain.then(async () => {
    if (session.tjLive === "checking") await tjCheck;
    if (session.tjLive !== "on" || !navigator.onLine) { park(surah, ayah, blob); return; }
    try {
      const res = await analyzeOne(url, blob, surah, ayah, ayah, 30000);
      applyTajwid(res.analyzed, res.errors);
      if (!session.active && session.recId && res.errors.length) {
        // Résultat arrivé après l'enregistrement de la séance : on complète l'historique.
        const rec = loadHistory().find((r) => r.id === session.recId);
        const add = res.errors.map((e) => ({ surah: e.surah, ayah: e.ayah, word: e.word, word_text: e.word_text, category: e.category, message: e.message }));
        if (rec) updateSession(rec.id, { tajwid: [...(rec.tajwid ?? []), ...add] });
      }
    } catch {
      session.tjLive = "wait";
      park(surah, ayah, blob);
    }
  });
  tjChain = job.catch(() => undefined);
  return job;
}

/** Envoie l'ayah au serveur dès qu'elle est terminée ; hors ligne, elle est mise de côté. */
function scheduleTajwid(surah: number, ayah: number, endAt?: number): Promise<void> {
  if (session.tjLive === "off") return Promise.resolve();
  const key = `${surah}:${ayah}`;
  if (session.tjAsked.has(key)) return Promise.resolve();
  const seg = segmentForAyah(session.audio, session.audioLen / 16000, session.ayahAt, surah, ayah, endAt);
  if (!seg) return Promise.resolve();
  session.tjAsked.add(key);
  return sendTajwid(surah, ayah, wav(session.audio, seg.t0, seg.t1));
}

function applyTajwid(analyzed: string[], errors: TajwidError[]) {
  for (const k of analyzed) session.tjAnalyzed.add(k);
  for (const e of errors) {
    const key = `${e.surah}:${e.ayah}:${e.word}`;
    const list = session.tjErrors.get(key) ?? [];
    list.push(e);
    session.tjErrors.set(key, list);
    const el = wordEl(e.surah, e.ayah, e.word);
    if (el) { el.classList.add("tj", `tj-${e.category}`); }
  }
  if (errors.length && session.mode === "hifz" && session.active) vibrate();
  tjBar();
}

function showWordTajwid(target: HTMLElement) {
  const w = target.closest<HTMLElement>(".w.tj");
  const a = w?.closest<HTMLElement>(".ayah");
  if (!w || !a || !session.rendered) return false;
  const list = session.tjErrors.get(`${session.rendered}:${a.dataset.a}:${w.dataset.w}`) ?? [];
  if (!list.length) return false;
  toast(list.map((e) => e.message).join(" · "), 5000);
  return true;
}

let queueRunning = false;
/** Analyse les ayahs mises de côté dès qu'une connexion est disponible (même plusieurs jours après). */
async function processQueue() {
  const url = loadPrefs().tajwidUrl;
  if (queueRunning || !url || !navigator.onLine) return;
  const items = await pendingSegments();
  if (!items.length) return;
  queueRunning = true;
  try {
    if (!(await checkServer(url))) return;
    for (const it of items) {
      try {
        const res = await analyzeOne(url, it.wav, it.surah, it.from, it.to, 60000);
        const rec = loadHistory().find((r) => r.id === it.sessionId);
        if (rec) {
          const add = res.errors.map((e) => ({ surah: e.surah, ayah: e.ayah, word: e.word, word_text: e.word_text, category: e.category, message: e.message }));
          updateSession(rec.id, { tajwid: [...(rec.tajwid ?? []), ...add] });
          if (lastRecord?.id === rec.id) { lastRecord.tajwid = [...(lastRecord.tajwid ?? []), ...add]; }
        }
        if (it.id !== undefined) await removeSegment(it.id);
      } catch {
        break; // serveur indisponible : on réessaiera plus tard
      }
    }
  } finally {
    queueRunning = false;
    if (lastRecord && document.body.dataset.screen === "summary") renderTajwidBox(lastRecord);
    renderHistory();
  }
}

// ---------------------------------------------------------------------------
// muaalem-mini sur le téléphone
// ---------------------------------------------------------------------------
let mini: Worker | null = null;
let miniThreads = 1;
let miniState: "off" | "absent" | "loading" | "ready" | "error" = "off";
let miniPct = 0;
let miniId = 0;
const miniJobs = new Map<number, (r: { analyzed: number[]; errors: TajwidError[]; ms?: number } | null) => void>();

function startMini() {
  if (mini || loadPrefs().tajwidEngine === "server") return;
  mini = new Worker(new URL("./mini/mini-worker.ts", import.meta.url), { type: "module" });
  miniState = "loading";
  mini.onmessage = (e) => {
    const m = e.data;
    if (m.type === "absent") { miniState = "absent"; mini?.terminate(); mini = null; onMiniChange(); }
    else if (m.type === "loading") { miniPct = m.percent; if (session.active) tjBar(); }
    else if (m.type === "ready") { miniState = "ready"; miniThreads = m.threads ?? 1; logEvent({ type: "mini-ready", threads: miniThreads, isolated: self.crossOriginIsolated }); onMiniChange(); }
    else if (m.type === "error") { console.warn("muaalem-mini :", m.message); miniState = "error"; mini?.terminate(); mini = null; onMiniChange(); }
    else if (m.type === "result") {
      const cb = miniJobs.get(m.id);
      miniJobs.delete(m.id);
      if (m.error) console.warn("muaalem-mini :", m.error);
      logEvent({ type: "mini", ms: m.ms, predicted: m.predicted });
      const ay = (m.ayahs ?? []) as { ayah: number; errors: TajwidError[] }[];
      cb?.(m.skipped ? null : { analyzed: ay.map((a) => a.ayah), errors: ay.flatMap((a) => a.errors), ms: m.ms });
    }
  };
  mini.onerror = () => { miniState = "error"; mini?.terminate(); mini = null; onMiniChange(); };
  mini.postMessage({ type: "init", base: BASE });
}

function onMiniChange() {
  if (!session.active || session.tjEngine !== "mini") return;
  if (miniState === "ready") { session.tjLive = "on"; const late = session.tjPending.splice(0); for (const it of late) void trackTj(sendTajwid(it.surah, it.from, it.wav)); }
  else if (miniState !== "loading") {
    // Mini indisponible : repli sur le serveur s'il est configuré.
    startLiveTajwid("server");
    return;
  }
  tjBar();
}

/** Analyse d'une ayah par muaalem-mini (null si le modèle n'est pas prêt). */
async function sendMini(surah: number, ayah: number, blob: Blob): Promise<{ analyzed: string[]; errors: TajwidError[]; ms?: number } | null> {
  if (!mini || miniState !== "ready") { park(surah, ayah, blob); return null; }
  const buf = await blob.arrayBuffer();
  const pcm16 = new Int16Array(buf, 44);
  const samples = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) samples[i] = pcm16[i] / 32768;
  const words: Record<number, string[]> = { [ayah]: ayahWords(getSurah(surah).verses[ayah - 1]).words };
  const id = ++miniId;
  return new Promise((resolve) => {
    miniJobs.set(id, (r) => {
      if (!r) { resolve(null); return; }
      resolve({ analyzed: r.analyzed.map((a) => `${surah}:${a}`), errors: r.errors, ms: r.ms });
    });
    mini!.postMessage({ type: "job", id, samples, surah, from: ayah, to: ayah, words }, [samples.buffer]);
  });
}

// ---------------------------------------------------------------------------
// Atelier tajwid : une ayah à la fois, analyse fine (Muaalem complet en ligne, mini sinon)
// ---------------------------------------------------------------------------
function openAtelierSetup() {
  const sel = $<HTMLSelectElement>("at-surah");
  if (!sel.options.length) for (const s of surahs) { const o = document.createElement("option"); o.value = String(s.n); o.textContent = `${s.n}. ${s.tr} · ${s.ar}`; sel.append(o); }
  sel.value = String(loadPrefs().surah);
  const p = loadPrefs();
  const online = !!p.tajwidUrl && navigator.onLine;
  $("at-engine").textContent = online
    ? "Analyse par le serveur Muaalem complet (lettres, harakat, madd, ghunna et sifat : tafkhim, qalqala…)."
    : miniState === "loading" ? "Chargement du modèle mini sur le téléphone… (une seule fois)"
    : miniState === "ready" ? "Hors ligne : analyse par muaalem-mini sur le téléphone (lettres, harakat, madd ; pas les sifat)."
    : "Pas de serveur ni de modèle mini : les ayahs seront gardées et analysées dès que possible.";
  if (online) void checkServer(p.tajwidUrl, 45000); // réveil du serveur pendant le choix
  show("atelier-setup");
}

function startAtelierAyah(surah: number, ayah: number) {
  session.test = null;
  session.atelier = { surah, ayah };
  const s = getSurah(surah);
  void startSession("hifz", surah, ayah, ayah, { atelier: true, title: `Atelier · ${s.tr} ${ayah}` }).then(() => {
    if (session.active) session.atelier = { surah, ayah };
  });
}

let atelierAudioUrl = "";
async function showAtelierResult(rec: SessionRecord) {
  const at = session.atelier!;
  const s = getSurah(at.surah);
  const words = ayahWords(s.verses[at.ayah - 1]).words;
  $("at-title").textContent = `${s.tr} · ayah ${at.ayah}`;
  const verse = $("at-verse");
  verse.replaceChildren(...words.flatMap((w, i) => { const sp = document.createElement("span"); sp.className = "w"; sp.dataset.w = String(i); sp.textContent = w; return [sp, document.createTextNode(" ")]; }));
  $("at-list").replaceChildren();
  $("at-score").textContent = "";
  $("at-status").textContent = "Analyse en cours…";
  // Audio : ma récitation + récitateur de référence (Alafasy, EveryAyah)
  if (atelierAudioUrl) URL.revokeObjectURL(atelierAudioUrl);
  // On garde seulement l'ayah (du début de la récitation entendue à la fin), sans le blanc avant.
  const end = session.audioLen / 16000;
  const seg = segmentForAyah(session.audio, end, session.ayahAt, at.surah, at.ayah, end);
  const blob = wav(session.audio, seg?.t0 ?? 0, end);
  atelierAudioUrl = URL.createObjectURL(blob);
  $<HTMLAudioElement>("at-mine").src = atelierAudioUrl;
  $<HTMLAudioElement>("at-qari").src = `https://everyayah.com/data/Alafasy_128kbps/${String(at.surah).padStart(3, "0")}${String(at.ayah).padStart(3, "0")}.mp3`;
  $("at-next").hidden = at.ayah >= s.verses.length;
  show("atelier");

  const p = loadPrefs();
  let errors: TajwidError[] | null = null;
  let engine = "";
  let covered = true;
  if (p.tajwidUrl && navigator.onLine) {
    try {
      const r = await analyzeOne(p.tajwidUrl, blob, at.surah, at.ayah, at.ayah, 90000, true);
      errors = r.errors; engine = "Muaalem complet (serveur)"; covered = r.analyzed.length > 0;
    } catch { /* repli ci-dessous */ }
  }
  if (!errors && miniState === "ready") {
    const r = await sendMini(at.surah, at.ayah, blob);
    if (r) { errors = r.errors; engine = `muaalem-mini (téléphone, ${((r.ms ?? 0) / 1000).toFixed(1)} s)`; covered = r.analyzed.length > 0; }
  }
  if (!errors) {
    await enqueue({ sessionId: rec.id, surah: at.surah, from: at.ayah, to: at.ayah, wav: blob, createdAt: Date.now() });
    $("at-status").textContent = "Analyse impossible pour l'instant (hors ligne). L'ayah est gardée et sera analysée dès que possible.";
    return;
  }
  if (!covered) {
    $("at-status").textContent = `Je n'ai pas reconnu assez de l'ayah pour juger (${engine}). Recommence plus près du micro, sans bruit autour.`;
    return;
  }
  const list = errors.map((e) => ({ surah: e.surah, ayah: e.ayah, word: e.word, word_text: e.word_text, category: e.category, message: e.message }));
  updateSession(rec.id, { tajwid: list });
  const bad = new Set(errors.map((e) => e.word));
  const score = Math.round((100 * (words.length - bad.size)) / words.length);
  $("at-score").textContent = `${score} %`;
  $("at-score").className = "pill " + (score >= 90 ? "ok" : score >= 60 ? "warn" : "bad");
  $("at-status").textContent = errors.length ? `${errors.length} point${errors.length > 1 ? "s" : ""} à travailler · analyse : ${engine}` : `Aucune faute détectée. Bārak Allāhu fīk. · analyse : ${engine}`;
  for (const e of errors) verse.querySelector(`.w[data-w="${e.word}"]`)?.classList.add("tj", `tj-${e.category}`);
  const ul = $("at-list");
  for (const e of errors) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="m-ref"></span><span class="m-word" lang="ar" dir="rtl"></span><span class="m-kind t-msg"></span>`;
    li.querySelector(".m-ref")!.textContent = CAT_FR[e.category] ?? e.category;
    li.querySelector(".m-word")!.textContent = e.word_text;
    li.querySelector(".m-kind")!.textContent = e.message;
    ul.append(li);
  }
}

// ---------------------------------------------------------------------------
// Test de mémoire
// ---------------------------------------------------------------------------
function openTestSetup() {
  const mem = loadPrefs().memorized;
  const sel = $<HTMLSelectElement>("test-scope");
  sel.replaceChildren();
  const add = (v: string, t: string) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); };
  if (mem.length) add("mem", `Mes sourates mémorisées (${mem.length})`);
  add("30", "Juz 'Amma (78 à 114)");
  add("29", "Juz Tabarak (67 à 77)");
  for (const s of surahs) add(String(-s.n), `${s.n}. ${s.tr}`);
  show("test");
}

function scopeSurahs(v: string): number[] {
  if (v === "mem") return loadPrefs().memorized;
  if (v === "30") return Array.from({ length: 37 }, (_, i) => 78 + i);
  if (v === "29") return Array.from({ length: 11 }, (_, i) => 67 + i);
  return [-Number(v)];
}

function nextTestQuestion() {
  const t = session.test;
  if (!t) return;
  const q = pickTestQuestion(t.scope, (s) => getSurah(s).verses.length, t.len, t.asked);
  if (!q) { toast("Plus de question disponible."); return; }
  t.asked.add(`${q.surah}:${q.from}`);
  t.idx++;
  const words = ayahWords(getSurah(q.surah).verses[q.from - 1]).words.length;
  void startSession("hifz", q.surah, q.from, q.to, { cue: Math.min(3, Math.max(1, words - 1)), title: `Test · question ${t.idx}/${t.count}` });
}

function renderTestSummary(r: SessionRecord) {
  const t = session.test;
  const next = $("btn-next-q");
  if (r.mode !== "test" || !t) { next.hidden = true; return; }
  const done = t.results.length >= t.count;
  next.hidden = done;
  next.textContent = `Question suivante (${t.results.length + 1}/${t.count})`;
  $("btn-again").hidden = !done;
  const s = getSurah(r.surah ?? 1);
  $("sum-range").textContent = `Question ${t.results.length}/${t.count} : ${s.tr} ${r.from}${r.to !== r.from ? "–" + r.to : ""}`;
  if (done) {
    const v = t.results.reduce((a, x) => a + x.validated, 0), tot = t.results.reduce((a, x) => a + x.total, 0);
    const score = tot ? Math.round((100 * v) / tot) : 0;
    $("sum-range").textContent = `Test terminé : ${score} % des mots retrouvés sur ${t.count} questions`;
    const list = $("sum-list");
    list.replaceChildren();
    for (const x of t.results) {
      const li = document.createElement("li");
      const pct = x.total ? Math.round((100 * x.validated) / x.total) : 0;
      li.innerHTML = `<span class="m-ref"></span><span class="m-word"></span><span class="m-kind ${pct >= 90 ? "ok" : pct >= 60 ? "warn" : ""}"></span>`;
      li.querySelector(".m-ref")!.textContent = `${x.surah}:${x.from}`;
      li.querySelector(".m-word")!.textContent = getSurah(x.surah).tr;
      li.querySelector(".m-kind")!.textContent = `${pct} %${x.hints ? ` · ${x.hints} indice${x.hints > 1 ? "s" : ""}` : ""}`;
      list.append(li);
    }
  }
}

// ---------------------------------------------------------------------------
// Accueil : régularité, révision du jour ; Ma mémorisation ; Points faibles
// ---------------------------------------------------------------------------
const JUZ_STARTS: [number, number][] = [[1,1],[2,142],[2,253],[3,93],[4,24],[4,148],[5,82],[6,111],[7,88],[8,41],[9,93],[11,6],[12,53],[15,1],[17,1],[18,75],[21,1],[23,1],[25,21],[27,56],[29,46],[33,31],[36,28],[39,32],[41,47],[46,1],[51,31],[58,1],[67,1],[78,1]];
function juzOf(surah: number): number {
  let j = 1;
  JUZ_STARTS.forEach(([s, a], i) => { if (s < surah || (s === surah && a === 1)) j = i + 1; });
  return j;
}

function memoStatuses(): UnitStatus[] {
  const hist = loadHistory();
  return units(loadPrefs().memorized, (s) => getSurah(s).verses.length, (s) => getSurah(s).tr).map((u) => unitStatus(u, hist));
}

const ago = (ms: number | null) => {
  if (ms === null) return "jamais révisé";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d <= 0 ? "révisé aujourd'hui" : d === 1 ? "révisé hier" : `révisé il y a ${d} j`;
};
const STRENGTH_FR = { fort: "Fort", moyen: "Moyen", fragile: "Fragile", nouveau: "Nouveau" };

function renderHome() {
  const hist = loadHistory();
  const st = streakDays(hist), min = minutesThisWeek(hist);
  $("streak").textContent = hist.length ? `Régularité : ${st} jour${st > 1 ? "s" : ""} d'affilée · ${min} min cette semaine` : "";
  const list = $("due-list");
  list.replaceChildren();
  const mem = loadPrefs().memorized;
  if (!mem.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Coche d'abord les sourates que tu connais dans « Ma mémorisation » : l'app planifiera leur révision.";
    list.append(li);
    return;
  }
  const due = dueToday(memoStatuses());
  if (!due.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Rien à réviser aujourd'hui. Tu peux faire un test de mémoire.";
    list.append(li);
    return;
  }
  for (const u of due.slice(0, 4)) {
    const li = document.createElement("li");
    li.innerHTML = `<div><strong></strong><span class="muted"></span></div><button class="btn primary">Réviser</button>`;
    li.querySelector("strong")!.textContent = u.name;
    li.querySelector(".muted")!.textContent = `${STRENGTH_FR[u.strength]} · ${ago(u.lastDate)}`;
    li.querySelector("button")!.addEventListener("click", () => { session.test = null; void startSession("hifz", u.surah, u.from, u.to); });
    list.append(li);
  }
}

function renderMemo() {
  const mem = new Set(loadPrefs().memorized);
  const statuses = memoStatuses();
  const acc = surahAccuracy(loadHistory());
  const list = $("memo-list");
  list.replaceChildren();
  let lastJuz = 0;
  for (const s of surahs) {
    const j = juzOf(s.n);
    if (j !== lastJuz) {
      const h = document.createElement("li");
      h.className = "juz-head";
      h.textContent = `Juz ${j}`;
      list.append(h);
      lastJuz = j;
    }
    const li = document.createElement("li");
    li.innerHTML = `<input type="checkbox" /><div class="m-name"><strong></strong><span></span></div><span class="badge"></span><span class="m-ar" lang="ar"></span>`;
    const cb = li.querySelector("input")!;
    cb.checked = mem.has(s.n);
    li.querySelector("strong")!.textContent = `${s.n}. ${s.tr}`;
    const us = statuses.filter((u) => u.surah === s.n);
    const badge = li.querySelector<HTMLElement>(".badge")!;
    if (mem.has(s.n) && us.length) {
      const order = ["fragile", "nouveau", "moyen", "fort"] as const;
      const worst = order.find((o) => us.some((u) => u.strength === o)) ?? "nouveau";
      badge.textContent = STRENGTH_FR[worst];
      badge.classList.add(worst);
      const last = Math.max(...us.map((u) => u.lastDate ?? 0)) || null;
      li.querySelector(".m-name span")!.textContent = `${s.verses.length} ayahs · ${ago(last)}${acc.has(s.n) ? ` · ${Math.round(100 * acc.get(s.n)!)} % de réussite` : ""}`;
    } else {
      badge.hidden = true;
      li.querySelector(".m-name span")!.textContent = `${s.verses.length} ayahs`;
    }
    li.querySelector(".m-ar")!.textContent = s.ar;
    cb.addEventListener("change", () => {
      const p = loadPrefs();
      const set = new Set(p.memorized);
      if (cb.checked) set.add(s.n); else set.delete(s.n);
      savePrefs({ ...p, memorized: [...set].sort((a, b) => a - b) });
      renderMemo();
    });
    list.append(li);
  }
}

function renderWeak() {
  const hist = loadHistory();
  const { topWords, topAyahs, topRules } = weakPoints(hist);
  $("weak-intro").textContent = hist.length
    ? `Calculé sur tes ${hist.length} séance${hist.length > 1 ? "s" : ""} : mots non reconnus, erreurs signalées et analyses tajwid.`
    : "Pas encore de séance : récite quelques passages pour voir apparaître tes points faibles.";
  const ay = $("weak-ayahs");
  ay.replaceChildren();
  for (const a of topAyahs.slice(0, 6)) {
    const li = document.createElement("li");
    li.innerHTML = `<div><strong></strong><span class="muted"></span></div><button class="btn primary">Réviser</button>`;
    li.querySelector("strong")!.textContent = `${getSurah(a.surah).tr} ${a.ayah}`;
    li.querySelector(".muted")!.textContent = `${a.count} point${a.count > 1 ? "s" : ""} relevé${a.count > 1 ? "s" : ""}`;
    const n = getSurah(a.surah).verses.length;
    li.querySelector("button")!.addEventListener("click", () => { session.test = null; void startSession("hifz", a.surah, Math.max(1, a.ayah - 1), Math.min(n, a.ayah + 1)); });
    ay.append(li);
  }
  if (!topAyahs.length) ay.innerHTML = `<li class="empty">Rien pour l'instant.</li>`;
  const rules = $("weak-rules");
  rules.replaceChildren();
  for (const r of topRules) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="m-ref"></span><span class="m-word" lang="ar" dir="rtl"></span><span class="m-kind t-msg"></span>`;
    li.querySelector(".m-ref")!.textContent = `×${r.count}`;
    li.querySelector(".m-word")!.textContent = r.examples.join(" · ");
    li.querySelector(".m-kind")!.textContent = r.label;
    rules.append(li);
  }
  if (!topRules.length) rules.innerHTML = `<li class="empty">Apparaît après une analyse tajwid (serveur).</li>`;
  const words = $("weak-words");
  words.replaceChildren();
  for (const w of topWords) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="m-ref"></span><span class="m-word" lang="ar" dir="rtl"></span><span class="m-kind warn"></span>`;
    li.querySelector(".m-ref")!.textContent = `${w.surah}:${w.ayah}`;
    li.querySelector(".m-word")!.textContent = w.text;
    li.querySelector(".m-kind")!.textContent = `×${w.count} · ${w.reasons.slice(0, 2).join(", ")}`;
    words.append(li);
  }
  if (!topWords.length) words.innerHTML = `<li class="empty">Rien pour l'instant.</li>`;
}

// ---------------------------------------------------------------------------
// Service worker (hors ligne)
// ---------------------------------------------------------------------------
function registerSW() {
  if (!("serviceWorker" in navigator) || location.protocol === "http:" && location.hostname !== "localhost") return;
  navigator.serviceWorker.register(new URL("sw.js", BASE)).then(async (reg) => {
    await navigator.serviceWorker.ready;
    const urls = performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.startsWith(location.origin) && !u.endsWith(".onnx"));
    urls.push(location.href.split("#")[0]);
    (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: "cache", urls });
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function loadConfig() {
  try {
    const r = await fetch(new URL("config.json", BASE).toString(), { cache: "no-cache" });
    if (r.ok) setDefaultServer(String((await r.json()).tajwidUrl ?? ""));
  } catch { /* hors ligne sans cache : pas de serveur par défaut */ }
}

async function boot() {
  const [quran] = await Promise.all([loadQuran(new URL("quran.json", BASE).toString()), loadConfig()]);
  surahs = quran;
  fillSetup();
  renderHistory();

  $("go-free").addEventListener("click", () => { session.test = null; void startSession("libre", null); });
  $("go-hifz").addEventListener("click", () => openSetup());
  $("btn-install").addEventListener("click", () => void ensureEngine().catch(() => undefined));
  $("btn-clear").addEventListener("click", () => { if (confirm("Effacer tout l'historique ?")) { clearHistory(); renderHistory(); } });
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) => b.addEventListener("click", () => {
    const to = b.dataset.nav!;
    session.test = to === "home" ? null : session.test;
    if (to === "home") { renderHistory(); renderHome(); }
    if (to === "memo") renderMemo();
    if (to === "weak") renderWeak();
    show(to);
  }));
  $("go-test").addEventListener("click", openTestSetup);
  $("go-atelier").addEventListener("click", openAtelierSetup);
  $("btn-start-atelier").addEventListener("click", () => {
    const s = Number($<HTMLSelectElement>("at-surah").value);
    const a = Math.max(1, Math.min(getSurah(s).verses.length, Number($<HTMLInputElement>("at-ayah").value) || 1));
    startAtelierAyah(s, a);
  });
  $("at-retry").addEventListener("click", () => { const at = session.atelier; if (at) startAtelierAyah(at.surah, at.ayah); });
  $("at-next").addEventListener("click", () => { const at = session.atelier; if (at) startAtelierAyah(at.surah, at.ayah + 1); });
  $("at-quit").addEventListener("click", () => { session.atelier = null; renderHome(); renderHistory(); show("home"); });
  $("btn-start-test").addEventListener("click", () => {
    const scope = scopeSurahs($<HTMLSelectElement>("test-scope").value).filter((s) => s >= 1 && s <= 114);
    if (!scope.length) { toast("Coche d'abord des sourates dans « Ma mémorisation »."); return; }
    session.test = { count: Number($<HTMLSelectElement>("test-count").value), len: Number($<HTMLSelectElement>("test-len").value), scope, idx: 0, asked: new Set(), results: [] };
    nextTestQuestion();
  });
  $("btn-next-q").addEventListener("click", nextTestQuestion);
  document.querySelectorAll<HTMLElement>("[data-juz]").forEach((b) => b.addEventListener("click", () => {
    const p = loadPrefs();
    const set = new Set(p.memorized);
    if (b.dataset.juz === "none") set.clear();
    else for (const s of scopeSurahs(b.dataset.juz!)) set.add(s);
    savePrefs({ ...p, memorized: [...set].sort((a, c) => a - c) });
    renderMemo();
  }));
  $("r-text").addEventListener("click", (e) => { showWordTajwid(e.target as HTMLElement); });
  window.addEventListener("online", () => void processQueue());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void processQueue(); });
  ["sel-surah", "in-from", "in-to"].forEach((id) => $(id).addEventListener("input", () => {
    if (id === "sel-surah") {
      const max = getSurah(Number($<HTMLSelectElement>("sel-surah").value)).verses.length;
      $<HTMLInputElement>("in-from").value = "1";
      $<HTMLInputElement>("in-to").value = String(max);
    }
    updateSetup();
  }));
  document.querySelectorAll<HTMLElement>("[data-quick]").forEach((b) => b.addEventListener("click", () => {
    const n = Number(b.dataset.quick);
    $<HTMLSelectElement>("sel-surah").value = String(n);
    $<HTMLInputElement>("in-from").value = "1";
    $<HTMLInputElement>("in-to").value = String(getSurah(n).verses.length);
    updateSetup();
  }));
  $("btn-start-hifz").addEventListener("click", () => {
    const { surah, from, to, display, liveTajwid, tajwidEngine, phoneFilters, sensitive, verify, tajwidUrl } = readSetup();
    savePrefs({ ...loadPrefs(), surah, from, to, display, liveTajwid, tajwidEngine, phoneFilters, sensitive, verify, tajwidUrl });
    if (tajwidEngine !== "server") startMini();
    if (verify) startVerifier();
    session.test = null;
    void startSession("hifz", surah, from, to);
  });
  $("btn-stop").addEventListener("click", () => void endSession());
  $("btn-tajwid").addEventListener("click", () => void runTajwid());
  $("btn-diag").addEventListener("click", () => {
    if (!lastDiag) return;
    void exportDiagnostic(lastDiag).then((how) => toast(how === "share" ? "Envoie les 2 fichiers dans la conversation avec Claude." : "Fichiers téléchargés : joins-les à la conversation avec Claude.", 4500))
      .catch((e) => toast("Export impossible : " + String(e?.message ?? e), 4000));
  });
  $("btn-quit").addEventListener("click", () => void endSession());
  $("btn-hint").addEventListener("click", giveHint);
  $("btn-toggle-hide").addEventListener("click", toggleShowAll);
  $("sheet-primary").addEventListener("click", (e) => sheetAction((e.currentTarget as HTMLElement).dataset.action as CorrectionAction));
  $("sheet-secondary").addEventListener("click", (e) => sheetAction((e.currentTarget as HTMLElement).dataset.action as CorrectionAction));
  $("btn-again").addEventListener("click", () => {
    const r = lastRecord;
    if (r?.mode === "test") { openTestSetup(); return; }
    session.test = null;
    if (!r?.surah) return;
    if (r.mode === "hifz") void startSession("hifz", r.surah, r.from ?? 1, r.to ?? 1);
    else openSetup(r.surah, r.from ?? 1, r.to ?? 1);
  });
  // Touche l'écran pour réveiller l'audio si le navigateur l'a suspendu.
  $("r-scroll").addEventListener("click", () => mic.kick());

  renderHome();
  void processQueue();
  if (await isModelCached(MODEL_KEY)) void ensureEngine().catch(() => undefined);
  else setEngine("absent", "");
  registerSW();
}

void boot().catch((e) => {
  document.body.innerHTML = `<p style="padding:24px">Erreur au chargement : ${String(e?.message ?? e)}</p>`;
});

// Exposé pour les tests automatisés.
(window as unknown as { __murattil: unknown }).__murattil = { session, mic, get engineState() { return engineState; }, get miniState() { return miniState; }, get miniThreads() { return miniThreads; } };
