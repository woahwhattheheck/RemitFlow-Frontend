/**
 * Deterministic transfer search, filter, sort, and result capping.
 *
 * Client-side filter fan-out races and unbounded scans get slow as history
 * grows. These helpers define one canonical filter/sort/scope semantics used
 * by the list API and the Transfers page so stale responses, missing actor
 * scope, and uncapped result sets cannot silently corrupt the UI.
 */

import { normalizeStatus } from '../services/contracts/transfer.js';
import { isWithinDateRange } from './dateRange.js';

/** Debounce window for free-text search queries (ms). */
export const SEARCH_DEBOUNCE_MS = 300;

/** Default maximum rows a single list query may return. */
export const DEFAULT_RESULT_CAP = 100;

/** Hard ceiling — callers may request less, never more. */
export const MAX_RESULT_CAP = 500;

/**
 * @param {unknown} actorId
 * @returns {string}
 */
export function requireActorId(actorId) {
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw new Error('actorId is required on every transfer list request');
  }
  return actorId.trim();
}

/**
 * Canonical filter bag bound into every request and stale-response check.
 * @param {{search?: string, status?: string, range?: string, actorId?: string, limit?: number}} input
 */
export function normalizeTransferQuery(input = {}) {
  const actorId = requireActorId(input.actorId);
  const search = String(input.search ?? '').trim();
  const statusRaw = String(input.status ?? '').trim();
  const status = statusRaw ? (normalizeStatus(statusRaw) ?? statusRaw) : '';
  const range = String(input.range ?? '').trim();
  const requested =
    Number.isFinite(input.limit) && input.limit > 0
      ? Math.floor(input.limit)
      : DEFAULT_RESULT_CAP;
  const limit = Math.min(Math.max(requested, 1), MAX_RESULT_CAP);

  return { actorId, search, status, range, limit };
}

/**
 * Stable string identity for a query — used to ignore stale responses.
 * @param {{search?: string, status?: string, range?: string, actorId?: string, limit?: number}} query
 */
export function transferQueryScopeKey(query) {
  const normalized = normalizeTransferQuery(query);
  return JSON.stringify(normalized);
}

/**
 * Whether a transfer belongs to the requesting actor.
 * Legacy rows without actorId are only visible to the supplied legacyActor
 * (the historical demo owner) so migration does not leak across wallets.
 *
 * @param {object} transfer
 * @param {string} actorId
 * @param {{legacyActorId?: string}} [options]
 */
export function isVisibleToActor(transfer, actorId, options = {}) {
  if (!actorId) return false;
  const owner = transfer?.actorId;
  if (typeof owner === 'string' && owner.length > 0) {
    return owner === actorId;
  }
  const legacy = options.legacyActorId;
  return Boolean(legacy) && actorId === legacy;
}

/**
 * Apply status / search / date-range predicates (actor scope is separate).
 * @param {object} transfer
 * @param {{search?: string, status?: string, range?: string}} filters
 * @param {Date} [now]
 */
export function matchesTransferFilters(
  transfer,
  filters = {},
  now = new Date(),
) {
  const status = filters.status
    ? (normalizeStatus(filters.status) ?? filters.status)
    : '';
  if (status && normalizeStatus(transfer.status) !== status) return false;

  const search = String(filters.search ?? '')
    .trim()
    .toLowerCase();
  if (search) {
    const recipient = String(transfer.recipient ?? '').toLowerCase();
    if (!recipient.includes(search)) return false;
  }

  if (!isWithinDateRange(transfer.createdAt, filters.range ?? '', now)) {
    return false;
  }

  return true;
}

/**
 * Newest-first ordering with id as the deterministic tie-breaker.
 * @param {object[]} transfers
 * @returns {object[]}
 */
export function stableSortTransfers(transfers) {
  return (transfers ?? []).slice().sort((a, b) => {
    const aTime = Date.parse(a?.createdAt ?? '') || 0;
    const bTime = Date.parse(b?.createdAt ?? '') || 0;
    if (bTime !== aTime) return bTime - aTime;
    return String(b?.id ?? '').localeCompare(String(a?.id ?? ''));
  });
}

/**
 * Filter by actor + predicates, stable-sort, and cap.
 *
 * @param {object[]} transfers
 * @param {{search?: string, status?: string, range?: string, actorId: string, limit?: number}} query
 * @param {{now?: Date, legacyActorId?: string}} [options]
 * @returns {{items: object[], totalMatched: number, capped: boolean, scopeKey: string}}
 */
export function applyTransferSearch(transfers, query, options = {}) {
  const normalized = normalizeTransferQuery(query);
  const now = options.now ?? new Date();
  const scoped = (transfers ?? []).filter((t) =>
    isVisibleToActor(t, normalized.actorId, {
      legacyActorId: options.legacyActorId,
    }),
  );
  const matched = scoped.filter((t) =>
    matchesTransferFilters(t, normalized, now),
  );
  const sorted = stableSortTransfers(matched);
  const items = sorted.slice(0, normalized.limit);

  return {
    items,
    totalMatched: matched.length,
    capped: matched.length > normalized.limit,
    scopeKey: transferQueryScopeKey(normalized),
  };
}
