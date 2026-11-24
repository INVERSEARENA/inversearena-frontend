WITH round_choices AS (
  SELECT
    r.id                                       AS round_id,
    r.arena_id,
    (choice->>'userId')                        AS user_id,
    COALESCE((
      SELECT SUM((p->>'amount')::numeric)
      FROM jsonb_array_elements(r.metadata->'resolution'->'payouts') AS p
      WHERE p->>'userId' = choice->>'userId'
    ), 0)                                      AS payout
  FROM rounds r
  CROSS JOIN LATERAL jsonb_array_elements(r.metadata->'playerChoices') AS c(choice)
  WHERE r.state = 'RESOLVED'
),
round_stats AS (
  SELECT
    user_id,
    SUM(payout) AS total_yield
  FROM round_choices
  GROUP BY user_id
),
elim_stats AS (
  SELECT DISTINCT el.user_id
  FROM elimination_logs el
  JOIN rounds r ON r.id = el.round_id
  WHERE r.state = 'RESOLVED'
),
arena_wins AS (
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
round_survivals AS (
  SELECT rc.user_id, COUNT(*)::bigint AS survival_streak
  FROM (SELECT DISTINCT user_id, round_id FROM round_choices) rc
  WHERE NOT EXISTS (
    SELECT 1
    FROM elimination_logs el
    JOIN rounds r ON r.id = el.round_id
    WHERE el.user_id = rc.user_id
      AND el.round_id = rc.round_id
      AND r.state = 'RESOLVED'
  )
  GROUP BY rc.user_id
),
all_user_ids AS (
  SELECT user_id FROM round_stats
  UNION
  SELECT user_id FROM elim_stats
)
SELECT
  u.id,
  u.wallet_address                                                    AS "walletAddress",
  COALESCE(rs.total_yield, 0)::numeric                                AS "totalYield",
  COALESCE(aw.arenas_won, 0)::bigint                                  AS "arenasWon",
  COALESCE(sv.survival_streak, 0)::bigint                             AS "survivalStreak",
  ROW_NUMBER() OVER (
    ORDER BY
      COALESCE(rs.total_yield, 0)::numeric DESC,
      COALESCE(aw.arenas_won, 0)::bigint DESC
  )                                                                   AS "rank"
FROM all_user_ids au
JOIN users u ON u.id = au.user_id
LEFT JOIN round_stats rs ON rs.user_id = au.user_id
LEFT JOIN arena_wins aw ON aw.user_id = au.user_id
LEFT JOIN round_survivals sv ON sv.user_id = au.user_id
WHERE (
  NOT $1
  OR NOT EXISTS (
    SELECT 1
    FROM sybil_flags sf
    WHERE sf.wallet_address = u.wallet_address
      AND sf.reviewed_at IS NULL
  )
)
ORDER BY "totalYield" DESC, "arenasWon" DESC
LIMIT $2 OFFSET $3;
