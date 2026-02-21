// src/memory/embeddings.js — Semantic embedding storage & search via sqlite-vec
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('embeddings');

/**
 * Generate a simple hash-based embedding vector for text.
 * In production, replace with real embeddings from an LLM provider.
 * This provides a deterministic, lightweight fallback.
 * @param {string} text
 * @param {number} dims - Embedding dimensions
 * @returns {Float32Array}
 */
export function generateLocalEmbedding(text, dims = 384) {
    const vec = new Float32Array(dims);
    const normalized = text.toLowerCase().trim();

    // Simple character n-gram hashing into vector space
    for (let i = 0; i < normalized.length; i++) {
        const charCode = normalized.charCodeAt(i);
        for (let d = 0; d < Math.min(5, dims); d++) {
            const idx = (charCode * (i + 1) * (d + 7)) % dims;
            vec[idx] += 1.0 / (1 + i * 0.1);
        }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dims; i++) vec[i] /= norm;

    return vec;
}

/**
 * Store a text chunk with its embedding in the vector database.
 * @param {string} content - The text content to embed
 * @param {string} source - Source identifier (e.g., "conversation", "memory", "skill")
 * @param {string} [chatId] - Optional chat context
 * @param {number} [dims] - Embedding dimensions
 * @returns {string} The stored embedding ID
 */
export function storeEmbedding(content, source, chatId = null, dims = 384) {
    const db = getDb();
    const id = uuidv4();
    const embedding = generateLocalEmbedding(content, dims);

    try {
        const insertMeta = db.prepare(`
      INSERT INTO embedding_metadata (id, content, source, chat_id)
      VALUES (?, ?, ?, ?)
    `);

        const insertVec = db.prepare(`
      INSERT INTO vec_embeddings (id, content_embedding)
      VALUES (?, ?)
    `);

        db.transaction(() => {
            insertMeta.run(id, content, source, chatId);
            insertVec.run(id, Buffer.from(embedding.buffer));
        })();

        log.debug({ id, source, contentLength: content.length }, 'Embedding stored');
        return id;
    } catch (err) {
        log.error({ err, source }, 'Failed to store embedding');
        throw err;
    }
}

/**
 * Search for semantically similar content.
 * @param {string} query - The search query
 * @param {number} [topK=5] - Number of results to return
 * @param {number} [dims=384] - Embedding dimensions
 * @returns {Array<{id: string, content: string, source: string, distance: number}>}
 */
export function searchSimilar(query, topK = 5, dims = 384) {
    const db = getDb();
    const queryEmbedding = generateLocalEmbedding(query, dims);

    try {
        const results = db.prepare(`
      SELECT v.id, v.distance, m.content, m.source, m.chat_id
      FROM vec_embeddings v
      JOIN embedding_metadata m ON v.id = m.id
      WHERE content_embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(Buffer.from(queryEmbedding.buffer), topK);

        log.debug({ query: query.slice(0, 50), resultCount: results.length }, 'Semantic search completed');
        return results;
    } catch (err) {
        log.warn({ err }, 'Semantic search failed — returning empty results');
        return [];
    }
}

/**
 * Delete an embedding by ID.
 */
export function deleteEmbedding(id) {
    const db = getDb();
    db.prepare('DELETE FROM embedding_metadata WHERE id = ?').run(id);
    try {
        db.prepare('DELETE FROM vec_embeddings WHERE id = ?').run(id);
    } catch {
        // vec table may not support delete on all versions
    }
}
