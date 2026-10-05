// Parcours des nouveaux écrans : mémorisation, révision du jour, test de mémoire, points faibles.
import { chromium } from "playwright";
const shots = "/home/claude/murattil/tests/shots";
const wav = "tests/audio/multi_067_001_004.wav";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
const page = await (await browser.newContext({ permissions: ["microphone"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto("http://localhost:4173/");
await page.waitForFunction(() => window.__murattil?.engineState && window.__murattil.engineState !== "unknown");
if (await page.evaluate(() => window.__murattil.engineState) === "absent") await page.click("#btn-install");
await page.waitForFunction(() => window.__murattil.engineState === "ready", null, { timeout: 120000 });
// Mémorisation : Juz Tabarak
await page.click("#s-home .row2 [data-nav=memo]");
await page.click("[data-juz='29']");
await page.screenshot({ path: `${shots}/ui-memo.png` });
await page.click("#s-memo [data-nav=home]");
await page.waitForTimeout(300);
console.log("révision du jour :", (await page.$$eval("#due-list li", (l) => l.map((x) => x.textContent))).slice(0, 3));
await page.screenshot({ path: `${shots}/ui-home.png`, fullPage: true });
// Une révision depuis la liste (Al-Mulk 1-30 probablement en 2 portions)
await page.click("#due-list li button");
await page.waitForFunction(() => document.querySelector("#mic-pill").textContent.includes("actif"), null, { timeout: 20000 });
await page.waitForTimeout(66000);
await page.click("#btn-stop");
await page.waitForFunction(() => document.body.dataset.screen === "summary", null, { timeout: 60000 });
console.log("bilan révision :", await page.textContent("#sum-valid"), await page.textContent("#sum-range"));
await page.click("#s-summary [data-nav=home]");
console.log("après révision :", (await page.$$eval("#due-list li", (l) => l.map((x) => x.textContent))).slice(0, 3));
// Test de mémoire, 2 questions sur Al-Mulk
await page.click("#go-test");
await page.selectOption("#test-scope", "-67");
await page.selectOption("#test-count", "3");
await page.click("#btn-start-test");
for (let q = 1; q <= 3; q++) {
  await page.waitForFunction(() => document.querySelector("#mic-pill").textContent.includes("actif"), null, { timeout: 20000 });
  if (q === 1) { await page.waitForTimeout(1500); await page.screenshot({ path: `${shots}/ui-test-q.png` }); }
  console.log("question", q, ":", await page.textContent("#r-title"), "| amorce :", await page.$$eval(".w.cue", (l) => l.map((w) => w.textContent).join(" ")));
  await page.waitForTimeout(5000);
  await page.click("#btn-stop");
  await page.waitForFunction(() => document.body.dataset.screen === "summary", null, { timeout: 60000 });
  console.log("  bilan :", await page.textContent("#sum-range"), "| suivant visible :", await page.isVisible("#btn-next-q"));
  if (q < 3) await page.click("#btn-next-q");
}
await page.screenshot({ path: `${shots}/ui-test-end.png`, fullPage: true });
await page.click("#s-summary [data-nav=home]");
await page.click("#s-home .row2 [data-nav=weak]");
await page.screenshot({ path: `${shots}/ui-weak.png`, fullPage: true });
console.log("points faibles :", await page.textContent("#weak-intro"));
console.log("erreurs JS :", errs);
await browser.close();
