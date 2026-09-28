# Scripturi QA — Repartizare & site de teste

Scripturi pentru `browser.mjs` (skillul de browser-automation) folosite la
verificarea Ghidului si a site-ului de teste.

## Rulare

```bash
node <skill>/browser.mjs "<url>" --script qa/tmp-rp-qa.mjs
```

## Ce verifica fiecare

| Fisier | Verifica |
|---|---|
| `tmp-rp-qa.mjs` | Sectiunea **Repartizare Zone** se deschide, cutia de login si harta se incarca, fara erori JS. |
| `tmp-rp-qa2.mjs` | Autentificarea: butonul Discord OAuth exista, popup-ul se deschide, si configurarea **nu mai foloseste credentiale false** (`API_KEY` placeholder). |
| `tmp-qa-login.mjs` | Pagina de login a site-ului de teste se randeaza si are butonul de conectare. |
| `../tmp-repartizare.html` | Redirectul de la vechea pagina `repartizare.html` catre sistemul real din `index.html`. |

## De ce exista `tmp-rp-qa2.mjs`

Loginul se face prin **Discord OAuth**, nu printr-un camp de ID. Prin urmare
nu putem testa cu un ID fals (varianta veche cu `#discordIdInput` a fost
eliminata). Scriptul verifica faptul ca butonul exista si ca apasarea lui
deschide fereastra OAuth.

## Ce a fost reparat

`repartizare.html` avea credentiale Google Sheets false
(`1Ej0Ej0...` / `AIzaSyDummyKeyForTesting`). API-ul raspundea cu HTTP 400, deci
**nimeni nu se putea conecta niciodata**. Fisierul a fost inlocuit cu un
redirect catre sistemul functional din `index.html`.
