import db from '../db/connection.js';

/**
 * Search English and translated card names without running correlated foreign-
 * name EXISTS queries once per card/printing. The foreign table is scanned at
 * most once for the search term, then the small candidate set is joined to
 * printings.
 */
export function searchCards(query, limit = 20, typeFilter = null) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return [];

  const safeLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const candidateLimit = Math.max(safeLimit * 5, 50);
  const prefix = `${trimmed}%`;
  const infix = `%${trimmed}%`;
  const typeClause = typeFilter ? 'AND c.type_line LIKE ?' : '';

  const params = [prefix, infix];
  if (typeFilter) params.push(`%${typeFilter}%`);
  params.push(prefix, infix);
  if (typeFilter) params.push(`%${typeFilter}%`);
  params.push(candidateLimit, safeLimit);

  const rows = db.all(`
    WITH candidate_rows AS (
      SELECT
        c.id,
        c.name,
        CASE WHEN c.name LIKE ? THEN 0 ELSE 1 END AS match_priority
      FROM cards c
      WHERE c.name LIKE ?
        ${typeClause}

      UNION ALL

      SELECT
        c.id,
        c.name,
        CASE WHEN f.foreign_name LIKE ? THEN 2 ELSE 3 END AS match_priority
      FROM card_foreign_data f
      JOIN cards c ON c.name = f.card_name
      WHERE f.foreign_name LIKE ?
        ${typeClause}
    ),
    candidates AS (
      SELECT id, name, MIN(match_priority) AS match_priority
      FROM candidate_rows
      GROUP BY id, name
      ORDER BY match_priority, name
      LIMIT ?
    )
    SELECT
      c.id,
      c.name,
      c.mana_cost,
      c.cmc,
      c.colors,
      c.type_line,
      c.oracle_text,
      p.image_url,
      p.set_code,
      s.name AS set_name,
      p.collector_number,
      p.rarity,
      p.uuid AS sample_uuid,
      candidates.match_priority
    FROM candidates
    JOIN cards c ON c.id = candidates.id
    LEFT JOIN printings p ON p.card_id = c.id
    LEFT JOIN sets s ON s.code = p.set_code
    ORDER BY candidates.match_priority, c.name, p.set_code, p.collector_number
    LIMIT ?
  `, params);

  return rows.map(row => ({
    ...row,
    large_image_url: row.image_url ? row.image_url.replace('/normal/', '/large/') : null,
    art_crop_url: row.image_url ? row.image_url.replace('/normal/', '/art_crop/') : null,
  }));
}
