// Sauvegarde : tout l'historique et les réglages dans un fichier, pour changer de téléphone ou se protéger d'un effacement.
import { exportData, importData } from "./store";

export function downloadBackup(version: string): string {
  const d = exportData();
  const name = `murattil-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify({ app: "murattil", kind: "backup", version, date: new Date().toISOString(), ...d })], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  try { localStorage.setItem("murattil.lastBackup", String(Date.now())); } catch { /* */ }
  return name;
}

export async function restoreBackup(file: File): Promise<{ added: number; total: number }> {
  const d = JSON.parse(await file.text());
  if (d?.app !== "murattil" || d?.kind !== "backup") throw new Error("Ce fichier n'est pas une sauvegarde Murattil.");
  return importData(d);
}

export function lastBackup(): number | null {
  try { const v = Number(localStorage.getItem("murattil.lastBackup")); return v > 0 ? v : null; } catch { return null; }
}
