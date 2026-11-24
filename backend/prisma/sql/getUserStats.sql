WITH round_choices AS (
  SELECT
    r.arena_id,
    (choice->>'userId')                         AS user_id,
    COALESCE((
      SELECT SUM((p->>'amount')::numeric)
      FROM jsonb_array_elements(r.metadata->'resolution'->'payouts') AS p
      WHERE p->>'userId' = choice->>'userId'
    ), 0)                                        AS payout
  FROM rounds r
  CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'playerChoices') AS c(choice)
  WHERE r.state = 'RESOLVED'
),
participation AS (
  SELECT
    user_id,
    SUM(payout) AS total_yield
  FROM round_choices
  GROUP BY user_id
),
won AS (
  SELECT rc.user_id, COUNT(*)::bigint AS arenas_won
  FROM (SELECT DISTINCT user_id, arena_id FROM round_choices) rc
  WHERE NOT EXISTS (
    SELECT 1
    FROM elimination_logs el
    JOIN rounds r ON r.id = el.round_id
    WHERE el.user_id = rc.user_id
      AND r.arena_id = rc.arena_id
      AND r.state = 'RESOLVED'
  )
  GROUP BY rc.user_id
),
played AS (
  SELECT user_id, COUNT(DISTINCT arena_id) AS arenas_played
  FROM (
    SELECT user_id, arena_id FROM round_choices
    UNION
    SELECT el.user_id, r.arena_id FROM elimination_logs el JOIN rounds r ON r.id = el.round_id
  ) all_arenas
  GROUP BY user_id
),
ranked AS (
  SELECT
    user_id,
    total_yield,
    RANK() OVER (ORDER BY total_yield DESC) AS rank
  FROM participation
  WHERE total_yield > 0
)
SELECT
  COALESCE(pl.arenas_played, 0)::bigint                                          AS "gamesPlayed",
  COALESCE(w.arenas_won, 0)::bigint                                              AS "gamesWon",
  COALESCE(p.total_yield, 0)::numeric                                            AS "totalYield",
  r.rank::bigint                                                                 AS "rank"
FROM (SELECT $1::text AS user_id) target
LEFT JOIN played pl ON pl.user_id = target.user_id
LEFT JOIN participation p ON p.user_id = target.user_id
LEFT JOIN won w ON w.user_id = target.user_id
LEFT JOIN ranked r ON r.user_id = target.user_id;
