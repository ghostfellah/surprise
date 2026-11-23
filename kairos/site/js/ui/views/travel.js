// Vue « Voyage » : anti-décalage horaire.
// Un globe de points (jour/nuit calculés depuis l'heure UTC, terminateur, arc du vol, avion qui avance quand on
// fait glisser le temps), un plan jour par jour (planJetlag du moteur) avec une frise de 24 h par jour
// (sommeil, lumière à chercher, lumière à éviter), la courbe du décalage résiduel, et deux actions :
// « Appliquer à mon planning » (événements d'agenda, avec annulation) et « Copier le plan ».
//
// Honnêteté : c'est un outil de confort fondé sur la courbe de réponse de phase à la lumière — pas un avis médical.
// Les contours des continents sont volontairement grossiers (carte de points stylisée), ils ne servent qu'à se repérer.
import { h, svg, icon, replaceChildren, animateNumber, prefersReducedMotion, haptic, uniqueId } from '../dom.js';
import { planJetlag, tzOffsetMin, zonedParts, zonedTime, zonedMidnight, tzCity, fmtTimeTz } from '../../core/jetlag.js';
import { readTheme, rgba, mixColors } from '../charts.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// CSS : injecté une seule fois, résolu depuis document.baseURI (le site est servi sous /kairos/)
// ---------------------------------------------------------------------------------------------
function ensureCss(file) {
  const url = new URL(file, document.baseURI).href;
  const found = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((l) => l.href === url);
  if (found) return found.sheet ? Promise.resolve() : new Promise((r) => { found.addEventListener('load', r, { once: true }); setTimeout(r, 1200); });
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = url;
    l.addEventListener('load', resolve, { once: true });
    l.addEventListener('error', resolve, { once: true });
    document.head.appendChild(l);
    setTimeout(resolve, 1200);
  });
}

// ---------------------------------------------------------------------------------------------
// Villes : [nom, fuseau IANA, latitude, longitude, pays]. Les décalages sont calculés par tzOffsetMin.
// ---------------------------------------------------------------------------------------------
const CITIES = [
  ['Paris', 'Europe/Paris', 48.86, 2.35, 'France'], ['Londres', 'Europe/London', 51.51, -0.13, 'Royaume-Uni'],
  ['Dublin', 'Europe/Dublin', 53.35, -6.26, 'Irlande'], ['Lisbonne', 'Europe/Lisbon', 38.72, -9.14, 'Portugal'],
  ['Madrid', 'Europe/Madrid', 40.42, -3.7, 'Espagne'], ['Bruxelles', 'Europe/Brussels', 50.85, 4.35, 'Belgique'],
  ['Amsterdam', 'Europe/Amsterdam', 52.37, 4.9, 'Pays-Bas'], ['Genève', 'Europe/Zurich', 46.2, 6.14, 'Suisse'],
  ['Berlin', 'Europe/Berlin', 52.52, 13.4, 'Allemagne'], ['Rome', 'Europe/Rome', 41.9, 12.5, 'Italie'],
  ['Varsovie', 'Europe/Warsaw', 52.23, 21.01, 'Pologne'], ['Stockholm', 'Europe/Stockholm', 59.33, 18.07, 'Suède'],
  ['Helsinki', 'Europe/Helsinki', 60.17, 24.94, 'Finlande'], ['Athènes', 'Europe/Athens', 37.98, 23.73, 'Grèce'],
  ['Istanbul', 'Europe/Istanbul', 41.01, 28.98, 'Turquie'], ['Moscou', 'Europe/Moscow', 55.75, 37.62, 'Russie'],
  ['Reykjavik', 'Atlantic/Reykjavik', 64.15, -21.94, 'Islande'],
  ['Casablanca', 'Africa/Casablanca', 33.57, -7.59, 'Maroc'], ['Alger', 'Africa/Algiers', 36.75, 3.06, 'Algérie'],
  ['Tunis', 'Africa/Tunis', 36.8, 10.18, 'Tunisie'], ['Le Caire', 'Africa/Cairo', 30.04, 31.24, 'Égypte'],
  ['Dakar', 'Africa/Dakar', 14.72, -17.47, 'Sénégal'], ['Abidjan', 'Africa/Abidjan', 5.36, -4.01, 'Côte d\'Ivoire'],
  ['Lagos', 'Africa/Lagos', 6.52, 3.38, 'Nigéria'], ['Kinshasa', 'Africa/Kinshasa', -4.32, 15.31, 'RD Congo'],
  ['Addis-Abeba', 'Africa/Addis_Ababa', 9.03, 38.74, 'Éthiopie'], ['Nairobi', 'Africa/Nairobi', -1.29, 36.82, 'Kenya'],
  ['Johannesburg', 'Africa/Johannesburg', -26.2, 28.05, 'Afrique du Sud'], ['Antananarivo', 'Indian/Antananarivo', -18.88, 47.51, 'Madagascar'],
  ['Saint-Denis', 'Indian/Reunion', -20.88, 55.45, 'La Réunion'], ['Port-Louis', 'Indian/Mauritius', -20.16, 57.5, 'Maurice'],
  ['Beyrouth', 'Asia/Beirut', 33.89, 35.5, 'Liban'], ['Tel Aviv', 'Asia/Jerusalem', 32.08, 34.78, 'Israël'],
  ['Riyad', 'Asia/Riyadh', 24.71, 46.68, 'Arabie saoudite'], ['Téhéran', 'Asia/Tehran', 35.69, 51.39, 'Iran'],
  ['Doha', 'Asia/Qatar', 25.29, 51.53, 'Qatar'], ['Dubaï', 'Asia/Dubai', 25.2, 55.27, 'Émirats arabes unis'],
  ['Kaboul', 'Asia/Kabul', 34.53, 69.17, 'Afghanistan'], ['Tachkent', 'Asia/Tashkent', 41.3, 69.24, 'Ouzbékistan'],
  ['Delhi', 'Asia/Kolkata', 28.61, 77.21, 'Inde'], ['Mumbai', 'Asia/Kolkata', 19.08, 72.88, 'Inde'],
  ['Colombo', 'Asia/Colombo', 6.93, 79.86, 'Sri Lanka'], ['Katmandou', 'Asia/Kathmandu', 27.7, 85.32, 'Népal'],
  ['Almaty', 'Asia/Almaty', 43.24, 76.89, 'Kazakhstan'], ['Dacca', 'Asia/Dhaka', 23.81, 90.41, 'Bangladesh'],
  ['Novossibirsk', 'Asia/Novosibirsk', 55.03, 82.92, 'Russie'], ['Bangkok', 'Asia/Bangkok', 13.75, 100.5, 'Thaïlande'],
  ['Hô Chi Minh-Ville', 'Asia/Ho_Chi_Minh', 10.82, 106.63, 'Viêt Nam'], ['Jakarta', 'Asia/Jakarta', -6.2, 106.85, 'Indonésie'],
  ['Singapour', 'Asia/Singapore', 1.35, 103.82, 'Singapour'], ['Kuala Lumpur', 'Asia/Kuala_Lumpur', 3.14, 101.69, 'Malaisie'],
  ['Hong Kong', 'Asia/Hong_Kong', 22.32, 114.17, 'Chine'], ['Pékin', 'Asia/Shanghai', 39.9, 116.4, 'Chine'],
  ['Shanghai', 'Asia/Shanghai', 31.23, 121.47, 'Chine'], ['Taipei', 'Asia/Taipei', 25.03, 121.57, 'Taïwan'],
  ['Manille', 'Asia/Manila', 14.6, 120.98, 'Philippines'], ['Oulan-Bator', 'Asia/Ulaanbaatar', 47.9, 106.9, 'Mongolie'],
  ['Séoul', 'Asia/Seoul', 37.57, 126.98, 'Corée du Sud'], ['Tokyo', 'Asia/Tokyo', 35.68, 139.69, 'Japon'],
  ['Vladivostok', 'Asia/Vladivostok', 43.12, 131.89, 'Russie'],
  ['Perth', 'Australia/Perth', -31.95, 115.86, 'Australie'], ['Adélaïde', 'Australia/Adelaide', -34.93, 138.6, 'Australie'],
  ['Brisbane', 'Australia/Brisbane', -27.47, 153.03, 'Australie'], ['Sydney', 'Australia/Sydney', -33.87, 151.21, 'Australie'],
  ['Melbourne', 'Australia/Melbourne', -37.81, 144.96, 'Australie'], ['Nouméa', 'Pacific/Noumea', -22.27, 166.46, 'Nouvelle-Calédonie'],
  ['Fidji', 'Pacific/Fiji', -18.14, 178.44, 'Fidji'], ['Auckland', 'Pacific/Auckland', -36.85, 174.76, 'Nouvelle-Zélande'],
  ['Papeete', 'Pacific/Tahiti', -17.54, -149.57, 'Polynésie française'], ['Honolulu', 'Pacific/Honolulu', 21.31, -157.86, 'États-Unis'],
  ['Anchorage', 'America/Anchorage', 61.22, -149.9, 'États-Unis'], ['Vancouver', 'America/Vancouver', 49.28, -123.12, 'Canada'],
  ['San Francisco', 'America/Los_Angeles', 37.77, -122.42, 'États-Unis'], ['Los Angeles', 'America/Los_Angeles', 34.05, -118.24, 'États-Unis'],
  ['Phoenix', 'America/Phoenix', 33.45, -112.07, 'États-Unis'], ['Denver', 'America/Denver', 39.74, -104.99, 'États-Unis'],
  ['Mexico', 'America/Mexico_City', 19.43, -99.13, 'Mexique'], ['Chicago', 'America/Chicago', 41.88, -87.63, 'États-Unis'],
  ['Montréal', 'America/Toronto', 45.5, -73.57, 'Canada'], ['Toronto', 'America/Toronto', 43.65, -79.38, 'Canada'],
  ['New York', 'America/New_York', 40.71, -74.01, 'États-Unis'], ['Miami', 'America/New_York', 25.76, -80.19, 'États-Unis'],
  ['Halifax', 'America/Halifax', 44.65, -63.57, 'Canada'], ['La Havane', 'America/Havana', 23.11, -82.37, 'Cuba'],
  ['Panama', 'America/Panama', 8.98, -79.52, 'Panama'], ['Bogota', 'America/Bogota', 4.71, -74.07, 'Colombie'],
  ['Lima', 'America/Lima', -12.05, -77.04, 'Pérou'], ['Caracas', 'America/Caracas', 10.48, -66.9, 'Venezuela'],
  ['Fort-de-France', 'America/Martinique', 14.6, -61.07, 'Martinique'], ['Pointe-à-Pitre', 'America/Guadeloupe', 16.24, -61.53, 'Guadeloupe'],
  ['Cayenne', 'America/Cayenne', 4.92, -52.33, 'Guyane'], ['La Paz', 'America/La_Paz', -16.5, -68.15, 'Bolivie'],
  ['Santiago', 'America/Santiago', -33.45, -70.67, 'Chili'], ['Buenos Aires', 'America/Argentina/Buenos_Aires', -34.6, -58.38, 'Argentine'],
  ['Montevideo', 'America/Montevideo', -34.9, -56.16, 'Uruguay'], ['São Paulo', 'America/Sao_Paulo', -23.55, -46.63, 'Brésil'],
  ['Rio de Janeiro', 'America/Sao_Paulo', -22.91, -43.17, 'Brésil'],
].map(([name, tz, lat, lon, country]) => ({ name, tz, lat, lon, country }));

const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Ville pour un fuseau : première ville connue de ce fuseau, sinon une entrée synthétique (position estimée). */
function cityForTz(tz, ms) {
  const hit = CITIES.find((c) => c.tz === tz);
  if (hit) return hit;
  let off = 0;
  try { off = tzOffsetMin(tz, ms); } catch { /* fuseau inconnu */ }
  return { name: tzCity(tz), tz, lat: 30, lon: Math.max(-180, Math.min(180, off / 4)), country: 'Ton fuseau', synthetic: true };
}

// ---------------------------------------------------------------------------------------------
// Géométrie : sphère, grand cercle, position du Soleil
// ---------------------------------------------------------------------------------------------
const vec = (latDeg, lonDeg) => { const la = latDeg * D2R, lo = lonDeg * D2R; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

function distanceKm(a, b) {
  const va = vec(a.lat, a.lon), vb = vec(b.lat, b.lon);
  return Math.acos(Math.max(-1, Math.min(1, dot(va, vb)))) * 6371;
}

/** Durée de vol estimée (min), arrondie à 5 : trajet porte à porte, vitesse moyenne prudente. */
function estimateFlightMin(a, b) {
  const km = distanceKm(a, b);
  return Math.max(45, Math.round((35 + (km / 820) * 60) / 5) * 5);
}

/** Point du grand cercle entre deux vecteurs unitaires (t ∈ [0,1]). */
function slerp(a, b, t) {
  const om = Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  if (om < 1e-4) return a.slice();
  const s = Math.sin(om);
  const k1 = Math.sin((1 - t) * om) / s, k2 = Math.sin(t * om) / s;
  return [k1 * a[0] + k2 * b[0], k1 * a[1] + k2 * b[1], k1 * a[2] + k2 * b[2]];
}

/** Position du Soleil (formules NOAA simplifiées) : { dec (rad), lon (rad) du point subsolaire }. */
function sunAt(ms) {
  const d = new Date(ms);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000;
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const g = (TAU / 365) * (doy - 1 + (utcMin / 60 - 12) / 24);
  const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const lonDeg = (720 - utcMin - eq) / 4;
  return { dec, lon: lonDeg * D2R, vec: [Math.cos(dec) * Math.cos(lonDeg * D2R), Math.cos(dec) * Math.sin(lonDeg * D2R), Math.sin(dec)] };
}

/** Sinus de la hauteur du Soleil en (lat, lon) à l'instant ms. */
const sunSin = (lat, lon, ms) => dot(vec(lat, lon), sunAt(ms).vec);

// ---------------------------------------------------------------------------------------------
// Terres émergées : contours très simplifiés [lon, lat, lon, lat, …] — de quoi dessiner une carte de points.
// ---------------------------------------------------------------------------------------------
const LAND = [
  // Amérique du Nord et centrale
  [-168, 66, -163, 69, -156, 71, -141, 70, -128, 70, -115, 68, -105, 68, -95, 68, -88, 68, -82, 69, -81, 63, -93, 61, -94, 58, -92, 57, -85, 55, -82, 52, -79, 52, -78, 57, -77, 62, -72, 62, -65, 60, -62, 57, -56, 53, -60, 50, -66, 49, -64, 46, -61, 45.5, -66, 44, -70, 43, -70, 41.7, -74, 40.5, -76, 37, -76, 35, -81, 31, -80, 27, -80.5, 25.2, -82, 26, -83, 29.5, -85, 30, -89, 30, -90, 29, -94, 29.5, -97, 27, -97.5, 22, -96, 19, -94, 18, -91, 19, -90.5, 21, -87, 21, -88, 18, -88, 16, -84, 15.5, -83, 11, -81, 9, -79, 9.3, -77.5, 8.5, -78, 7, -80, 7.5, -83, 8.3, -86, 11, -88, 13, -92, 14.5, -95, 16, -98, 16, -102, 18, -105, 20, -106, 23, -109, 25.5, -112, 29, -115, 31, -117, 32.5, -120.5, 34.5, -122.5, 37.5, -124, 40.5, -124, 46, -124.5, 48.3, -127, 50.5, -130, 54, -134, 58, -138, 59.5, -145, 60.5, -151, 59.5, -154, 57.5, -158, 57, -162, 55, -165, 54.5, -160, 58.5, -165, 60.5, -165, 63, -161, 64.5],
  [-112, 28, -110, 23, -112, 24.5, -114, 27.5, -115, 30], // Basse-Californie
  [-120, 72, -100, 73, -95, 76, -80, 76, -75, 80, -90, 82, -115, 77, -124, 74], // îles arctiques
  [-80, 73, -70, 70, -62, 66.5, -66, 62, -75, 64, -78, 68, -90, 70], // Baffin
  [-73, 78, -60, 82, -30, 83.5, -20, 80, -20, 72, -24, 69, -32, 68, -42, 60, -48, 61, -53, 66, -55, 70, -62, 76], // Groenland
  [-85, 22, -82, 23.2, -77, 21.5, -74.2, 20.2, -78, 20.5, -82, 22.2], // Cuba
  [-74.4, 18.5, -72.5, 19.9, -68.4, 18.7, -71, 17.8], // Hispaniola
  // Amérique du Sud
  [-77.5, 8.5, -75, 11, -72, 12, -68, 10.7, -62, 10.5, -60, 8.5, -57, 6, -52, 5, -50, 1.5, -48, -1, -44, -2.5, -39, -3.5, -35, -5.5, -35, -9, -38.5, -13, -39, -17.5, -41, -22, -44, -23, -48, -26, -48.7, -28.5, -52, -32, -54, -34.5, -57, -35, -58, -38.5, -62, -39, -65, -41, -64.5, -43, -67, -46, -66, -48, -69, -51.5, -68.5, -53.5, -71.5, -54, -74, -52, -75.5, -48, -73.5, -42, -73.5, -37, -71.5, -30, -70.5, -23, -70.3, -18, -76, -14, -79, -8, -81, -5, -80, -2, -80.5, 0.5, -78.5, 2.5, -77.5, 6],
  // Eurasie
  [-9.5, 37, -9.5, 43, -2, 43.5, -1.5, 46, -4.5, 48.3, -1.5, 49.7, 2, 51, 4, 52, 8, 53.6, 8.5, 57, 10.5, 57.5, 10.5, 54.5, 12, 54.2, 19, 54.4, 21, 57, 24, 57.5, 24, 59.5, 30, 60, 22, 60.5, 21.5, 63, 25, 65.5, 22, 65.8, 17.5, 62.5, 17.5, 60, 18.5, 59.5, 16.5, 57, 13, 55.5, 11.5, 58.5, 8, 58, 5.5, 59, 5, 62, 10, 64, 14, 67.5, 19, 70, 26, 71, 31, 70, 40, 67.5, 41, 66, 35, 64, 38, 64.5, 44, 66, 44, 68.5, 53, 68.5, 60, 69, 68, 68.5, 69, 73, 75, 72.5, 80, 73, 87, 75, 100, 77, 105, 77.5, 113, 74, 120, 73, 130, 71, 140, 72.5, 150, 71.5, 160, 70, 170, 70, 180, 68.5, 180, 65, 178, 62.5, 170, 60, 164, 60, 163, 57, 156.5, 51, 155.5, 57, 151, 59.5, 143, 59.5, 137, 54, 141, 53, 140, 48, 135, 43.5, 131, 42.5, 129.5, 40.5, 127.5, 39.5, 129, 35.5, 126.5, 34.5, 126.5, 37.5, 125, 39.5, 121.5, 39, 122, 40.5, 118, 39, 119, 37, 122.5, 37, 120, 35, 121.5, 31.5, 122, 29.5, 119.5, 25.5, 117, 23.5, 113, 22.2, 110.5, 21, 108, 21.5, 106, 19.5, 108.5, 15, 109, 12, 105, 8.7, 104.8, 10.5, 100.5, 13.5, 99.5, 10, 100.5, 7, 103.5, 4, 104, 1.4, 101, 2.8, 98.5, 8, 98.3, 13, 97.5, 16.5, 94, 16, 94.5, 19, 92, 21.5, 90, 22, 87, 21.5, 85, 19.5, 82, 16.5, 80, 15, 80.3, 11, 79.5, 8.5, 77, 8, 76, 10, 74, 14.5, 72.8, 19, 72.7, 21.5, 70.5, 20.8, 69, 22.5, 67, 24.8, 61.5, 25.2, 57.5, 25.8, 56.5, 27, 54, 26.7, 51, 28.5, 48.5, 30, 48, 29.5, 50.5, 26, 51.5, 24.5, 54, 24.2, 56.3, 26.2, 56.7, 24.5, 59, 22.5, 57.8, 19, 55, 17, 52, 16, 47, 13.5, 43.5, 12.7, 43, 16, 39, 21.5, 35, 28, 34.9, 29.5, 34.5, 31.3, 35, 34, 36, 36.5, 30, 36.3, 27.5, 36.8, 26.5, 39, 26, 40.5, 23, 40, 22.5, 36.5, 21, 38, 19.5, 40.5, 19, 42, 15.5, 45, 13.5, 45.5, 12.5, 44.5, 16, 41.5, 18.5, 40.2, 16, 38, 15.7, 40, 12, 42, 10, 44, 8.5, 44.3, 6, 43, 3.5, 43.3, 3, 42, 0.5, 40.5, -0.5, 38.5, -2, 36.8, -5.5, 36, -6.5, 37],
  // Afrique
  [-9.8, 30, -6, 35.8, -2, 35.2, 3, 36.8, 10, 37.2, 11, 35, 10, 33.5, 15, 32.5, 20, 32, 20, 30.5, 25, 31.5, 32, 31.2, 32.5, 29.9, 34, 27, 37, 21, 39, 15.5, 41.5, 13.5, 43, 11.8, 44, 10.5, 51, 11.8, 51, 10.4, 47.5, 4.5, 43, 0, 41, -2.5, 39.2, -6, 40.5, -10.5, 40.5, -15, 35, -19.5, 35.5, -24, 32.8, -26, 32.5, -29, 28.5, -32.5, 25, -34, 20, -34.8, 18.3, -34, 17.5, -30, 15, -26.5, 14.5, -22.5, 11.8, -17, 13.5, -12, 13.2, -9, 12.2, -6, 9, -1, 9.5, 3.8, 8.5, 4.5, 5, 6, 1.5, 6, -3, 5, -7.5, 4.4, -12, 7.5, -14.5, 10.5, -17, 14.5, -17.2, 21, -14.5, 26.5],
  [44, -25, 47, -25, 49.5, -15, 49.2, -12, 47.5, -14, 44, -17, 43.5, -22.5], // Madagascar
  // Îles
  [-5.5, 50, 1.5, 51, 1.7, 53, -0.5, 54.5, -2, 56.5, -2, 57.7, -4, 58.6, -6, 58, -5.5, 56, -3, 55, -3.2, 54.2, -4.8, 53.5, -4.5, 52, -5.2, 51.5, -3, 51.3], // Grande-Bretagne
  [-10, 51.7, -6, 52, -6, 54.2, -8, 55.2, -10, 54], // Irlande
  [-24, 65.5, -22, 66.4, -16, 66.4, -13.5, 65, -18, 63.4, -22, 63.8], // Islande
  [130.5, 31.5, 132, 34, 135, 33.5, 137, 34.5, 140, 35, 141, 38.5, 141.5, 41, 140, 40, 139.5, 38, 136.5, 37, 133, 35.5, 130.5, 34.5], // Honshu
  [140, 42, 141.5, 45.3, 145.5, 43.3, 143, 42], // Hokkaido
  [95.3, 5.5, 98, 4, 103.5, -1, 106, -3.5, 105.8, -5.8, 102, -4, 98.5, 0.5], // Sumatra
  [109, 1.5, 111, 1.5, 114, 4.5, 117.5, 7, 119, 5, 118, 1, 116.5, -3.5, 114, -3.5, 110.2, -2.8, 109, -0.5], // Bornéo
  [105.2, -6.5, 108, -6.5, 111, -6.8, 114.5, -7.7, 114.4, -8.7, 108, -7.8, 105.5, -6.8], // Java
  [119.5, -5.5, 120.5, -3, 121, 1, 125, 1.5, 120, -1, 123, -4.5, 122, -5.5], // Sulawesi
  [131, -1, 135, -3.3, 141, -2.6, 147, -6, 150.5, -10.5, 146, -8, 143, -9, 138, -8.2, 138, -5, 133, -4], // Nouvelle-Guinée
  [120, 18.5, 122.5, 18.3, 122, 14, 124, 12.5, 120.5, 14, 120, 16.5], // Luçon
  [122, 7, 126, 9.5, 126, 6.5, 124, 6], // Mindanao
  [80, 9.6, 81.8, 7.5, 80.5, 6, 79.8, 8.5], // Sri Lanka
  [120.2, 23, 121.5, 25.2, 122, 24, 120.8, 22], // Taïwan
  // Océanie et Antarctique
  [114, -22, 122, -18, 126, -14, 130, -12, 132, -11.5, 136, -12, 137, -15.5, 140, -17.5, 142, -10.8, 145.5, -15, 146.5, -19, 150, -22.5, 153, -26, 153, -30, 150.5, -35.5, 147.5, -38.2, 143.5, -38.8, 140, -38, 138, -35.5, 135.5, -34.7, 131, -31.5, 124, -33.5, 118, -35, 115, -34.3, 115, -30, 113.5, -26],
  [145, -41, 148.2, -41, 147, -43.6, 145.5, -42.7], // Tasmanie
  [173, -35, 175.5, -37, 178.3, -37.8, 175, -41.5, 174.5, -39.5], // Nouvelle-Zélande (nord)
  [172.7, -40.5, 174, -41.5, 171, -44.5, 169, -46.5, 166.5, -46, 168.5, -44], // Nouvelle-Zélande (sud)
  [-180, -90, -180, -77, -150, -78, -120, -74, -100, -72, -75, -73, -65, -68, -60, -75, -45, -78, -20, -72, 0, -70, 30, -69, 60, -67, 90, -66, 120, -66, 150, -69, 165, -72, 180, -77, 180, -90],
].map((flat) => { const pts = []; for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]); return pts; });

// Mers intérieures (retirées des terres)
const WATER = [
  [28, 41.2, 31, 41.2, 35, 42, 38, 41, 41.5, 41.5, 41.5, 43, 37.5, 44.5, 36.5, 45.2, 33, 45, 32, 46.5, 30.5, 46.2, 29.5, 45, 28.5, 43.5], // mer Noire
  [47, 44, 50, 46.5, 53, 45, 53, 41, 54, 37.3, 50, 37, 49, 40, 47.5, 42], // mer Caspienne
].map((flat) => { const pts = []; for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]); return pts; });

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const isLand = (lon, lat) => LAND.some((p) => inPoly(p, lon, lat)) && !WATER.some((p) => inPoly(p, lon, lat));

let DOTS = null;
/** Réseau de points quasi uniforme sur la sphère : { land: Float32Array (x,y,z…), sea: Float32Array }. */
function worldDots() {
  if (DOTS) return DOTS;
  const land = [], sea = [], step = 2.1;
  let row = 0;
  for (let lat = -88; lat <= 88; lat += step, row++) {
    const k = Math.max(0.05, Math.cos(lat * D2R)), dl = Math.min(60, step / k);
    for (let lon = -180 + (row % 2 ? dl / 2 : 0); lon < 180; lon += dl) {
      const v = vec(lat, lon);
      (isLand(lon, lat) ? land : sea).push(v[0], v[1], v[2]);
    }
  }
  DOTS = { land: Float32Array.from(land), sea: Float32Array.from(sea) };
  return DOTS;
}

// ---------------------------------------------------------------------------------------------
// Globe : canvas 2D, projection orthographique, jour/nuit, terminateur, arc du vol, avion
// ---------------------------------------------------------------------------------------------
function createGlobe(canvas) {
  const reduced = prefersReducedMotion();
  const st = {
    lat0: 25 * D2R, lon0: 10 * D2R, zoom: 1, tMs: Date.now(), A: null, B: null, prog: 0, flying: false,
    tgt: null, vLon: 0, vLat: 0, drag: null, w: 0, h: 0, dpr: 1, visible: true, raf: 0, dirty: true, theme: null, time: 0,
  };
  const ctx2 = canvas.getContext('2d');
  const dots = worldDots();
  const NB = 12;
  const buckets = Array.from({ length: NB }, () => []);
  const cityVecs = CITIES.map((c) => ({ v: vec(c.lat, c.lon), c }));

  const readTheme_ = () => { st.theme = readTheme(canvas); };
  readTheme_();

  const basis = () => {
    const sl = Math.sin(st.lon0), cl = Math.cos(st.lon0), sp = Math.sin(st.lat0), cp = Math.cos(st.lat0);
    return { ex: [-sl, cl, 0], ey: [-sp * cl, -sp * sl, cp], ez: [cp * cl, cp * sl, sp] };
  };

  function measure() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (w !== st.w || hh !== st.h || dpr !== st.dpr) {
      st.w = w; st.h = hh; st.dpr = dpr; canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); st.dirty = true;
    }
  }

  function draw() {
    const g = ctx2, th = st.theme, W = st.w, H = st.h;
    if (!W || !H) return;
    g.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 * 0.84 * st.zoom;
    const { ex, ey, ez } = basis();
    const sun = sunAt(st.tMs);
    const proj = (p) => [dot(p, ex), dot(p, ey), dot(p, ez)];
    const dark = th.isDark;
    const dayC = dark ? th.sunHot : th.sunDeep;
    const nightC = dark ? mixColors(th.night, th.bg, 0.2) : th.nightDeep;
    const sx = dot(sun.vec, ex), sy = dot(sun.vec, ey), sz = dot(sun.vec, ez);

    // halo extérieur : bleu-vert partout, or du côté du soleil
    let gr = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.32);
    gr.addColorStop(0, rgba(th.night, dark ? 0.26 : 0.2)); gr.addColorStop(1, rgba(th.night, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 1.32, 0, TAU); g.fill();
    const hx = cx + sx * R * 0.55, hy = cy - sy * R * 0.55;
    gr = g.createRadialGradient(hx, hy, R * 0.2, hx, hy, R * 1.45);
    gr.addColorStop(0, rgba(th.sun, (dark ? 0.2 : 0.26) * (0.45 + 0.55 * Math.max(0, sz + 0.4)))); gr.addColorStop(1, rgba(th.sun, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, R * 1.45, 0, TAU); g.fill();

    // sphère
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.clip();
    gr = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R * 1.05);
    gr.addColorStop(0, rgba(mixColors(th.surface3, th.night, 0.1), 1)); gr.addColorStop(1, rgba(mixColors(th.surface, th.bg, 0.5), 1));
    g.fillStyle = gr; g.fillRect(cx - R, cy - R, R * 2, R * 2);
    // lumière du jour qui lèche la sphère
    const lx = cx + sx * R * 0.7, ly = cy - sy * R * 0.7;
    gr = g.createRadialGradient(lx, ly, 0, lx, ly, R * 1.3);
    gr.addColorStop(0, rgba(th.sun, dark ? 0.2 : 0.22)); gr.addColorStop(0.6, rgba(th.sun, dark ? 0.04 : 0.06)); gr.addColorStop(1, rgba(th.sun, 0));
    g.fillStyle = gr; g.fillRect(cx - R, cy - R, R * 2, R * 2);

    // graticule
    g.lineWidth = 1; g.strokeStyle = rgba(th.text, dark ? 0.05 : 0.07);
    const line = (pts) => {
      g.beginPath(); let pen = false;
      for (const p of pts) { const q = proj(p); if (q[2] > 0) { const X = cx + q[0] * R, Y = cy - q[1] * R; pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true; } else pen = false; }
      g.stroke();
    };
    for (let lo = -180; lo < 180; lo += 30) { const pts = []; for (let la = -90; la <= 90; la += 5) pts.push(vec(la, lo)); line(pts); }
    for (let la = -60; la <= 60; la += 30) { const pts = []; for (let lo = -180; lo <= 180; lo += 5) pts.push(vec(la, lo)); line(pts); }

    // points : mer puis terre, par seaux de luminosité
    const drawDots = (arr, kind) => {
      for (const b of buckets) b.length = 0;
      const sv = sun.vec;
      for (let i = 0; i < arr.length; i += 3) {
        const a = arr[i], b = arr[i + 1], c = arr[i + 2];
        const z = a * ez[0] + b * ez[1] + c * ez[2]; if (z <= 0.02) continue;
        const e = a * sv[0] + b * sv[1] + c * sv[2];
        const t = Math.min(1, Math.max(0, (e + 0.12) / 0.24));
        buckets[Math.round(t * (NB - 1))].push(cx + (a * ex[0] + b * ex[1] + c * ex[2]) * R, cy - (a * ey[0] + b * ey[1] + c * ey[2]) * R, z);
      }
      const base = kind === 'land' ? R * 0.0105 : R * 0.0048;
      for (let k = 0; k < NB; k++) {
        const arr2 = buckets[k]; if (!arr2.length) continue;
        const t = k / (NB - 1);
        const col = mixColors(nightC, dayC, t);
        const alpha = kind === 'land' ? (dark ? 0.55 : 0.62) + 0.45 * t : (dark ? 0.1 : 0.12) + 0.14 * t;
        g.fillStyle = rgba(col, Math.min(1, alpha)); g.beginPath();
        for (let i = 0; i < arr2.length; i += 3) { const r = base * (0.45 + 0.55 * arr2[i + 2]); g.moveTo(arr2[i] + r, arr2[i + 1]); g.arc(arr2[i], arr2[i + 1], r, 0, TAU); }
        g.fill();
      }
    };
    drawDots(dots.sea, 'sea');
    drawDots(dots.land, 'land');

    // lumières de villes, côté nuit
    for (const { v, c } of cityVecs) {
      const z = dot(v, ez); if (z <= 0.05) continue;
      const e = dot(v, sun.vec); if (e > 0.08) continue;
      const a = Math.min(1, (0.08 - e) * 6) * 0.9;
      const X = cx + dot(v, ex) * R, Y = cy - dot(v, ey) * R;
      g.fillStyle = rgba(th.sunHot, a * (dark ? 0.9 : 0.6)); g.beginPath(); g.arc(X, Y, Math.max(0.9, R * 0.0045), 0, TAU); g.fill();
      void c;
    }

    // terminateur
    {
      const s = sun.vec, a0 = Math.abs(s[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const u = unit([s[1] * a0[2] - s[2] * a0[1], s[2] * a0[0] - s[0] * a0[2], s[0] * a0[1] - s[1] * a0[0]]);
      const vv = [s[1] * u[2] - s[2] * u[1], s[2] * u[0] - s[0] * u[2], s[0] * u[1] - s[1] * u[0]];
      const pts = []; for (let i = 0; i <= 180; i++) { const a = (i / 180) * TAU; pts.push([u[0] * Math.cos(a) + vv[0] * Math.sin(a), u[1] * Math.cos(a) + vv[1] * Math.sin(a), u[2] * Math.cos(a) + vv[2] * Math.sin(a)]); }
      g.save(); g.lineCap = 'round';
      for (const [w, a] of [[7, 0.07], [3, 0.16], [1.2, 0.55]]) {
        g.lineWidth = w; g.strokeStyle = rgba(th.sunHot, a * (dark ? 1 : 0.8)); g.beginPath(); let pen = false;
        for (const p of pts) { const q = proj(p); if (q[2] > 0) { const X = cx + q[0] * R, Y = cy - q[1] * R; pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true; } else pen = false; }
        g.stroke();
      }
      g.restore();
    }
    g.restore();

    // reflet de bord (limbe)
    g.lineWidth = 1.5; g.strokeStyle = rgba(mixColors(th.night, th.sunHot, Math.max(0, Math.min(1, sz * 0.5 + 0.5))), dark ? 0.5 : 0.4);
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();

    // arc du vol
    if (st.A && st.B) drawRoute(g, th, cx, cy, R, ex, ey, ez, proj);
  }

  function drawRoute(g, th, cx, cy, R, ex, ey, ez, proj) {
    const { A, B } = st;
    const va = A.v, vb = B.v, om = Math.acos(Math.max(-1, Math.min(1, dot(va, vb))));
    const lift = (t) => 0.02 + 0.2 * Math.min(1, om / 1.6 + 0.25) * Math.sin(Math.PI * t);
    const at = (t) => { const p = slerp(va, vb, t); const r = 1 + lift(t); return [p[0] * r, p[1] * r, p[2] * r]; };
    const screen = (t) => { const p = at(t), q = proj(p); const hidden = q[2] < 0 && q[0] * q[0] + q[1] * q[1] < 1; return { x: cx + q[0] * R, y: cy - q[1] * R, hidden }; };
    const N = 90, pts = []; for (let i = 0; i <= N; i++) pts.push(screen(i / N));
    const prog = st.prog;
    const stroke = (from, to, w, color, dash) => {
      g.lineWidth = w; g.strokeStyle = color; g.setLineDash(dash || []); g.beginPath(); let pen = false;
      for (let i = Math.floor(from * N); i <= Math.ceil(to * N); i++) {
        const p = pts[Math.min(N, i)]; if (p.hidden) { pen = false; continue; }
        pen ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); pen = true;
      }
      g.stroke(); g.setLineDash([]);
    };
    g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
    // partie à venir : pointillés
    stroke(prog, 1, 1.6, rgba(th.text, 0.4), [2, 6]);
    // partie parcourue : trait lumineux
    if (prog > 0) {
      stroke(0, prog, 9, rgba(th.sun, 0.14));
      stroke(0, prog, 4, rgba(th.sun, 0.3));
      stroke(0, prog, 2, rgba(th.sunHot, 1));
    }
    g.restore();
    // épingles
    const pin = (c, color, label, local) => {
      const q = proj(c.v); if (q[2] <= 0.02) return;
      const X = cx + q[0] * R, Y = cy - q[1] * R;
      const ph = reduced ? 0.4 : (st.time / 1800 + (c === A ? 0 : 0.5)) % 1;
      g.strokeStyle = rgba(color, (1 - ph) * 0.7); g.lineWidth = 1.5; g.beginPath(); g.arc(X, Y, 5 + ph * 17, 0, TAU); g.stroke();
      g.fillStyle = rgba(color, 0.25); g.beginPath(); g.arc(X, Y, 9, 0, TAU); g.fill();
      g.fillStyle = rgba(color, 1); g.beginPath(); g.arc(X, Y, 4.2, 0, TAU); g.fill();
      g.strokeStyle = rgba(th.bg, 0.9); g.lineWidth = 1.5; g.stroke();
      // étiquette
      g.font = `600 11.5px ${th.fontSans}`; const t1 = label, t2 = local;
      g.font = `600 11.5px ${th.fontSans}`; const w1 = g.measureText(t1).width; g.font = `500 11px ${th.fontMono}`; const w2 = g.measureText(t2).width;
      const bw = w1 + w2 + 22, bh = 24; let bx = X + 12, by = Y - 32; if (bx + bw > st.w - 4) bx = X - 12 - bw; if (by < 4) by = Y + 10; bx = Math.max(4, bx);
      g.fillStyle = rgba(th.bg, th.isDark ? 0.78 : 0.86); g.strokeStyle = rgba(color, 0.55); g.lineWidth = 1;
      g.beginPath(); g.roundRect ? g.roundRect(bx, by, bw, bh, 12) : g.rect(bx, by, bw, bh); g.fill(); g.stroke();
      g.textBaseline = 'middle'; g.textAlign = 'left'; g.font = `600 11.5px ${th.fontSans}`; g.fillStyle = rgba(th.text, 1); g.fillText(t1, bx + 10, by + bh / 2 + 0.5);
      g.font = `500 11px ${th.fontMono}`; g.fillStyle = rgba(color, 1); g.fillText(t2, bx + 14 + w1, by + bh / 2 + 0.5);
    };
    pin(A, th.sun, A.name, fmtTimeTz(A.tz, st.tMs));
    pin(B, th.night, B.name, fmtTimeTz(B.tz, st.tMs));
    // avion
    if (prog > 0.001 && prog < 0.999) {
      const p0 = screen(Math.max(0, prog - 0.01)), p1 = screen(Math.min(1, prog + 0.01)), p = screen(prog);
      if (!p.hidden) {
        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x), s = Math.max(8, R * 0.05);
        const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, s * 3);
        grad.addColorStop(0, rgba(th.sunHot, 0.55)); grad.addColorStop(1, rgba(th.sunHot, 0));
        g.fillStyle = grad; g.beginPath(); g.arc(p.x, p.y, s * 3, 0, TAU); g.fill();
        g.save(); g.translate(p.x, p.y); g.rotate(ang); g.scale(s, s);
        g.beginPath();
        const half = [[1, 0], [0.55, 0.09], [0.12, 0.11], [-0.18, 0.86], [-0.36, 0.86], [-0.24, 0.1], [-0.64, 0.08], [-0.8, 0.36], [-0.94, 0.36], [-0.86, 0]];
        half.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        for (let i = half.length - 1; i >= 0; i--) g.lineTo(half[i][0], -half[i][1]);
        g.closePath(); g.fillStyle = rgba(th.sunHot, 1); g.fill(); g.lineWidth = 0.1; g.strokeStyle = rgba(th.bg, 0.9); g.stroke();
        g.restore();
      }
    }
  }

  function frame(ts) {
    st.raf = 0;
    const dt = Math.min(0.05, st.time ? (ts - st.time) / 1000 : 0.016); st.time = ts;
    let moving = false;
    if (st.drag) moving = true;
    else if (Math.abs(st.vLon) > 1e-4 || Math.abs(st.vLat) > 1e-4) {
      st.lon0 += st.vLon * dt; st.lat0 = Math.max(-1.25, Math.min(1.25, st.lat0 + st.vLat * dt));
      const f = Math.pow(0.04, dt); st.vLon *= f; st.vLat *= f; moving = true;
    } else if (st.tgt) {
      const k = 1 - Math.pow(0.002, dt);
      let dLon = st.tgt.lon - st.lon0; dLon = ((dLon + Math.PI) % TAU + TAU) % TAU - Math.PI;
      st.lon0 += dLon * k; st.lat0 += (st.tgt.lat - st.lat0) * k; st.zoom += (st.tgt.zoom - st.zoom) * k;
      if (Math.abs(dLon) < 1e-3 && Math.abs(st.tgt.lat - st.lat0) < 1e-3 && Math.abs(st.tgt.zoom - st.zoom) < 1e-3) st.tgt = null;
      moving = true;
    }
    const animated = !reduced && st.visible && st.A; // pulsation des épingles
    if (st.dirty || moving || animated) { st.dirty = false; draw(); }
    if ((moving || animated) && st.visible && !document.hidden) st.raf = requestAnimationFrame(frame); else st.time = 0;
  }
  const kick = () => { if (!st.raf) st.raf = requestAnimationFrame(frame); };
  const invalidate = () => { st.dirty = true; kick(); };

  const ro = new ResizeObserver(() => { measure(); invalidate(); }); ro.observe(canvas);
  const io = new IntersectionObserver((es) => { st.visible = es[es.length - 1].isIntersecting; if (st.visible) invalidate(); }); io.observe(canvas);
  const mo = new MutationObserver(() => { readTheme_(); invalidate(); }); mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  const mq = matchMedia('(prefers-color-scheme: dark)'); const onMq = () => { readTheme_(); invalidate(); }; mq.addEventListener && mq.addEventListener('change', onMq);
  measure();

  // glisser pour tourner
  let last = null;
  const down = (e) => { canvas.setPointerCapture(e.pointerId); st.drag = true; st.tgt = null; st.vLon = st.vLat = 0; last = { x: e.clientX, y: e.clientY, t: performance.now() }; kick(); };
  const move = (e) => {
    if (!st.drag || !last) return;
    const R = Math.min(st.w, st.h) / 2 * 0.84 * st.zoom, dx = e.clientX - last.x, dy = e.clientY - last.y, now = performance.now(), dt = Math.max(8, now - last.t) / 1000;
    const dLon = -dx / R / Math.max(0.35, Math.cos(st.lat0)) * 0.9, dLat = dy / R * 0.9;
    st.lon0 += dLon; st.lat0 = Math.max(-1.25, Math.min(1.25, st.lat0 + dLat));
    st.vLon = dLon / dt; st.vLat = dLat / dt; last = { x: e.clientX, y: e.clientY, t: now }; st.dirty = true; kick();
  };
  const up = () => { st.drag = null; last = null; kick(); };
  const key = (e) => {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key]; if (!k) return;
    e.preventDefault(); st.tgt = null; st.vLon = k[0] * 1.6; st.vLat = k[1] * 1.2; kick();
  };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('keydown', key);

  return {
    setRoute(A, B) {
      st.A = A ? { ...A, v: vec(A.lat, A.lon) } : null; st.B = B ? { ...B, v: vec(B.lat, B.lon) } : null;
      if (st.A && st.B) {
        const mid = unit(slerp(st.A.v, st.B.v, 0.5)), om = Math.acos(Math.max(-1, Math.min(1, dot(st.A.v, st.B.v))));
        const tgt = { lat: Math.asin(Math.max(-1, Math.min(1, mid[2]))) * 0.85, lon: Math.atan2(mid[1], mid[0]), zoom: Math.max(1, Math.min(1.14, 1.3 - om * 0.3)) };
        if (om > 3.0) { tgt.lat = 0.45; tgt.lon = st.A.v[1] === 0 && st.A.v[0] === 0 ? 0 : Math.atan2(st.A.v[1], st.A.v[0]); }
        if (reduced) { st.lat0 = tgt.lat; st.lon0 = tgt.lon; st.zoom = tgt.zoom; } else st.tgt = tgt;
      }
      invalidate();
    },
    recenter() { if (st.A && st.B) this.setRoute(st.A, st.B); },
    setTime(tMs, prog) { st.tMs = tMs; st.prog = Math.max(0, Math.min(1, prog)); invalidate(); },
    destroy() { cancelAnimationFrame(st.raf); ro.disconnect(); io.disconnect(); mo.disconnect(); mq.removeEventListener && mq.removeEventListener('change', onMq); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('keydown', key); },
  };
}

// ---------------------------------------------------------------------------------------------
// Formats et petits utilitaires
// ---------------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const num1 = (x) => (Math.round(x * 10) / 10).toString().replace('.', ',');
const dur = (min) => { const m = Math.round(min); if (m < 60) return `${m} min`; const hh = Math.floor(m / 60), r = m % 60; return r ? `${hh} h ${pad(r)}` : `${hh} h`; };
function offsetLabel(tz, ms) {
  let m = 0; try { m = tzOffsetMin(tz, ms); } catch { /* ignoré */ }
  const s = m < 0 ? '−' : '+', a = Math.abs(m), hh = Math.floor(a / 60), mm = a % 60;
  return `UTC${s}${hh}${mm ? `:${pad(mm)}` : ''}`;
}
function toInput(tz, ms) { const p = zonedParts(tz, ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`; }
function fromInput(tz, s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s || ''); if (!m) return null;
  return zonedTime(tz, +m[1], +m[2], +m[3], +m[4] + +m[5] / 60);
}
const dayFmt = (tz, ms) => { try { return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ms); } catch { return ''; } };
const dateTimeFmt = (tz, ms) => { try { return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(ms); } catch { return ''; } };

const PRESETS = ['New York', 'Los Angeles', 'Tokyo', 'Dubaï', 'Sydney', 'Reykjavik', 'São Paulo'];
const STORE_KEY = 'kairos.trip.v1';

// ---------------------------------------------------------------------------------------------
// Vue
// ---------------------------------------------------------------------------------------------
export default {
  id: 'travel',
  title: 'Voyage',
  icon: 'plane',
  async mount(root, ctx) {
    await ensureCss('css/views-travel.css');
    const reduced = prefersReducedMotion();
    const cleanups = [];
    const nowMs = () => ctx.nowMs();
    const profileTz = () => (ctx.state.profile && ctx.state.profile.tz) || 'Europe/Paris';

    // --- état de la vue ---
    const S = { origin: null, dest: null, dep: 0, arr: 0, arrManual: false, plan: null, error: null, t: 0, playing: false, applied: [], tMin: 0, tMax: 1 };
    {
      const o = cityForTz(profileTz(), nowMs());
      let saved = null; try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* ignoré */ }
      S.origin = o;
      const wanted = saved && CITIES.find((c) => c.name === saved.dest);
      S.dest = wanted && wanted.tz !== o.tz ? wanted : (CITIES.find((c) => c.name === (o.lon > -30 && o.lon < 60 ? 'New York' : 'Paris')) || CITIES[0]);
      if (S.dest.tz === o.tz) S.dest = CITIES.find((c) => c.tz !== o.tz);
      const p = zonedParts(o.tz, nowMs());
      S.dep = zonedTime(o.tz, p.y, p.mo, p.d + 3, 11);
      S.arr = S.dep + estimateFlightMin(S.origin, S.dest) * MIN;
    }
    const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ dest: S.dest.name })); } catch { /* ignoré */ } };

    // --- squelette ---
    const uid = uniqueId('tv');
    const heroNum = h('span', { class: 'tv-hero__num', 'aria-hidden': 'true' }, '0');
    const heroSign = h('span', { class: 'tv-hero__sign', 'aria-hidden': 'true' }, '+');
    const heroDir = h('p', { class: 'tv-hero__dir' });
    const heroSr = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    const hero = h('section', { class: 'card card--hero tv-hero', 'data-dir': 'none', 'aria-labelledby': `${uid}-t` },
      h('div', { class: 'tv-hero__copy' },
        h('span', { class: 'hero__eyebrow' }, 'Anti-décalage horaire'),
        h('h2', { class: 'hero__title', id: `${uid}-t` }, 'Arrive ', h('em', null, 'réveillé'), ', pas décalé.'),
        h('p', { class: 'lead' }, 'Dis-nous d\'où tu pars et où tu vas : Kairos règle ton sommeil et ta lumière, jour après jour, pour que ton horloge interne te rejoigne plus vite.')),
      h('div', { class: 'tv-hero__meter' }, h('div', { class: 'tv-hero__big' }, heroSign, heroNum, h('span', { class: 'tv-hero__unit' }, 'h')), heroDir, heroSr));

    // formulaire
    const pickBtn = (which) => {
      const b = h('button', { class: 'tv-pick', type: 'button', 'data-which': which, onclick: () => openPicker(which) });
      return b;
    };
    const bOrigin = pickBtn('origin'), bDest = pickBtn('dest');
    const swapBtn = h('button', { class: 'tv-swap iconbtn', type: 'button', 'aria-label': 'Inverser départ et arrivée', onclick: () => { [S.origin, S.dest] = [S.dest, S.origin]; S.arrManual = false; changed({ reroute: true }); haptic(8); } }, icon('repeat', { size: 20 }));
    const inDep = h('input', { class: 'input', type: 'datetime-local', id: `${uid}-dep`, onchange: (e) => { const v = fromInput(S.origin.tz, e.target.value); if (v) { const flight = S.arr - S.dep; S.dep = v; if (!S.arrManual) S.arr = S.dep + estimateFlightMin(S.origin, S.dest) * MIN; else S.arr = S.dep + flight; changed(); } } });
    const inArr = h('input', { class: 'input', type: 'datetime-local', id: `${uid}-arr`, onchange: (e) => { const v = fromInput(S.dest.tz, e.target.value); if (v) { S.arr = v; S.arrManual = true; changed(); } } });
    const hintDep = h('span', { class: 'hint' }), hintArr = h('span', { class: 'hint' });
    const flightInfo = h('div', { class: 'tv-flight' });
    const presets = h('div', { class: 'tv-presets', role: 'group', 'aria-label': 'Destinations rapides' });
    const form = h('section', { class: 'card tv-form', 'aria-label': 'Ton voyage' },
      h('div', { class: 'tv-route' }, bOrigin, swapBtn, bDest),
      h('div', { class: 'tv-dates' },
        h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-dep` }, 'Départ'), inDep, hintDep),
        h('div', { class: 'field' }, h('label', { class: 'label', for: `${uid}-arr` }, 'Arrivée'), inArr, hintArr)),
      flightInfo, presets);

    // globe
    const canvas = h('canvas', { class: 'tv-globe', tabindex: '0', role: 'img', 'aria-label': 'Globe terrestre avec la route du vol' });
    const clockA = h('div', { class: 'tv-clock tv-clock--a' }), clockB = h('div', { class: 'tv-clock tv-clock--b' });
    const status = h('div', { class: 'tv-status', 'aria-live': 'off' });
    const scrub = h('input', { class: 'range', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Faire avancer le temps sur le globe', oninput: (e) => { S.playing = false; syncPlay(); setScrub(+e.target.value / 1000); } });
    const playBtn = h('button', { class: 'iconbtn', type: 'button', onclick: () => { if (S.playing) { S.playing = false; } else { if (+scrub.value >= 995) scrub.value = '0'; S.playing = true; startPlay(); } syncPlay(); } });
    const recenter = h('button', { class: 'iconbtn tv-recenter', type: 'button', 'aria-label': 'Recentrer le globe', 'data-tip': 'Recentrer', onclick: () => globe.recenter() }, icon('target'));
    const globeCard = h('section', { class: 'card tv-globe-card', 'aria-label': 'Globe jour et nuit' },
      h('div', { class: 'tv-globe-wrap' }, canvas, recenter,
        h('div', { class: 'tv-legend', 'aria-hidden': 'true' }, h('span', { class: 'tv-legend__i tv-legend__i--day' }, 'Jour'), h('span', { class: 'tv-legend__i tv-legend__i--night' }, 'Nuit'), h('span', { class: 'tv-legend__i tv-legend__i--term' }, 'Terminateur')),
        h('span', { class: 'tv-hint tiny faint', 'aria-hidden': 'true' }, 'Glisse pour tourner')),
      h('div', { class: 'tv-clocks' }, clockA, clockB),
      h('div', { class: 'tv-timeline' }, playBtn, scrub), status);

    const stage = h('div', { class: 'tv-stage' }, form, globeCard);
    const planHost = h('div', { class: 'tv-plan' });
    const disclaimer = h('aside', { class: 'banner tv-disclaimer', role: 'note' }, icon('info', { size: 20 }),
      h('div', null, h('strong', null, 'Un outil de confort, pas un avis médical. '),
        'Le plan s\'appuie sur la façon dont la lumière décale l\'horloge biologique (Khalsa 2003, Revell & Eastman 2005). C\'est un ordre de grandeur : chacun s\'adapte à son rythme, et la météo, les escales ou le travail en intérieur ralentissent les choses. Aucun médicament n\'est recommandé ; pour la mélatonine, parle-en à un professionnel de santé. ',
        h('a', { href: '#/science' }, 'Voir les limites du modèle')));
    root.append(hero, stage, planHost, disclaimer);

    // --- globe ---
    const globe = createGlobe(canvas);
    cleanups.push(() => globe.destroy());

    // --- sélecteur de ville (modale) ---
    function openPicker(which) {
      const current = which === 'origin' ? S.origin : S.dest;
      const ref = which === 'origin' ? S.dep : S.arr;
      const all = CITIES.slice();
      const mine = cityForTz(profileTz(), nowMs());
      if (mine.synthetic) all.unshift(mine);
      let active = 0, shown = [];
      const input = h('input', { class: 'input tv-search', type: 'search', placeholder: 'Rechercher une ville ou un pays…', 'aria-label': 'Rechercher une ville', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': `${uid}-list-${which}` });
      const list = h('ul', { class: 'tv-cities', id: `${uid}-list-${which}`, role: 'listbox', 'aria-label': 'Villes' });
      let modal;
      const choose = (c) => { modal.close(c); };
      const paint = () => {
        const q = fold(input.value.trim());
        shown = all.filter((c) => !q || fold(`${c.name} ${c.country} ${c.tz}`).includes(q)).slice(0, 60);
        active = Math.min(active, Math.max(0, shown.length - 1));
        replaceChildren(list, shown.length ? shown.map((c, i) => h('li', { role: 'option', id: `${uid}-c-${which}-${i}`, 'aria-selected': i === active ? 'true' : 'false', class: `tv-city${c.tz === current.tz && c.name === current.name ? ' is-current' : ''}`, onclick: () => choose(c), onpointermove: () => { if (active !== i) { active = i; mark(); } } },
          h('span', { class: 'tv-city__name' }, c.name, h('span', { class: 'tv-city__country' }, c.country)),
          h('span', { class: 'tv-city__off num' }, offsetLabel(c.tz, ref)))) : [h('li', { class: 'tv-city tv-city--none' }, 'Aucune ville ne correspond. Essaie un autre nom.')]);
        mark();
      };
      const mark = () => {
        Array.from(list.children).forEach((li, i) => { li.setAttribute('aria-selected', i === active ? 'true' : 'false'); if (i === active) { input.setAttribute('aria-activedescendant', li.id); li.scrollIntoView({ block: 'nearest' }); } });
      };
      input.addEventListener('input', () => { active = 0; paint(); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
        else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); choose(shown[active]); }
      });
      modal = ctx.openModal({ title: which === 'origin' ? 'D\'où pars-tu ?' : 'Où vas-tu ?', size: 'sm', content: h('div', { class: 'tv-picker' }, input, list), initialFocus: input });
      paint();
      modal.closed.then((c) => {
        if (!c) return;
        if (which === 'origin') S.origin = c; else S.dest = c;
        if (S.origin.tz === S.dest.tz && S.origin.name === S.dest.name) { ctx.toast('Départ et arrivée sont identiques : choisis deux villes différentes.', { kind: 'warn' }); }
        S.arrManual = false; haptic(8); changed({ reroute: true });
      });
    }

    // --- réaction aux changements de saisie ---
    let recomputeTimer = 0;
    function changed(opts = {}) {
      if (!S.arrManual) S.arr = S.dep + estimateFlightMin(S.origin, S.dest) * MIN;
      save(); paintForm(); clearTimeout(recomputeTimer);
      recomputeTimer = setTimeout(() => { compute(); if (opts.reroute) globe.setRoute(S.origin, S.dest); setupScrub(true); }, 40);
    }
    cleanups.push(() => clearTimeout(recomputeTimer));

    function paintForm() {
      const mk = (b, c, eyebrow, tz, ms) => replaceChildren(b, h('span', { class: 'tv-pick__eyebrow' }, eyebrow), h('span', { class: 'tv-pick__city' }, c.name), h('span', { class: 'tv-pick__meta' }, h('span', null, c.country), h('span', { class: 'tv-pick__off num' }, offsetLabel(tz, ms))), h('span', { class: 'tv-pick__chev', 'aria-hidden': 'true' }, icon('chevron-down', { size: 16 })));
      mk(bOrigin, S.origin, 'De', S.origin.tz, S.dep); mk(bDest, S.dest, 'Vers', S.dest.tz, S.arr);
      bOrigin.setAttribute('aria-label', `Ville de départ : ${S.origin.name}. Modifier.`); bDest.setAttribute('aria-label', `Ville d'arrivée : ${S.dest.name}. Modifier.`);
      inDep.value = toInput(S.origin.tz, S.dep); inArr.value = toInput(S.dest.tz, S.arr);
      hintDep.textContent = `Heure de ${S.origin.name} · ${offsetLabel(S.origin.tz, S.dep)}`; hintArr.textContent = `Heure de ${S.dest.name} · ${offsetLabel(S.dest.tz, S.arr)}`;
      const flightMin = (S.arr - S.dep) / MIN, est = estimateFlightMin(S.origin, S.dest);
      replaceChildren(flightInfo, icon('plane', { size: 16 }),
        h('span', null, flightMin > 0 ? `Vol de ${dur(flightMin)}` : 'L\'arrivée doit être après le départ', h('span', { class: 'faint' }, S.arrManual ? ` · estimation : ${dur(est)}` : ' · durée estimée')),
        S.arrManual ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { S.arrManual = false; changed(); } }, icon('refresh', { size: 14 }), 'Estimer') : null);
      replaceChildren(presets, h('span', { class: 'eyebrow' }, 'Idées'), ...PRESETS.map((n) => { const c = CITIES.find((x) => x.name === n); const on = c && c.name === S.dest.name; return h('button', { class: 'chip', type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => { if (c.tz === S.origin.tz) return; S.dest = c; S.arrManual = false; haptic(6); changed({ reroute: true }); } }, n); }));
    }

    // --- scrubber / lecture ---
    function setupScrub(autoplay) {
      S.tMin = S.dep - 5 * HOUR; S.tMax = S.arr + 5 * HOUR;
      const startFrac = (S.dep - S.tMin) / (S.tMax - S.tMin);
      scrub.value = String(Math.round(startFrac * 1000)); syncRangeVar();
      setScrub(startFrac);
      if (autoplay && !reduced && S.arr > S.dep) { S.playing = true; startPlay(); }
      syncPlay();
    }
    const syncRangeVar = () => { const min = +scrub.min, max = +scrub.max; scrub.style.setProperty('--pct', String(((+scrub.value - min) / (max - min)) * 100)); };
    function setScrub(frac) {
      S.t = S.tMin + (S.tMax - S.tMin) * Math.max(0, Math.min(1, frac));
      scrub.value = String(Math.round(frac * 1000)); syncRangeVar();
      const prog = (S.t - S.dep) / Math.max(1, S.arr - S.dep);
      globe.setTime(S.t, prog);
      paintClocks(prog);
    }
    let playRaf = 0;
    function startPlay() {
      cancelAnimationFrame(playRaf);
      let last = 0;
      const total = 7000;
      const step = (ts) => {
        if (!S.playing) return;
        const dt = last ? ts - last : 16; last = ts;
        const frac = Math.min(1, +scrub.value / 1000 + dt / total);
        setScrub(frac);
        if (frac >= 1) { S.playing = false; syncPlay(); return; }
        playRaf = requestAnimationFrame(step);
      };
      playRaf = requestAnimationFrame(step);
    }
    cleanups.push(() => { S.playing = false; cancelAnimationFrame(playRaf); });
    function syncPlay() {
      replaceChildren(playBtn, icon(S.playing ? 'pause' : 'play', { size: 20 }));
      playBtn.setAttribute('aria-label', S.playing ? 'Mettre en pause' : 'Lire le trajet');
    }
    function clockOf(c, ms, role) {
      const e = sunSin(c.lat, c.lon, ms), ic = e > 0.1 ? 'sun' : e > -0.1 ? (role === 'a' ? 'sunrise' : 'sunset') : 'moon';
      const phase = e > 0.1 ? 'Plein jour' : e > 0.02 ? 'Le soleil est bas' : e > -0.1 ? 'Crépuscule' : 'Nuit';
      return [h('span', { class: `tv-clock__ic tv-clock__ic--${e > 0 ? 'day' : 'night'}` }, icon(ic, { size: 22 })), h('span', { class: 'tv-clock__txt' }, h('span', { class: 'tv-clock__city' }, c.name), h('span', { class: 'tv-clock__time num' }, fmtTimeTz(c.tz, ms)), h('span', { class: 'tv-clock__sub' }, `${dayFmt(c.tz, ms)} · ${phase}`))];
    }
    function paintClocks(prog) {
      replaceChildren(clockA, ...clockOf(S.origin, S.t, 'a')); replaceChildren(clockB, ...clockOf(S.dest, S.t, 'b'));
      const tot = (S.arr - S.dep) / MIN;
      let txt;
      if (prog <= 0) txt = `Au sol à ${S.origin.name}`; else if (prog >= 1) txt = `Arrivé à ${S.dest.name}`; else txt = `En vol · ${dur(prog * tot)} sur ${dur(tot)}`;
      status.textContent = txt;
      canvas.setAttribute('aria-label', `Globe : vol de ${S.origin.name} à ${S.dest.name}. ${txt}.`);
    }

    // --- calcul du plan ---
    let profileKey = '';
    function compute() {
      S.error = null; S.plan = null;
      if (S.origin.tz === S.dest.tz && S.origin.name === S.dest.name) S.error = 'Choisis deux villes différentes pour calculer un plan.';
      else if (!(S.arr > S.dep)) S.error = 'L\'arrivée doit être postérieure au départ.';
      else if (S.arr - S.dep > 40 * HOUR) S.error = 'Ce vol dure plus de 40 heures : vérifie les dates et heures saisies.';
      else {
        try { S.plan = planJetlag({ originTz: S.origin.tz, destTz: S.dest.tz, departMs: S.dep, arriveMs: S.arr, profile: ctx.state.profile }); } catch (e) { S.error = e.message || 'Impossible de calculer ce plan.'; }
      }
      S.applied = S.applied.filter((id) => ctx.state.events.some((e) => e.id === id));
      paintHero(); renderPlan();
    }

    function paintHero() {
      const p = S.plan;
      hero.dataset.dir = p ? (p.direction === 'est' ? 'est' : p.direction === 'ouest' ? 'ouest' : 'none') : 'none';
      const v = p ? Math.abs(p.shiftH) : 0;
      heroSign.textContent = !p || p.shiftH === 0 ? '' : p.shiftH > 0 ? '+' : '−';
      animateNumber(heroNum, v, { duration: 900, format: (x) => num1(x) });
      if (!p) { heroDir.textContent = S.error || 'Choisis ta destination.'; heroSr.textContent = ''; return; }
      const cityD = S.dest.name, cityO = S.origin.name;
      heroDir.replaceChildren(
        p.direction === 'aucun' ? `Pas de décalage entre ${cityO} et ${cityD}.` : h('span', null, `${cityD} est `, h('strong', null, `${num1(Math.abs(p.shiftH))} h ${p.shiftH > 0 ? 'en avance' : 'en retard'}`), ` sur ${cityO}`, h('span', { class: 'faint' }, p.direction === 'est' ? ' · tu voyages vers l\'est' : ' · tu voyages vers l\'ouest')));
      heroSr.textContent = p.summary || '';
    }

    // --- rendu du plan ---
    function renderPlan() {
      const p = S.plan;
      if (S.error) { replaceChildren(planHost, h('div', { class: 'banner banner--coral', role: 'alert' }, icon('alert-circle', { size: 20 }), S.error)); return; }
      if (!p) { replaceChildren(planHost); return; }
      if (!p.days.length) {
        replaceChildren(planHost, h('section', { class: 'card card--glow empty tv-zero' },
          h('div', { class: 'tv-zero__art', 'aria-hidden': 'true' }, h('span', { class: 'orb', style: { '--orb-size': '104px' } })),
          h('h3', { class: 'empty__title' }, 'Rien à rattraper'),
          h('p', { class: 'empty__text' }, p.summary),
          h('p', { class: 'empty__text faint' }, 'Un vol sans décalage fatigue quand même : hydrate-toi, bouge un peu et garde ton rythme habituel.')));
        return;
      }
      const days = p.days;
      const first = p.phaseShiftH, tAdapt = p.daysToAdapt;
      const flightMin = Math.round((S.arr - S.dep) / MIN);
      const stat = (label, valueNode, sub, cls) => h('div', { class: `tv-kpi ${cls || ''}` }, h('span', { class: 'stat__label' }, label), h('span', { class: 'tv-kpi__v' }, valueNode), h('span', { class: 'tv-kpi__s' }, sub));
      const nDays = h('span', { class: 'num' }, '0'); animateNumber(nDays, tAdapt, { duration: 900 });
      const alt = p.alternative;
      const kpis = h('div', { class: 'tv-kpis' },
        stat('À faire', h('span', null, p.phaseDirection === 'avance' ? 'Avancer' : 'Retarder'), `ton horloge de ${num1(first)} h`, 'tv-kpi--text'),
        stat('Adaptation', h('span', null, '≈ ', nDays, h('small', null, ' j')), 'en suivant le plan', ''),
        stat('Vol', h('span', null, dur(flightMin)), `${offsetLabel(S.origin.tz, S.dep)} → ${offsetLabel(S.dest.tz, S.arr)}`, ''),
        stat('Sans plan', h('span', null, '≈ ', h('span', { class: 'num' }, String(Math.ceil(Math.abs(p.shiftH))))), 'jours (un par heure de décalage)', 'tv-kpi--faint'));

      const header = h('div', { class: 'tv-plan__head' },
        h('div', null, h('span', { class: 'eyebrow eyebrow--sun' }, 'Ton plan'), h('h3', { class: 'h2' }, `${S.origin.name} `, h('span', { class: 'tv-arrow', 'aria-hidden': 'true' }, '→'), ` ${S.dest.name}`)),
        h('p', { class: 'lead tv-plan__lead' }, p.summary));
      const chart = residualChart(p);
      const actions = actionsBar(p);
      const tl = h('ol', { class: 'tv-days', 'aria-label': 'Plan jour par jour' }, ...days.map((d, i) => dayCard(d, i, days, p)));
      const alt2 = alt && Math.abs(p.shiftH) >= 9 ? h('p', { class: 'tv-alt small muted' }, icon('info', { size: 16 }), ` Autre option pour un décalage aussi grand : ${alt.phaseDirection === 'avance' ? 'avancer' : 'retarder'} ton horloge de ${num1(alt.phaseShiftH)} h (≈ ${alt.daysToAdapt} jours). Le plan retient le sens le plus court.`) : null;
      replaceChildren(planHost, header, kpis, h('div', { class: 'tv-plan__grid' }, h('section', { class: 'card tv-chart-card', 'aria-label': 'Décalage résiduel' }, h('div', { class: 'card__head' }, h('div', null, h('h3', { class: 'card__title' }, 'Le décalage qui fond'), h('p', { class: 'card__sub' }, 'Heures d\'écart restant entre ton horloge et l\'heure locale')), h('span', { class: 'badge badge--night' }, 'résiduel')), chart), tipsCard(p)), alt2, actions, tl);
      observeReveal(tl);
    }

    const revealIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); revealIO.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' }) : null;
    cleanups.push(() => revealIO && revealIO.disconnect());
    function observeReveal(container) { container.querySelectorAll('.tv-day').forEach((li) => { if (reduced || !revealIO) li.classList.add('is-in'); else revealIO.observe(li); }); }

    // courbe du décalage résiduel (SVG) ; largeur lue dans la page pour garder un texte lisible
    let chartW = 0;
    function residualChart(p) {
      const days = p.days, W = chartW = Math.max(290, Math.min(760, Math.round(planHost.clientWidth >= 980 ? (planHost.clientWidth - 16) * 0.574 - 40 : planHost.clientWidth - 40))), Ht = 220, L = 34, Rr = 16, T = 26, B = 36;
      const pts = [{ label: 'Auj.', v: p.phaseShiftH }];
      let bi = 0, di = 1;
      for (const d of days) {
        const short = d.phase === 'avant' ? `J−${p.preDays - bi++}` : d.phase === 'vol' ? 'Vol' : d.phase === 'arrivée' ? 'Arr.' : `J${++di}`;
        pts.push({ label: short, v: d.residualH, day: d });
      }
      const n = pts.length, max = Math.max(1, Math.ceil(Math.max(...pts.map((q) => q.v)) / 2) * 2);
      const stepPx = (W - L - Rr) / Math.max(1, n - 1), skipX = Math.max(1, Math.ceil(34 / stepPx)), skipV = Math.max(1, Math.ceil(26 / stepPx));
      const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - Rr), y = (v) => T + (1 - v / max) * (Ht - T - B);
      const X = pts.map((_, i) => x(i)), Y = pts.map((q) => y(q.v));
      // spline monotone (Catmull-Rom simplifiée → cubic)
      let d = `M${X[0]} ${Y[0]}`;
      for (let i = 0; i < n - 1; i++) { const cx = (X[i + 1] - X[i]) * 0.45; d += ` C${X[i] + cx} ${Y[i]} ${X[i + 1] - cx} ${Y[i + 1]} ${X[i + 1]} ${Y[i + 1]}`; }
      const area = `${d} L${X[n - 1]} ${y(0)} L${X[0]} ${y(0)} Z`;
      const gid = uniqueId('rc');
      const ticks = []; const step = max <= 4 ? 1 : max <= 8 ? 2 : 4; for (let v = 0; v <= max; v += step) ticks.push(v);
      const doneY = y(0.5);
      const svgEl = svg('svg', { class: 'tv-chart', viewBox: `0 0 ${W} ${Ht}`, role: 'img', 'aria-label': `Décalage résiduel : de ${num1(p.phaseShiftH)} heures aujourd'hui à ${num1(pts[n - 1].v)} heure après ${days.length} jours.` },
        svg('defs', null,
          svg('linearGradient', { id: `${gid}-a`, x1: '0', y1: '0', x2: '0', y2: '1' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun)', 'stop-opacity': '.5' }), svg('stop', { offset: '1', 'stop-color': 'var(--night)', 'stop-opacity': '.04' })),
          svg('linearGradient', { id: `${gid}-l`, x1: '0', y1: '0', x2: '1', y2: '0' }, svg('stop', { offset: '0', 'stop-color': 'var(--sun-hot)' }), svg('stop', { offset: '.55', 'stop-color': 'var(--sun)' }), svg('stop', { offset: '1', 'stop-color': 'var(--night)' }))),
        ...ticks.map((v) => svg('g', { class: 'tv-chart__grid' }, svg('line', { x1: L, x2: W - Rr, y1: y(v), y2: y(v) }), svg('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, `${v} h`))),
        svg('line', { class: 'tv-chart__done', x1: L, x2: W - Rr, y1: doneY, y2: doneY }),
        svg('text', { class: 'tv-chart__done-l', x: L + 6, y: doneY - 6, 'text-anchor': 'start' }, 'calé'),
        svg('path', { class: 'tv-chart__area', d: area, fill: `url(#${gid}-a)` }),
        svg('path', { class: 'tv-chart__glow', d, pathLength: '1', stroke: `url(#${gid}-l)` }),
        svg('path', { class: 'tv-chart__line', d, pathLength: '1', stroke: `url(#${gid}-l)` }),
        ...pts.map((q, i) => svg('g', { class: 'tv-chart__pt', style: { '--d': `${380 + i * 70}ms` }, tabindex: '0', role: 'img', 'aria-label': `${q.label} : ${num1(q.v)} heure${q.v >= 2 ? 's' : ''} de décalage restant`, 'data-i': i },
          svg('circle', { class: 'tv-chart__halo', cx: X[i], cy: Y[i], r: 11 }), svg('circle', { class: 'tv-chart__dot', cx: X[i], cy: Y[i], r: 4.5 }),
          (i % skipV === 0 || i === n - 1) ? svg('text', { class: 'tv-chart__val', x: X[i], y: Y[i] - 12, 'text-anchor': 'middle' }, num1(q.v)) : null)),
        ...pts.map((q, i) => (i % skipX === 0 || i === n - 1) && !(i === n - 1 && (n - 1) % skipX !== 0 && (n - 1 - ((n - 1) - ((n - 1) % skipX))) * stepPx < 30) ? svg('text', { class: 'tv-chart__x', x: X[i], y: Ht - 12, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, q.label) : null));
      const wrap = h('div', { class: 'tv-chart-wrap' }, svgEl);
      wrap.querySelectorAll('.tv-chart__pt').forEach((g) => {
        const i = +g.dataset.i, q = pts[i];
        const act = (on) => { g.classList.toggle('is-on', on); if (q.day) { const li = planHost.querySelector(`.tv-day[data-i="${days.indexOf(q.day)}"]`); if (li) li.classList.toggle('is-hot', on); } };
        g.addEventListener('pointerenter', () => act(true)); g.addEventListener('pointerleave', () => act(false)); g.addEventListener('focus', () => act(true)); g.addEventListener('blur', () => act(false));
        g.addEventListener('click', () => { if (q.day) { const li = planHost.querySelector(`.tv-day[data-i="${days.indexOf(q.day)}"]`); if (li) li.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' }); } });
      });
      return wrap;
    }

    // conseils concrets
    function tipsCard(p) {
      const down = p.phaseDirection === 'avance';
      const tips = [
        ['sun', 'Lumière, ton levier n°1', down ? 'Dehors dès le réveil local, même sous les nuages : c\'est bien plus lumineux qu\'un bureau. Lunettes de soleil avant la fenêtre « chercher la lumière ».' : 'Sors en fin d\'après-midi et début de soirée, et évite le soleil du petit matin local qui te ferait avancer au lieu de reculer.'],
        ['coffee', 'Caféine', 'Utile le « matin » local, à éviter dans les ~8 h avant l\'heure de coucher visée (ta demi-vie compte : voir Réglages).'],
        ['moon', 'Sommeil', 'Dors à l\'heure de destination dès l\'embarquement, bouchons et masque aident. Une sieste ? 20 min max, avant 15 h locale.'],
        ['drop', 'Corps', 'Bois de l\'eau, limite l\'alcool, mange aux heures locales : ça aide ton corps à comprendre où il est.'],
        ['target', 'Reste souple', 'Si une journée déraille, le plan se rattrape le lendemain. L\'important : la lumière au bon moment, pas la perfection.'],
      ];
      return h('section', { class: 'card tv-tips', 'aria-label': 'Conseils' }, h('div', { class: 'card__head' }, h('h3', { class: 'card__title' }, 'Les gestes qui comptent')),
        h('ul', { class: 'tv-tips__list' }, ...tips.map(([ic, t, d], i) => h('li', { style: { '--i': i } }, h('span', { class: 'tv-tips__ic' }, icon(ic, { size: 18 })), h('div', null, h('strong', null, t), h('p', { class: 'small muted' }, d))))));
    }

    // une journée du plan
    function dayCard(day, i, days, p) {
      const phaseName = { avant: 'Avant le départ', vol: 'Le jour du vol', 'arrivée': 'Arrivée', adaptation: 'Adaptation' }[day.phase] || '';
      const done = day.residualH <= 0.5 && day.phase !== 'avant' && day.phase !== 'vol';
      const total = Math.max(0.1, p.phaseShiftH);
      const sleepTxt = day.sleepBed ? `${fmtTimeTz(day.tz, day.sleepBed)} → ${fmtTimeTz(day.tz, day.sleepWake)}` : null;
      const chips = [];
      if (day.phase === 'vol') chips.push(h('span', { class: 'tv-chip tv-chip--fly' }, icon('plane', { size: 14 }), `Vol ${fmtTimeTz(S.origin.tz, S.dep)} → ${fmtTimeTz(S.dest.tz, S.arr)}`));
      if (sleepTxt) chips.push(h('span', { class: 'tv-chip tv-chip--sleep' }, icon('moon', { size: 14 }), day.phase === 'vol' ? `Dors ${sleepTxt}` : `Dodo ${sleepTxt}`));
      for (const w of day.seekLight || []) chips.push(h('span', { class: 'tv-chip tv-chip--seek' }, icon('sun', { size: 14 }), `Lumière ${w.startLabel}–${w.endLabel}`));
      for (const w of day.avoidLight || []) chips.push(h('span', { class: 'tv-chip tv-chip--avoid' }, icon('eyeoff', { size: 14 }), `Évite ${w.startLabel}–${w.endLabel}`));
      const strip = dayStrip(day, days);
      return h('li', { class: `tv-day tv-day--${day.phase}${done ? ' is-done' : ''}`, 'data-i': i, style: { '--i': i } },
        h('span', { class: 'tv-day__node', 'aria-hidden': 'true' }, icon(day.phase === 'vol' ? 'plane' : day.phase === 'avant' ? 'clock' : done ? 'check' : 'sun', { size: 16 })),
        h('article', { class: 'card tv-day__card' },
          h('header', { class: 'tv-day__head' },
            h('div', null, h('span', { class: 'eyebrow' }, `${phaseName} · ${dayFmt(day.tz, day.dayMs + 12 * HOUR)}`), h('h4', { class: 'tv-day__title' }, day.label)),
            h('div', { class: 'tv-day__res' }, done ? h('span', { class: 'badge badge--ok' }, 'Calé') : h('span', null, h('b', { class: 'num' }, num1(day.residualH)), h('small', null, ' h restantes')))),
          strip, chips.length ? h('div', { class: 'tv-chips' }, ...chips) : null,
          h('p', { class: 'tv-day__advice' }, day.advice),
          h('div', { class: 'progress progress--night tv-day__bar', style: { '--pct': String(Math.max(0, Math.min(100, (1 - day.residualH / total) * 100))) }, role: 'img', 'aria-label': `${Math.round((1 - day.residualH / total) * 100)} % du décalage rattrapé` }, h('div', { class: 'progress__bar' }))));
    }

    // frise de 24 h
    function dayStrip(day, days) {
      const W0 = day.dayMs, W1 = zonedMidnight(day.tz, day.dayMs + 36 * HOUR), span = W1 - W0;
      const pos = (ms) => ((ms - W0) / span) * 100;
      const seg = (s, e) => { const a = Math.max(s, W0), b = Math.min(e, W1); return b - a >= 5 * MIN ? { left: pos(a), width: pos(b) - pos(a) } : null; };
      const parts = []; const aria = [];
      const add = (cls, s, e, label, inner) => { const g = seg(s, e); if (!g) return; parts.push(h('span', { class: `tv-seg ${cls}`, style: { left: `${g.left}%`, width: `${g.width}%` }, title: label }, g.width > 11 ? inner : null)); aria.push(label); };
      for (const d of days) if (d.sleepBed) add('tv-seg--sleep', d.sleepBed, d.sleepWake, `Sommeil ${fmtTimeTz(day.tz, Math.max(d.sleepBed, W0))}–${fmtTimeTz(day.tz, Math.min(d.sleepWake, W1))}`, icon('moon', { size: 14 }));
      for (const w of day.avoidLight || []) add('tv-seg--avoid', w.start, w.end, `Éviter la lumière ${w.startLabel}–${w.endLabel}`, icon('eyeoff', { size: 14 }));
      for (const w of day.seekLight || []) add('tv-seg--seek', w.start, w.end, `Chercher la lumière ${w.startLabel}–${w.endLabel}`, icon('sun', { size: 15 }));
      if (day.phase === 'vol' || day.phase === 'arrivée') add('tv-seg--flight', S.dep, S.arr, `Vol ${fmtTimeTz(S.origin.tz, S.dep)}–${fmtTimeTz(S.dest.tz, S.arr)}`, icon('plane', { size: 14 }));
      if (day.cbtMinMs && day.cbtMinMs >= W0 && day.cbtMinMs < W1) { parts.push(h('span', { class: 'tv-cbt', style: { left: `${pos(day.cbtMinMs)}%` }, title: `Minimum de température estimé ${fmtTimeTz(day.tz, day.cbtMinMs)}` }, h('i'))); aria.push(`minimum de température ${fmtTimeTz(day.tz, day.cbtMinMs)}`); }
      const axis = [0, 6, 12, 18, 24].map((hh) => h('span', { class: 'tv-axis__t', style: { left: `${(hh / 24) * 100}%` } }, `${hh === 24 ? 0 : hh} h`));
      return h('div', { class: 'tv-strip-wrap' },
        h('div', { class: 'tv-strip', role: 'img', 'aria-label': aria.length ? `Frise de la journée : ${aria.join(' ; ')}.` : 'Frise de la journée, rien de particulier.' }, ...parts),
        h('div', { class: 'tv-axis', 'aria-hidden': 'true' }, ...axis));
    }

    // actions
    function actionsBar(p) {
      const appliedNow = S.applied.length > 0;
      const btnApply = h('button', { class: `btn ${appliedNow ? 'btn--secondary' : 'btn--primary'}`, type: 'button', onclick: () => (appliedNow ? undoApply() : confirmApply(p)) }, icon(appliedNow ? 'undo' : 'calendar-check', { size: 18 }), appliedNow ? `Retirer de mon planning (${S.applied.length})` : 'Appliquer à mon planning');
      const btnCopy = h('button', { class: 'btn btn--secondary', type: 'button', onclick: () => copyPlan(p) }, icon('copy', { size: 18 }), 'Copier le plan');
      return h('div', { class: 'tv-actions' }, btnApply, btnCopy, h('span', { class: 'small faint tv-actions__hint' }, appliedNow ? 'Les fenêtres sont dans ton agenda.' : 'Ajoute le sommeil et les fenêtres de lumière à ton agenda.'));
    }

    function eventsFor(p, kinds) {
      const route = `${S.origin.name} → ${S.dest.name}`, out = [], now = nowMs();
      for (const d of p.days) {
        if (kinds.sleep && d.sleepBed && d.sleepWake && d.sleepWake > now) out.push({ title: `${d.phase === 'vol' ? 'Dormir dans l\'avion' : 'Sommeil conseillé'} · ${route}`, startMs: d.sleepBed, endMs: d.sleepWake, kind: 'sleep' });
        if (kinds.seek) for (const w of d.seekLight || []) if (w.end > now) out.push({ title: `Lumière vive · ${route}`, startMs: w.start, endMs: w.end, kind: 'seek' });
        if (kinds.avoid) for (const w of d.avoidLight || []) if (w.end > now) out.push({ title: `Évite la lumière forte · ${route}`, startMs: w.start, endMs: w.end, kind: 'avoid' });
      }
      return out.sort((a, b) => a.startMs - b.startMs);
    }

    function confirmApply(p) {
      const kinds = { sleep: true, seek: true, avoid: false };
      const body = h('div', { class: 'tv-apply' });
      const countEl = h('p', { class: 'tv-apply__count' });
      const prev = h('ul', { class: 'tv-apply__list' });
      const refresh = () => {
        const ev = eventsFor(p, kinds), dup = new Set(ctx.state.events.map((e) => `${e.title}|${e.startMs}|${e.endMs}`));
        const fresh = ev.filter((e) => !dup.has(`${e.title}|${e.startMs}|${e.endMs}`));
        countEl.textContent = fresh.length ? `${fresh.length} événement${fresh.length > 1 ? 's' : ''} sera${fresh.length > 1 ? 'ont' : ''} ajouté${fresh.length > 1 ? 's' : ''} à ton agenda.` : 'Rien de nouveau à ajouter (les fenêtres futures sont déjà dans ton agenda, ou aucune n\'est à venir).';
        replaceChildren(prev, ...fresh.slice(0, 6).map((e) => h('li', null, h('span', { class: `tv-dot tv-dot--${e.kind}` }), h('span', null, e.title.split(' · ')[0]), h('span', { class: 'num faint' }, `${dayFmt(profileTz(), e.startMs)} ${fmtTimeTz(profileTz(), e.startMs)}`))), fresh.length > 6 ? h('li', { class: 'faint' }, `… et ${fresh.length - 6} autre${fresh.length - 6 > 1 ? 's' : ''}`) : null);
        return fresh;
      };
      const sw = (key, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: kinds[key], onchange: (e) => { kinds[key] = e.target.checked; refresh(); } }), h('span', { class: 'switch__ui' }), h('span', null, label));
      body.append(h('p', { class: 'muted' }, 'Kairos ajoute des événements à ton agenda (source « manuel »). Tu pourras les retirer d\'un geste.'), sw('sleep', 'Sommeil conseillé'), sw('seek', 'Fenêtres « chercher la lumière »'), sw('avoid', 'Fenêtres « évite la lumière »'), countEl, prev);
      refresh();
      const m = ctx.openModal({ title: 'Ajouter à ton planning', size: 'sm', content: body, footer: (api) => [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => api.close(false) }, 'Annuler'), h('button', { class: 'btn btn--primary', type: 'button', 'data-ok': '1', onclick: () => api.close(true) }, icon('calendar-check', { size: 18 }), 'Ajouter')] });
      m.closed.then((ok) => { if (!ok) return; applyEvents(eventsFor(p, kinds)); });
    }

    function applyEvents(ev) {
      const dup = new Set(ctx.state.events.map((e) => `${e.title}|${e.startMs}|${e.endMs}`)), ids = [];
      for (const e of ev) {
        if (dup.has(`${e.title}|${e.startMs}|${e.endMs}`)) continue;
        try { const created = ctx.actions.addEvent({ title: e.title, startMs: e.startMs, endMs: e.endMs, source: 'manual' }); if (created && created.id) ids.push(created.id); } catch { /* événement invalide ignoré */ }
      }
      if (!ids.length) { ctx.toast('Rien de nouveau à ajouter.', { kind: 'warn' }); return; }
      S.applied = ids; haptic([8, 30, 12]);
      ctx.toast(`${ids.length} événement${ids.length > 1 ? 's' : ''} ajouté${ids.length > 1 ? 's' : ''} à ton agenda`, { kind: 'ok', undoLabel: 'Annuler', onUndo: () => removeApplied(ids), duration: 7000 });
      renderPlan();
    }
    function removeApplied(ids) { for (const id of ids) { try { ctx.actions.removeEvent(id); } catch { /* déjà supprimé */ } } S.applied = []; renderPlan(); }
    async function undoApply() {
      const ok = await ctx.confirm(`Retirer les ${S.applied.length} événements du voyage de ton agenda ?`, { okLabel: 'Retirer', danger: true });
      if (ok) { const n = S.applied.length; removeApplied(S.applied.slice()); ctx.toast(`${n} événement${n > 1 ? 's' : ''} retiré${n > 1 ? 's' : ''}`, { kind: 'ok' }); }
    }

    async function copyPlan(p) {
      const L = [];
      L.push(`Plan anti-décalage horaire · ${S.origin.name} → ${S.dest.name}`);
      L.push(`Départ : ${dateTimeFmt(S.origin.tz, S.dep)} (heure de ${S.origin.name})`);
      L.push(`Arrivée : ${dateTimeFmt(S.dest.tz, S.arr)} (heure de ${S.dest.name})`);
      L.push(p.summary, '');
      for (const d of p.days) {
        L.push(`— ${d.label} · ${dayFmt(d.tz, d.dayMs + 12 * HOUR)} —`);
        if (d.sleepBed) L.push(`Sommeil : ${fmtTimeTz(d.tz, d.sleepBed)} → ${fmtTimeTz(d.tz, d.sleepWake)}`);
        for (const w of d.seekLight || []) L.push(`Chercher la lumière : ${w.startLabel}–${w.endLabel}`);
        for (const w of d.avoidLight || []) L.push(`Éviter la lumière forte : ${w.startLabel}–${w.endLabel}`);
        L.push(d.advice, `Décalage restant : ${num1(d.residualH)} h`, '');
      }
      L.push('Outil de confort, pas un avis médical. Généré par Kairos, 100 % en local.');
      const text = L.join('\n');
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {
        try { const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0' } }); ta.value = text; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch { ok = false; }
      }
      ctx.toast(ok ? 'Plan copié dans le presse-papiers' : 'Impossible de copier automatiquement : sélectionne le texte à la main.', { kind: ok ? 'ok' : 'warn' });
      if (ok) haptic(10);
    }

    // --- initialisation ---
    paintForm(); syncPlay();
    globe.setRoute(S.origin, S.dest);
    compute();
    setupScrub(true);
    profileKey = JSON.stringify([ctx.state.profile.usualWake, ctx.state.profile.usualBed, ctx.state.profile.sleepNeedH, ctx.state.profile.chronoShiftMin, ctx.state.profile.tz]);

    let lastW = planHost.clientWidth;
    const onResize = () => { const w = planHost.clientWidth; if (Math.abs(w - lastW) > 40 && S.plan) { lastW = w; renderPlan(); } };
    window.addEventListener('resize', onResize); cleanups.push(() => window.removeEventListener('resize', onResize));
    const off = ctx.subscribe(() => {
      const pr = ctx.state.profile, key = JSON.stringify([pr.usualWake, pr.usualBed, pr.sleepNeedH, pr.chronoShiftMin, pr.tz]);
      if (key !== profileKey) { profileKey = key; compute(); }
      else if (S.applied.length && S.applied.some((id) => !ctx.state.events.some((e) => e.id === id))) { S.applied = S.applied.filter((id) => ctx.state.events.some((e) => e.id === id)); renderPlan(); }
    });
    cleanups.push(off);

    return () => { for (const c of cleanups.splice(0)) { try { c(); } catch { /* nettoyage best effort */ } } };
  },
};
