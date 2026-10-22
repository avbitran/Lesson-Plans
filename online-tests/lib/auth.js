'use strict';
const crypto = require('node:crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Passwords students can read off a slip of paper and type on a phone:
// two short words and two digits, no look-alike characters.
const WORDS = [
  'apple', 'bird', 'cloud', 'drum', 'eagle', 'fern', 'grape', 'hill', 'iris', 'jam',
  'kite', 'lemon', 'moon', 'nest', 'olive', 'pearl', 'quilt', 'river', 'sun', 'tiger',
  'umbra', 'violet', 'wave', 'yak', 'zebra', 'boat', 'cedar', 'dune', 'ember', 'frog',
  'gold', 'honey', 'island', 'jade', 'koala', 'lake', 'maple', 'north', 'otter', 'plum',
  'rain', 'stone', 'tulip', 'wolf', 'cocoa', 'mint', 'star', 'snow', 'leaf', 'reef',
];

function generatePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(10, 100)}`;
}

function usernameBase(name) {
  const ascii = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return ascii.slice(0, 24) || 'student';
}

module.exports = { hashPassword, verifyPassword, newToken, generatePassword, usernameBase };
