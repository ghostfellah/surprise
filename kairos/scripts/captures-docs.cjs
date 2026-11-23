// Régénère les captures d'écran de la documentation (kairos/docs/img/*.webp après conversion).
// Elles montrent l'application réelle avec les données de DÉMO (fictives), l'heure figée à mardi 24 novembre 2026, 10 h 20.
// La maquette de la boîte de réception des agents est une page statique étiquetée « pas encore construit ».
// Usage (Playwright installé) : depuis la racine du dépôt,
//   python3 -m http.server 8196 &
//   node kairos/scripts/captures-docs.cjs /tmp/captures      puis convertir en WebP (qualité 84).
const { chromium } = require('playwright');
const OUT = process.argv[2];
const BASE = 'http://localhost:8196/kairos/site/';
const FIXED = new Date('2026-11-24T10:20:00+01:00'); // mardi 10 h 20, heure de Paris : dans une fenêtre d'or
async function boot(b, vp, scheme) {
  const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, locale: 'fr-FR', timezoneId: 'Europe/Paris', deviceScaleFactor: 1, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  await p.clock.install({ time: FIXED }); await p.clock.resume();
  p.on('pageerror', (e) => console.log('PAGEERR', e.message));
  await p.goto(BASE + '#/today'); await p.waitForTimeout(1500);
  for (let i = 0; i < 6; i++) {
    if (!(await p.$('#onboard-root'))) break;
    await p.evaluate(() => { const s = document.querySelector('#onboard-root .switch input'); if (s && !s.checked) s.click(); document.querySelector('#onboard-root .onboard__foot .btn--primary').click(); });
    await p.waitForTimeout(800);
  }
  await p.waitForTimeout(2500);
  return { ctx, p };
}
const go = async (p, r, wait = 3800) => { await p.evaluate((r) => { location.hash = '#/' + r; }, r); await p.waitForTimeout(wait); };
(async () => {
  const b = await chromium.launch();
  // --- bureau, sombre ---
  let { ctx, p } = await boot(b, { width: 1280, height: 820 }, 'dark');
  await go(p, 'today', 3800); await p.screenshot({ path: `${OUT}/aujourdhui.png` });
  // plan : on lance le planificateur pour montrer le résultat
  await go(p, 'plan', 3800);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Planifier ma semaine/.test(x.textContent)).click());
  await p.waitForTimeout(9000); await p.waitForTimeout(500);
  await p.setViewportSize({ width: 1280, height: 1320 }); await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/planning.png` });
  await p.setViewportSize({ width: 1280, height: 820 });
  await go(p, 'today', 3800); await p.screenshot({ path: `${OUT}/aujourdhui-plan.png` });
  await go(p, 'lab', 3800);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Optimiser pour moi/.test(x.textContent)).click());
  await p.waitForTimeout(5000); await p.screenshot({ path: `${OUT}/labo.png` });
  for (const [r, f] of [['sleep', 'sommeil'], ['travel', 'voyage'], ['insights', 'bilan'], ['settings', 'reglages'], ['science', 'science']]) { await go(p, r, 3800); await p.screenshot({ path: `${OUT}/${f}.png` }); }
  await ctx.close();
  // --- clair ---
  ({ ctx, p } = await boot(b, { width: 1280, height: 820 }, 'light'));
  await go(p, 'today', 3800); await p.screenshot({ path: `${OUT}/aujourdhui-clair.png` }); await ctx.close();
  // --- mobile ---
  ({ ctx, p } = await boot(b, { width: 390, height: 844 }, 'dark'));
  await go(p, 'today', 3800); await p.screenshot({ path: `${OUT}/mobile-aujourdhui.png` });
  await go(p, 'lab', 3800); await p.screenshot({ path: `${OUT}/mobile-labo.png` });
  await go(p, 'plan', 3800); await p.waitForTimeout(1500);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Planifier/.test(x.textContent)).click());
  await p.waitForTimeout(9000); await p.screenshot({ path: `${OUT}/mobile-planning.png` });
  await ctx.close();
  // --- page agents + maquette ---
  ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'block' });
  p = await ctx.newPage(); await p.clock.install({ time: FIXED }); await p.clock.resume();
  await p.goto('http://localhost:8196/kairos/site/agents.html'); await p.waitForTimeout(1000);
  await p.screenshot({ path: `${OUT}/agents-accueil.png` });
  await p.click('#run'); await p.waitForTimeout(300);
  await (await p.$('section[aria-labelledby="t-play"]')).screenshot({ path: `${OUT}/agents-outil.png` });
  await p.click('[data-ex=hostile]'); await p.click('#validate'); await p.waitForTimeout(200);
  await (await p.$('section[aria-labelledby="t-val"]')).screenshot({ path: `${OUT}/agents-validation.png` });
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.goto('http://localhost:8196/kairos/docs/maquettes/boite-de-reception.html'); await p.waitForTimeout(800);
  await p.screenshot({ path: `${OUT}/maquette-boite-de-reception.png` });
  await ctx.close(); await b.close();
  console.log('ok');
})();
