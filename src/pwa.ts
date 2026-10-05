// Application installable (PWA) : bouton « Installer », mise à jour en un geste, raccourcis de l'icône.

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const DISMISS_KEY = "murattil.install.dismissed";
let deferred: InstallEvent | null = null;

export function isStandalone(): boolean {
  return matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function dismissed(): boolean {
  try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < 14 * 86400e3; } catch { return false; }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function renderInstallCard() {
  const card = el("install-card");
  if (!card) return;
  const ios = isIos() && !deferred;
  card.hidden = isStandalone() || dismissed() || (!deferred && !ios);
  el("install-ios")!.hidden = !ios;
  el("btn-pwa-install")!.hidden = ios;
}

/** Bouton « Installer l'app » sur l'accueil (Android / Chrome), ou consigne pour iPhone. */
export function initInstall(toast: (m: string, ms?: number) => void) {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // on garde l'invite pour notre bouton
    deferred = e as InstallEvent;
    renderInstallCard();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    renderInstallCard();
    toast("Murattil est installée : ouvre-la depuis l'écran d'accueil.", 4000);
  });
  el("btn-pwa-install")?.addEventListener("click", async () => {
    if (!deferred) return;
    const ev = deferred;
    deferred = null;
    await ev.prompt();
    await ev.userChoice.catch(() => undefined);
    renderInstallCard();
  });
  el("btn-pwa-later")?.addEventListener("click", () => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* */ }
    renderInstallCard();
  });
  matchMedia("(display-mode: standalone)").addEventListener?.("change", renderInstallCard);
  renderInstallCard();
}

/** Nouvelle version : bandeau « Mettre à jour » (jamais de rechargement forcé pendant une récitation). */
export function watchUpdates(reg: ServiceWorkerRegistration, busy: () => boolean) {
  const hadController = !!navigator.serviceWorker.controller;
  let shown = false;
  const offer = () => {
    if (!hadController || shown) return;
    shown = true;
    const bar = el("update-bar");
    if (!bar) return;
    bar.hidden = false;
    el("btn-update")?.addEventListener("click", () => {
      if (busy()) { bar.querySelector("span")!.textContent = "Termine d'abord ta récitation, puis touche « Mettre à jour »."; return; }
      location.reload();
    });
  };
  navigator.serviceWorker.addEventListener("controllerchange", offer);
  // Vérifie les mises à jour au retour dans l'app (au plus une fois par heure).
  let last = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || Date.now() - last < 3600e3) return;
    last = Date.now();
    void reg.update().catch(() => undefined);
  });
}

/** Raccourcis de l'icône (appui long) : ?go=hifz | libre | test | atelier | memo. */
export function shortcutTarget(): string | null {
  const go = new URLSearchParams(location.search).get("go");
  if (!go) return null;
  history.replaceState(null, "", location.pathname + location.hash);
  return go;
}
