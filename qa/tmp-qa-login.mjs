/**
 * tmp-qa-login.mjs — Verifica pagina de login.
 *
 * Site-ul de teste foloseste Discord OAuth, deci fara o sesiune valida nu
 * putem intra in teste. Acest script verifica doar ca pagina de login se
 * randeaza si ca butonul de autentificare exista.
 *
 *   node browser.mjs http://localhost:3000/login --script tmp-qa-login.mjs
 */
export default async function run(page, ui) {
  const out = {};
  out.titlu = await page.title();
  out.areButonLogin = /@(e\d+) (button|a) ".*(login|conectare|discord)/i.test(await ui.snapshot());
  out.eroarePeEcran = await page
    .locator('.alert.err')
    .first()
    .innerText()
    .catch(() => null);
  return out;
}
