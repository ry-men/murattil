import { chromium } from "playwright";
const wav = "tests/audio/multi_114_001_006.wav";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
await page.goto("http://localhost:4173/");
await page.waitForFunction(() => window.__murattil?.engineState === "absent");
await page.click("#btn-install");
await page.waitForFunction(() => window.__murattil.engineState === "ready", null, { timeout: 120000 });
await page.click("#go-free");
await page.waitForFunction(() => document.querySelector("#mic-pill").textContent.includes("actif"));
await page.waitForTimeout(5000);
const statuses = [];
await page.exposeFunction("logStatus", (s) => statuses.push(s));
await page.evaluate(() => { new MutationObserver(() => window.logStatus(document.querySelector("#mic-pill").textContent)).observe(document.querySelector("#mic-pill"), { childList: true, characterData: true, subtree: true }); });
// Coupure brutale du micro (comme un appel entrant / changement de casque)
await page.evaluate(() => window.__murattil.mic.stream.getTracks().forEach((t) => t.stop()));
await page.waitForTimeout(6000);
// Suspension du contexte audio (comme iOS en arrière-plan)
await page.evaluate(() => window.__murattil.mic.ctx.suspend());
await page.waitForTimeout(4000);
const r = await page.evaluate(() => ({ status: window.__murattil.mic.status, ctx: window.__murattil.mic.ctx?.state, ayahs: window.__murattil.session.ayahs }));
console.log({ statuses, ...r });
await browser.close();
