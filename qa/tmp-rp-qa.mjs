/**
 * tmp-rp-qa.mjs — QA pentru sectiunea de Repartizare din Ghid.
 *
 * Verifica daca sectiunea se deschide, daca loginul e prezent si daca harta
 * de repartizare se incarca. Ruleaza cu:
 *
 *   node browser.mjs https://ghidul-departamentului-medical-eight.vercel.app/#repartizare-zone \
 *        --script tmp-rp-qa.mjs
 */
export default async function run(page, ui) {
  const out = {};

  // Deschidem sectiunea Repartizare din meniu.
  const snap = await ui.snapshot();
  const ref = snap.match(/@(e\d+) (button|a)[^\n]*Repartizare/i)?.[1];
  out.butonRepartizare = ref ?? null;

  if (ref) {
    await ui.click(ref);
    await page.waitForTimeout(2500);
  }

  out.texte = (await page.locator('body').innerText()).slice(0, 400);
  out.sectiuneVisible = await page
    .locator('#repartizare-zone')
    .isVisible()
    .catch(() => 'lipseste');
  out.loginVizibil = await page
    .locator('#rpLoginContainer')
    .isVisible()
    .catch(() => 'lipseste');
  out.hartaRepartizare = await page
    .locator('#repartizare-zone img')
    .first()
    .getAttribute('src')
    .catch(() => 'lipseste');

  return out;
}
