// crypto.js — chiffrement local des sauvegardes (WebCrypto, aucune dépendance).
//
// Format : « kairos1. » + base64url( JSON UTF-8 de l'enveloppe ), avec
//   enveloppe = { v: 1, kdf: "PBKDF2-SHA256", iter, alg: "AES-256-GCM", salt, iv, ct }   (salt/iv/ct en base64url)
//  - Clé : PBKDF2-HMAC-SHA256 (≥ 250 000 itérations) -> AES-GCM 256 bits. Sel 16 octets et IV 12 octets
//    tirés au hasard à chaque chiffrement (jamais réutilisés avec la même clé car le sel change).
//  - L'en-tête (v, kdf, iter, alg) est authentifié comme « données additionnelles » AES-GCM : le modifier
//    fait échouer le déchiffrement. Les paramètres voyagent dans l'enveloppe pour permettre une migration
//    future (ex. plus d'itérations) : on lit toujours les paramètres du fichier, pas des constantes.
//  - Le mot de passe est normalisé en NFC (« é » saisi de deux façons donne la même clé).
//  - Limite honnête : la sécurité dépend de la force du mot de passe ; PBKDF2 ralentit une attaque par
//    dictionnaire mais ne l'empêche pas. Rien n'est envoyé nulle part.

export const PREFIX = 'kairos1.';
export const KDF_ITERATIONS = 400_000;
const MIN_ITER = 250_000; // plancher accepté à la lecture ET à l'écriture
const MAX_ITER = 5_000_000; // plafond à la lecture : un fichier hostile ne doit pas pouvoir geler l'onglet
export const BAD_PASSWORD_MESSAGE = 'Mot de passe incorrect ou données corrompues';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const fail = () => new Error(BAD_PASSWORD_MESSAGE);

function webcrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('Le chiffrement n\'est pas disponible dans ce navigateur (contexte non sécurisé ?)');
  return c;
}

// ───────────────────────── base64url ─────────────────────────

export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw fail();
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  let bin;
  try { bin = atob(b64); } catch { throw fail(); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ───────────────────────── Clé et en-tête ─────────────────────────

async function deriveKey(passphrase, salt, iter) {
  const c = webcrypto();
  const material = await c.subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return c.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Données authentifiées : l'en-tête sous une forme canonique. */
const headerAad = (h) => enc.encode(`${PREFIX}|v=${h.v}|kdf=${h.kdf}|iter=${h.iter}|alg=${h.alg}`);

/** Vrai si la chaîne ressemble à une sauvegarde chiffrée Kairos (sans la déchiffrer). */
export function isEncryptedPayload(s) {
  return typeof s === 'string' && s.startsWith(PREFIX);
}

// ───────────────────────── API ─────────────────────────

/**
 * Chiffre un objet JSON avec un mot de passe.
 * @returns {Promise<string>} « kairos1.… »
 */
export async function encryptJSON(obj, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('Le mot de passe ne peut pas être vide.');
  const json = JSON.stringify(obj);
  if (json === undefined) throw new Error('Rien à chiffrer : la valeur n\'est pas sérialisable en JSON.');
  const c = webcrypto();
  const salt = c.getRandomValues(new Uint8Array(16));
  const iv = c.getRandomValues(new Uint8Array(12));
  const header = { v: 1, kdf: 'PBKDF2-SHA256', iter: KDF_ITERATIONS, alg: 'AES-256-GCM' };
  const key = await deriveKey(passphrase, salt, header.iter);
  const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerAad(header) }, key, enc.encode(json)));
  const envelope = { ...header, salt: toBase64Url(salt), iv: toBase64Url(iv), ct: toBase64Url(ct) };
  return PREFIX + toBase64Url(enc.encode(JSON.stringify(envelope)));
}

/**
 * Déchiffre une sauvegarde produite par encryptJSON.
 * Rejette avec Error("Mot de passe incorrect ou données corrompues") pour tout échec d'authentification,
 * de format ou de troncature (volontairement indistinct : on ne renseigne pas un attaquant).
 */
export async function decryptJSON(payload, passphrase) {
  if (typeof payload !== 'string' || typeof passphrase !== 'string' || passphrase.length === 0) throw fail();
  const text = payload.trim();
  if (!text.startsWith(PREFIX)) throw fail();
  let env;
  try {
    env = JSON.parse(dec.decode(fromBase64Url(text.slice(PREFIX.length))));
  } catch { throw fail(); }
  if (!env || typeof env !== 'object') throw fail();
  if (typeof env.v === 'number' && env.v > 1) throw new Error('Cette sauvegarde vient d\'une version plus récente de Kairos : mets l\'application à jour pour la lire.');
  if (env.v !== 1 || env.kdf !== 'PBKDF2-SHA256' || env.alg !== 'AES-256-GCM') throw fail();
  if (!Number.isInteger(env.iter) || env.iter < MIN_ITER || env.iter > MAX_ITER) throw fail();
  let salt, iv, ct;
  try { salt = fromBase64Url(env.salt); iv = fromBase64Url(env.iv); ct = fromBase64Url(env.ct); } catch { throw fail(); }
  if (salt.length !== 16 || iv.length !== 12 || ct.length < 16) throw fail(); // 16 = étiquette GCM

  let plain;
  try {
    const key = await deriveKey(passphrase, salt, env.iter);
    plain = await webcrypto().subtle.decrypt({ name: 'AES-GCM', iv, additionalData: headerAad(env) }, key, ct);
  } catch { throw fail(); }
  try {
    return JSON.parse(dec.decode(plain));
  } catch { throw fail(); }
}
