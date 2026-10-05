// Atelier tajwid : ayah par ayah, analyse fine (serveur factice avec sifat), audio, score, ayah suivante.
import { chromium } from "playwright";
const shots = "/home/claude/murattil/tests/shots";
const wav = "tests/audio/multi_067_001_004.wav";
const URL_SRV = process.env.TAJWID ?? "http://localhost:7860";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ permissions: ["microphone"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await ctx.addInitScript((u) => { const k = "murattil.prefs.v1"; const p = JSON.parse(localStorage.getItem(k) || "{}"); if (u) p.tajwidUrl = u; p.surah = 67; localStorage.setItem(k, JSON.stringify(p)); }, process.env.NOSRV ? "" : URL_SRV);
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
await page.goto("http://localhost:4173/");
await page.waitForFunction(() => window.__murattil?.engineState && window.__murattil.engineState !== "unknown");
if (await page.evaluate(() => window.__murattil.engineState) === "absent") await page.click("#btn-install");
await page.waitForFunction(() => window.__murattil.engineState === "ready", null, { timeout: 120000 });
await page.click("#go-atelier");
console.log("moteur :", await page.textContent("#at-engine"));
await page.fill("#at-ayah", "1");
await page.click("#btn-start-atelier");
for (let n = 1; n <= 2; n++) {
  const t0 = Date.now();
  await page.waitForFunction(() => document.body.dataset.screen === "atelier", null, { timeout: 60000 });
  console.log(`ayah ${n} : fin auto après ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForFunction(() => !document.querySelector("#at-status").textContent.includes("en cours"), null, { timeout: 60000 });
  console.log("  statut :", await page.textContent("#at-status"), "| score :", await page.textContent("#at-score"));
  console.log("  erreurs :", await page.$$eval("#at-list li", (l) => l.map((x) => x.textContent.trim())));
  console.log("  audio moi :", (await page.getAttribute("#at-mine", "src"))?.slice(0, 5), "| qari :", await page.getAttribute("#at-qari", "src"));
  await page.screenshot({ path: `${shots}/atelier-${n}.png`, fullPage: true });
  if (n === 1) await page.click("#at-next");
}
await page.click("#at-quit");
await page.waitForFunction(() => document.body.dataset.screen === "home");
console.log("historique atelier :", await page.evaluate(() => JSON.parse(localStorage.getItem("murattil.history.v1")).filter((r) => r.mode === "atelier").length));
console.log("erreurs JS :", errs);
await browser.close();
