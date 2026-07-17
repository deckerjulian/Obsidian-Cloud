-- E2EE-4: node names become ciphertext; the materialized path becomes an
-- id-chain (reveals no names) and every node gets a docId (content/name key id).

-- Names are no longer unique (ciphertext is non-deterministic).
DROP INDEX "nodes_parentId_name_key";

-- Backfill: give every non-root node a docId so its name + content can be keyed.
UPDATE "nodes" SET "docId" = gen_random_uuid()
WHERE "path" <> '' AND "docId" IS NULL;

-- Backfill: rewrite the materialized path from a name-chain to an id-chain
-- (structure only — no names). The root keeps path '' / depth 0.
WITH RECURSIVE idtree AS (
  SELECT n."id", n."id"::text AS idpath, 1 AS d
  FROM "nodes" n
  JOIN "nodes" p ON n."parentId" = p."id"
  WHERE p."path" = ''
  UNION ALL
  SELECT c."id", t.idpath || '/' || c."id", t.d + 1
  FROM "nodes" c
  JOIN idtree t ON c."parentId" = t."id"
)
UPDATE "nodes" SET "path" = idtree.idpath, "depth" = idtree.d
FROM idtree
WHERE "nodes"."id" = idtree."id";
