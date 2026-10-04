import "@fontsource/amiri-quran/400.css";
import "./style.css";
import type { CorrectionAction, CorrectionState, CorrectionIssue } from "./core/index";
import { Mic, type MicStatus } from "./audio";
import { isModelCached } from "./model-cache";
import { loadQuran, getSurah, ayahWords, hasBismillahPrefix, arNum, type Surah } from "./quran";
import { loadHistory, saveSession, clearHistory, loadPrefs, savePrefs, type Mistake, type SessionRecord } from "./store";

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
      onVerseMatch(msg.surah, msg.ayah);
      break;
    case "verse_candidate":
      onCandidate(msg);
      break;
    case "word_progress":
      onWordProgress(msg.surah, msg.ayah, msg.matched_indices as number[]);
      break;
    case "correction":
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
};

const mic = new Mic({
  workletUrl: new URL("audio-processor.js", BASE).toString(),
  onChunk: (samples) => {
    if (session.active && engineState === "ready" && worker) worker.postMessage({ type: "audio", samples }, [samples.buffer]);
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
  worker.postMessage({ type: "reset" });
}

async function startSession(mode: "libre" | "hifz", surah: number | null, from = 1, to = 1) {
  Object.assign(session, {
    active: true, mode, surah, from, to, showAll: false, rendered: null,
    progress: new Map(), hinted: new Set(), ayahs: [], current: null, mistakes: [], hints: 0, correction: null,
  });
  session.hide = mode === "hifz" ? loadPrefs().hide : false;
  document.body.classList.toggle("hifz", mode === "hifz");
  $("r-text").replaceChildren();
  $("r-text").classList.toggle("hidden-text", session.hide);
  $("btn-toggle-hide").textContent = "Afficher";
  $("btn-hint").hidden = !(mode === "hifz" && session.hide);
  $("btn-toggle-hide").hidden = !(mode === "hifz" && session.hide);
  $("r-candidate").textContent = "";
  $("r-timer").textContent = "0:00";
  if (mode === "hifz" && surah) {
    renderPassage(surah, from, to);
    const s = getSurah(surah);
    $("r-title").textContent = `${s.tr} · ${s.ar}`;
    $("r-sub").textContent = `Ayahs ${from} à ${to}`;
    $("r-wait").hidden = true;
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
  const duration = session.startedAt ? (Date.now() - session.startedAt) / 1000 : 0;
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
  };
  if (duration > 8 || rec.ayahs.length) saveSession(rec);
  renderSummary(rec);
  renderHistory();
  show("summary");
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
      ws.textContent = w;
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
  // Les ayahs déjà dépassées : les mots non reconnus sont dévoilés en gris.
  if (prev && prev.surah === surah && ayah > prev.ayah) {
    for (let a = prev.ayah; a < ayah; a++) {
      ayahEl(surah, a)?.querySelectorAll(".w:not(.ok)").forEach((w) => w.classList.add("seen"));
    }
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
    const ok = set!.has(i);
    w.classList.toggle("ok", ok);
    if (!ok && next < 0) next = i;
  });
  $("r-text").querySelectorAll(".w.cur").forEach((w) => w.classList.remove("cur"));
  if (next >= 0) words[next].classList.add("cur");
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
    const w = el?.querySelector<HTMLElement>(".w:not(.ok):not(.hint):not(.seen)");
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
  $("r-text").classList.toggle("hidden-text", session.hide && !session.showAll);
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
  $("sum-time").textContent = fmtTime(r.durationSec);
  $("sum-ayahs").textContent = String(r.ayahs.length);
  $("sum-mistakes").textContent = String(r.mistakes.length);
  $("sum-hints").textContent = String(r.hints);
  $("sum-range").textContent = rangeLabel(r);
  const list = $("sum-list");
  list.replaceChildren();
  $("sum-mistakes-title").hidden = r.mode !== "hifz";
  if (r.mode === "hifz" && !r.mistakes.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Aucune erreur détectée. Bārak Allāhu fīk.";
    list.append(li);
  }
  for (const m of r.mistakes) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="m-ref">${m.surah}:${m.ayah}</span><span class="m-word" lang="ar" dir="rtl"></span><span class="m-kind ${m.corrected ? "ok" : ""}">${KIND_SHORT[m.kind] ?? m.kind}${m.corrected ? " · corrigé" : ""}</span>`;
    li.querySelector(".m-word")!.textContent = m.text;
    list.append(li);
  }
  $("btn-again").textContent = r.mode === "hifz" ? "Recommencer ce passage" : "Réviser ce passage en Hifz";
  $("btn-again").hidden = !r.surah;
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
    li.querySelectorAll(".muted")[1].textContent = r.mode === "hifz" ? `${r.mistakes.length} erreur${r.mistakes.length > 1 ? "s" : ""}` : `${r.ayahs.length} ayahs`;
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
  const s = surah ?? p.surah;
  const max = getSurah(s).verses.length;
  $<HTMLSelectElement>("sel-surah").value = String(s);
  $<HTMLInputElement>("in-from").value = String(Math.min(from ?? (surah ? 1 : p.from), max));
  $<HTMLInputElement>("in-to").value = String(Math.min(to ?? (surah ? max : p.to), max));
  $<HTMLInputElement>("chk-hide").checked = p.hide;
  updateSetup();
  show("setup");
}

function readSetup() {
  const surah = Number($<HTMLSelectElement>("sel-surah").value) || 1;
  const max = getSurah(surah).verses.length;
  let from = Math.max(1, Math.min(max, Number($<HTMLInputElement>("in-from").value) || 1));
  let to = Math.max(1, Math.min(max, Number($<HTMLInputElement>("in-to").value) || max));
  if (to < from) [from, to] = [to, from];
  return { surah, from, to, max, hide: $<HTMLInputElement>("chk-hide").checked };
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
async function boot() {
  surahs = await loadQuran(new URL("quran.json", BASE).toString());
  fillSetup();
  renderHistory();

  $("go-free").addEventListener("click", () => void startSession("libre", null));
  $("go-hifz").addEventListener("click", () => openSetup());
  $("btn-install").addEventListener("click", () => void ensureEngine().catch(() => undefined));
  $("btn-clear").addEventListener("click", () => { if (confirm("Effacer tout l'historique ?")) { clearHistory(); renderHistory(); } });
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) => b.addEventListener("click", () => { renderHistory(); show(b.dataset.nav!); }));
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
    const { surah, from, to, hide } = readSetup();
    savePrefs({ ...loadPrefs(), surah, from, to, hide });
    void startSession("hifz", surah, from, to);
  });
  $("btn-stop").addEventListener("click", () => void endSession());
  $("btn-quit").addEventListener("click", () => void endSession());
  $("btn-hint").addEventListener("click", giveHint);
  $("btn-toggle-hide").addEventListener("click", toggleShowAll);
  $("sheet-primary").addEventListener("click", (e) => sheetAction((e.currentTarget as HTMLElement).dataset.action as CorrectionAction));
  $("sheet-secondary").addEventListener("click", (e) => sheetAction((e.currentTarget as HTMLElement).dataset.action as CorrectionAction));
  $("btn-again").addEventListener("click", () => {
    const r = lastRecord;
    if (!r?.surah) return;
    if (r.mode === "hifz") void startSession("hifz", r.surah, r.from ?? 1, r.to ?? 1);
    else openSetup(r.surah, r.from ?? 1, r.to ?? 1);
  });
  // Touche l'écran pour réveiller l'audio si le navigateur l'a suspendu.
  $("r-scroll").addEventListener("click", () => mic.kick());

  if (await isModelCached(MODEL_KEY)) void ensureEngine().catch(() => undefined);
  else setEngine("absent", "");
  registerSW();
}

void boot().catch((e) => {
  document.body.innerHTML = `<p style="padding:24px">Erreur au chargement : ${String(e?.message ?? e)}</p>`;
});

// Exposé pour les tests automatisés.
(window as unknown as { __murattil: unknown }).__murattil = { session, mic, get engineState() { return engineState; } };
