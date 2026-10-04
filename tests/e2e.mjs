// Test de bout en bout : Chromium headless, micro simulé avec un fichier WAV.
// node tests/e2e.mjs <wav> <libre|hifz> [surah from to] [--show]
import { chromium } from "playwright";
import { execSync } from "node:child_process";

const [wav, mode, surah, from, to] = process.argv.slice(2);
const show = process.argv.includes("--show");
const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 ${wav}`).toString());
const URL = process.env.APP_URL || "http://localhost:4173/";
const shots = process.env.SHOTS || "/home/claude/murattil/tests/shots";
const tag = process.env.TAG || mode;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["microphone"], colorScheme: process.env.DARK ? "dark" : "light" });
const page = await ctx.newPage();
const events = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") events.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => events.push(`[pageerror] ${e.message}`));
await page.goto(URL);
await page.waitForFunction(() => window.__murattil && window.__murattil.engineState !== "unknown", null, { timeout: 30000 }).catch(() => {});
if (show) await page.screenshot({ path: `${shots}/${tag}-0-home.png` });
let t0 = Date.now();
const state = await page.evaluate(() => window.__murattil.engineState);
if (state === "absent") await page.click("#btn-install");
await page.waitForFunction(() => window.__murattil.engineState === "ready", null, { timeout: 180000 });
console.log(`moteur prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s`);

if (mode === "hifz") {
  await page.click("#go-hifz");
  await page.selectOption("#sel-surah", surah);
  await page.fill("#in-from", from);
  await page.fill("#in-to", to);
  await page.dispatchEvent("#in-to", "input");
  if (process.env.SENS) await page.setChecked("#chk-sensitive", process.env.SENS === "1");
  if (show) await page.screenshot({ path: `${shots}/${tag}-1-setup.png` });
  await page.click("#btn-start-hifz");
} else {
  await page.click("#go-free");
}
await page.waitForFunction(() => document.querySelector("#mic-pill").textContent.includes("actif"), null, { timeout: 20000 });
t0 = Date.now();
// Pendant la lecture : on accepte « C'était correct » ou « Continuer » si une erreur s'affiche, on note tout.
const flags = [];
while ((Date.now() - t0) / 1000 < dur + 2) {
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => {
    const d = document.getElementById("sheet");
    return d.open ? { phase: d.dataset.phase, kind: document.getElementById("sheet-kind").textContent, title: document.getElementById("sheet-title").textContent } : null;
  });
  if (sheet) {
    flags.push({ t: ((Date.now() - t0) / 1000).toFixed(1), ...sheet });
    if (show && flags.length === 1) await page.waitForTimeout(400), await page.screenshot({ path: `${shots}/${tag}-3-sheet.png` });
    if (process.env.ON_FLAG === "retry" && sheet.phase === "error") await page.click("#sheet-primary");
    else if (sheet.phase === "corrected") await page.click("#sheet-primary");
    else if (sheet.phase === "error") await page.click("#sheet-secondary");
  }
  if (show && Math.abs((Date.now() - t0) / 1000 - dur * 0.55) < 0.3) await page.screenshot({ path: `${shots}/${tag}-2-recite.png` });
}
const live = await page.evaluate(() => {
  const s = window.__murattil.session;
  const words = [...document.querySelectorAll("#r-text .w")];
  return {
    ayahs: s.ayahs, mistakes: s.mistakes, current: s.current,
    words: words.length, ok: words.filter((w) => w.classList.contains("ok")).length,
    seen: words.filter((w) => w.classList.contains("seen")).length,
    title: document.getElementById("r-title").textContent, sub: document.getElementById("r-sub").textContent,
  };
});
if (show) await page.screenshot({ path: `${shots}/${tag}-2b-end.png` });
await page.click("#btn-stop");
await page.waitForFunction(() => document.body.dataset.screen === "summary", null, { timeout: 10000 });
if (show) await page.screenshot({ path: `${shots}/${tag}-4-summary.png`, fullPage: true });
const summary = await page.evaluate(() => ({ valid: document.getElementById("sum-valid").textContent, review: document.getElementById("sum-review").textContent, items: [...document.querySelectorAll("#sum-list li")].map((l) => l.textContent) }));
let downloads = [];
if (process.env.DIAG) {
  const dl = [];
  page.on("download", (d) => dl.push(d));
  await page.click("#btn-diag");
  await page.waitForTimeout(2500);
  for (const d of dl) { const p = `${shots}/${d.suggestedFilename()}`; await d.saveAs(p); downloads.push(p); }
}
console.log(JSON.stringify({ dur, live, flags, summary, downloads, events }, null, 1));
await browser.close();
