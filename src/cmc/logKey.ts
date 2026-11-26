import { createHash } from 'node:crypto';

/**
 * A relationship in a log line or an error message: a short hash, never its key, whose default
 * (`counterpartySlug`, `<username>--<host>`) holds the person's username. Same hash as the HDS Reader
 * engine's `logKey`, so the two lines of one relationship match. To find a known key's lines, hash it.
 */
export const logKey = (userKey: string): string => createHash('sha256').update('log|' + userKey).digest('hex').slice(0, 12);
