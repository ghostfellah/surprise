import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptJSON, decryptJSON, PREFIX, KDF_ITERATIONS, BAD_PASSWORD_MESSAGE, isEncryptedPayload, toBase64Url, fromBase64Url } from '../site/js/core/crypto.js';

const MSG = 'Mot de passe incorrect ou données corrompues';
const sample = { version: 1, tasks: [{ id: 't1', title: 'Rédiger le rapport « éèà » 🎂', durMin: 90, done: false }], n: null, f: 1.5, nested: { a: [1, 2, 3] } };

const decodeEnvelope = (payload) => JSON.parse(Buffer.from(payload.slice(PREFIX.length), 'base64url').toString('utf8'));
const encodeEnvelope = (env) => PREFIX + Buffer.from(JSON.stringify(env), 'utf8').toString('base64url');

test('aller-retour : objets, accents, emoji, scalaires', async () => {
  const p = await encryptJSON(sample, 'correct horse battery staple');
  assert.ok(p.startsWith('kairos1.'));
  assert.ok(isEncryptedPayload(p));
  assert.ok(/^[A-Za-z0-9_.-]+$/.test(p), 'base64url uniquement');
  assert.deepEqual(await decryptJSON(p, 'correct horse battery staple'), sample);
  for (const v of [42, 'texte', [1, 2], null, true, {}]) {
    assert.deepEqual(await decryptJSON(await encryptJSON(v, 'pw'), 'pw'), v);
  }
});

test('enveloppe : version, paramètres, sel 16 octets, IV 12 octets, ≥ 250 000 itérations', async () => {
  const env = decodeEnvelope(await encryptJSON({ a: 1 }, 'pw'));
  assert.equal(env.v, 1);
  assert.equal(env.kdf, 'PBKDF2-SHA256');
  assert.equal(env.alg, 'AES-256-GCM');
  assert.ok(env.iter >= 250_000);
  assert.equal(env.iter, KDF_ITERATIONS);
  assert.equal(fromBase64Url(env.salt).length, 16);
  assert.equal(fromBase64Url(env.iv).length, 12);
  assert.ok(fromBase64Url(env.ct).length >= 16 + 7);
});

test('sel et IV aléatoires : deux chiffrements identiques donnent des sorties différentes', async () => {
  const a = await encryptJSON(sample, 'pw');
  const b = await encryptJSON(sample, 'pw');
  assert.notEqual(a, b);
  const ea = decodeEnvelope(a), eb = decodeEnvelope(b);
  assert.notEqual(ea.salt, eb.salt);
  assert.notEqual(ea.iv, eb.iv);
});

test('mauvais mot de passe', async () => {
  const p = await encryptJSON(sample, 'bon');
  for (const bad of ['mauvais', 'Bon', 'bon ', '']) {
    await assert.rejects(() => decryptJSON(p, bad), { message: MSG });
  }
  await assert.rejects(() => decryptJSON(p, undefined), { message: MSG });
  assert.equal(BAD_PASSWORD_MESSAGE, MSG);
});

test('normalisation Unicode du mot de passe (é composé / décomposé)', async () => {
  const p = await encryptJSON({ ok: true }, 'café');
  assert.deepEqual(await decryptJSON(p, 'café'), { ok: true });
});

test('données altérées : un octet changé dans le chiffré, le sel, l\'IV ou l\'en-tête', async () => {
  const p = await encryptJSON(sample, 'pw');
  const env = decodeEnvelope(p);
  const flip = (b64) => { const b = Buffer.from(b64, 'base64url'); b[Math.floor(b.length / 2)] ^= 0x01; return b.toString('base64url'); };
  for (const field of ['ct', 'salt', 'iv']) {
    await assert.rejects(() => decryptJSON(encodeEnvelope({ ...env, [field]: flip(env[field]) }), 'pw'), { message: MSG }, field);
  }
  // en-tête authentifié : changer iter (même vers une valeur acceptable) casse l'authentification
  await assert.rejects(() => decryptJSON(encodeEnvelope({ ...env, iter: env.iter + 1 }), 'pw'), { message: MSG });
  // étiquette GCM (dernier octet)
  const ct = Buffer.from(env.ct, 'base64url');
  ct[ct.length - 1] ^= 0xff;
  await assert.rejects(() => decryptJSON(encodeEnvelope({ ...env, ct: ct.toString('base64url') }), 'pw'), { message: MSG });
  // modification brute de la chaîne
  const chars = p.split('');
  const i = Math.floor(p.length * 0.7);
  chars[i] = chars[i] === 'A' ? 'B' : 'A';
  await assert.rejects(() => decryptJSON(chars.join(''), 'pw'), { message: MSG });
});

test('charge utile tronquée, vide ou malformée', async () => {
  const p = await encryptJSON(sample, 'pw');
  for (const n of [p.length - 1, p.length - 10, Math.floor(p.length / 2), PREFIX.length + 3, PREFIX.length]) {
    await assert.rejects(() => decryptJSON(p.slice(0, n), 'pw'), { message: MSG }, `tronquée à ${n}`);
  }
  for (const bad of ['', 'kairos1.', 'kairos1.!!!', 'kairos2.abc', 'autre chose', 'kairos1.' + toBase64Url(new TextEncoder().encode('pas du json')), null, undefined, 12, {}]) {
    await assert.rejects(() => decryptJSON(bad, 'pw'), { message: MSG });
  }
  const env = decodeEnvelope(p);
  for (const broken of [{ ...env, salt: 'AAAA' }, { ...env, iv: '' }, { ...env, ct: 'AAAA' }, { ...env, iter: 10 }, { ...env, iter: 1e12 }, { ...env, kdf: 'scrypt' }, { ...env, alg: 'AES-128-GCM' }, { ...env, v: 'x' }]) {
    await assert.rejects(() => decryptJSON(encodeEnvelope(broken), 'pw'), { message: MSG });
  }
});

test('version future : message explicite, pas « corrompu »', async () => {
  const env = decodeEnvelope(await encryptJSON({ a: 1 }, 'pw'));
  await assert.rejects(() => decryptJSON(encodeEnvelope({ ...env, v: 2 }), 'pw'), /plus récente/);
});

test('espaces autour de la charge utile tolérés (copier-coller)', async () => {
  const p = await encryptJSON({ a: 1 }, 'pw');
  assert.deepEqual(await decryptJSON(`  ${p}\n`, 'pw'), { a: 1 });
});

test('entrées invalides au chiffrement', async () => {
  await assert.rejects(() => encryptJSON({ a: 1 }, ''), /mot de passe/i);
  await assert.rejects(() => encryptJSON({ a: 1 }, undefined), /mot de passe/i);
  await assert.rejects(() => encryptJSON(undefined, 'pw'), /sérialisable/);
});

test('gros objet (≈ 2 Mo)', async () => {
  const big = { rows: Array.from({ length: 20000 }, (_, i) => ({ id: i, t: 'ligne numéro ' + i, v: i * 1.5 })) };
  assert.deepEqual(await decryptJSON(await encryptJSON(big, 'pw'), 'pw'), big);
});

test('base64url : aller-retour sur tous les octets, rejet des alphabets invalides', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(fromBase64Url(toBase64Url(all)), all);
  assert.equal(toBase64Url(new Uint8Array([251, 255])).includes('+'), false);
  assert.throws(() => fromBase64Url('ab+/'), { message: MSG });
  assert.throws(() => fromBase64Url('a'), { message: MSG });
});
