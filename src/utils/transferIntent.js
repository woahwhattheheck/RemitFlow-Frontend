/**
 * Transfer intent fingerprint + session-scoped operation reference.
 *
 * One user intent maps to one idempotency key bound to the exact payload.
 * Editing the payload produces a new fingerprint and therefore a new intent.
 * Only a safe operation reference (key + status + transfer id) is persisted
 * across navigation/refresh — never secrets or raw form state.
 */

import { parseDecimal } from './money.js';

const OPS_KEY = 'remitflow.transferOps';
let nonceSequence = 0;

/** @typedef {'submitting'|'unknown'|'succeeded'|'failed'|'dismissed'} OpStatus */

/**
 * Canonical fingerprint of the transferable payload fields.
 * @param {{recipient:string,from:string,to:string,sendAmount:number|string,receiveAmount:number|string,fee?:number|string,rate?:number|string}} payload
 */
export function fingerprintTransferPayload(payload) {
  const parts = [
    String(payload.recipient ?? ''),
    String(payload.from ?? '').toUpperCase(),
    String(payload.to ?? '').toUpperCase(),
    normalizeAmount(payload.sendAmount),
    normalizeAmount(payload.receiveAmount),
    normalizeAmount(payload.fee),
    normalizeAmount(payload.rate),
  ];
  return JSON.stringify(parts);
}

function normalizeAmount(value) {
  if (value === undefined || value === null || value === '') return '';
  const parsed = parseDecimal(value);
  return parsed.ok ? parsed.value : String(value);
}

/**
 * Unique nonce for a new user intent. Retries reuse the saved key instead.
 */
export function newTransferIntentNonce() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}:${++nonceSequence}:${Math.random().toString(36).slice(2)}`;
}

/**
 * Hash a payload fingerprint. A fresh nonce makes a new transfer key;
 * a retry reuses the key saved with its operation reference.
 * @param {string} fingerprint
 * @param {string} [nonce]
 */
export async function idempotencyKeyFor(fingerprint, nonce) {
  const input = nonce === undefined ? fingerprint : JSON.stringify([fingerprint, nonce]);
  if (globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `idem_${hex.slice(0, 32)}`;
  }
  return `idem_${fnv1a(input)}`;
}

function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function readOps() {
  try {
    const raw = sessionStorage.getItem(OPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeOps(ops) {
  try {
    sessionStorage.setItem(OPS_KEY, JSON.stringify(ops));
  } catch {
    // ignore quota / private mode
  }
}

/**
 * Persist a safe operation reference for navigation/refresh recovery.
 * @param {{idempotencyKey:string,fingerprint:string,transferId?:string|null,status:OpStatus}} op
 */
export function saveTransferOperation(op) {
  if (!op?.idempotencyKey) return;
  const ops = readOps();
  ops[op.idempotencyKey] = {
    idempotencyKey: op.idempotencyKey,
    fingerprint: op.fingerprint,
    transferId: op.transferId ?? null,
    status: op.status,
    updatedAt: new Date().toISOString(),
  };
  writeOps(ops);
}

/** @param {string} idempotencyKey */
export function getTransferOperation(idempotencyKey) {
  if (!idempotencyKey) return null;
  return readOps()[idempotencyKey] ?? null;
}

/**
 * Latest recoverable intent: in-flight, unknown outcome, or succeeded but not
 * yet dismissed. Used after navigation/refresh to restore status without
 * minting a second transfer.
 */
export function getLatestRecoverableOperation(fingerprint) {
  const recoverable = new Set(['submitting', 'unknown', 'succeeded']);
  const ops = Object.values(readOps());
  const matches = ops
    .filter((op) => op && recoverable.has(op.status) &&
      (fingerprint === undefined || op.fingerprint === fingerprint))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return matches[0] ?? null;
}

export function clearTransferOperation(idempotencyKey) {
  if (!idempotencyKey) return;
  const ops = readOps();
  delete ops[idempotencyKey];
  writeOps(ops);
}
