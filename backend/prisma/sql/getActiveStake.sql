SELECT COALESCE(SUM((choice->>'stake')::numeric), 0)::text AS total
FROM   rounds r
CROSS  JOIN LATERAL jsonb_array_elements(r.metadata->'playerChoices') AS c(choice)
WHERE  r.state IN ('OPEN', 'CLOSED')
  AND  choice->>'userId' = $1;
