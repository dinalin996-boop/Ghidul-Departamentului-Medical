/**
 * tmp-rp-qa2.mjs — Verifica daca autentificarea Repartizarii chiar functioneaza.
 *
 * ATENTIE: loginul se face prin Discord OAuth (butonul rpLoginDiscord), nu printr-un
 * camp de ID. De aceea nu putem testa cu un ID fals. Verificam in schimb ca:
 *   1. sectiunea de repartizare exista si se deschide,
 *   2. butonul de login Discord este prezent si functional (deschide fereastra OAuth),
 *   3. configurarea nu mai foloseste credentiale false.
 *
 *   node browser.mjs "https://ghidul-departamentului-medical-eight.vercel.app/#repartizare-zone" \
 *        --script tmp-rp-qa2.mjs
 */
export default async function run(page, ui) {
  const out = {};

  out.config = await page.evaluate(() => ({
    sheet: typeof SHEET_ID !== 'undefined' ? SHEET_ID : 'undef',
    worker: typeof RP_CONFIG !== 'undefined' ? RP_CONFIG.workerUrl : 'undef',
    areApiKeyFals: typeof API_KEY !== 'undefined' && String(API_KEY).includes('Dummy'),
  }));

  // Deschidem mai intai sectiunea de repartizare din meniu.
  const snap = await ui.snapshot();
  const ref = snap.match(/@(e\d+) (button|a)[^\n]*Repartizare/i)?.[1];
  out.butonMeniu = ref ?? null;
  if (ref) {
    await ui.click(ref);
    await page.waitForTimeout(2500);
  }

  out.sectiune = await page.locator('#repartizare-zone').isVisible().catch(() => false);
  out.loginVizibil = await page.locator('#rpLoginContainer').isVisible().catch(() => false);
  out.butonDiscord = await page
    .locator('button[onclick="rpLoginDiscord()"]')
    .isVisible()
    .catch(() => false);

  // Deschidem popup-ul OAuth ca sa confirmam ca butonul chiar merge.
  if (out.butonDiscord) {
    const [popup] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
      page.locator('button[onclick="rpLoginDiscord()"]').click(),
    ]);
    out.oauthDeschis = !!popup;
    out.oauthUrl = popup ? (popup.url() || '').slice(0, 90) : null;
    if (popup) await popup.close().catch(() => {});
  }

  return out;
}
