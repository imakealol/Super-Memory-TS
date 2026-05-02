/**
 * Content hashing utilities for Super-Memory
 * 
 * Uses SHA-256 for content verification and deduplication.
 */

import { createHash } from 'crypto';

/**
 * Hash a string content using SHA-256
 * @param content - The content to hash
 * @returns The SHA-256 hash as a hex string
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}