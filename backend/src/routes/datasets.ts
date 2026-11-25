import { Router } from "express";
import fs from "fs";
import path from "path";
import { asyncHandler } from "../middleware/validate";
import { apiError } from "../utils/apiError";
import type { RequestHandler } from "express";

const DATASETS_DIR = path.resolve(process.cwd(), "public/datasets");

/**
 * Public datasets index — #1854.
 *
 * GET /api/datasets           — list available export manifests
 * GET /api/datasets/:date     — download manifest JSON for a given date
 * GET /api/datasets/:date/:filename — download a specific CSV export file
 */
export function createDatasetsRouter(authMiddleware?: RequestHandler): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      if (!fs.existsSync(DATASETS_DIR)) {
        res.json({ datasets: [] });
        return;
      }

      const files = fs.readdirSync(DATASETS_DIR).filter((f) => f.startsWith("manifest_") && f.endsWith(".json"));
      const datasets = files.map((f) => {
        const date = f.replace("manifest_", "").replace(".json", "");
        return { date, manifestUrl: `/api/datasets/${date}` };
      });

      res.json({ datasets: datasets.sort((a, b) => b.date.localeCompare(a.date)) });
    }),
  );

  router.get(
    "/:date",
    asyncHandler(async (req, res) => {
      const { date } = req.params;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw apiError(400, "BAD_REQUEST", "date must be in YYYY-MM-DD format");
      }

      const manifestPath = path.join(DATASETS_DIR, `manifest_${date}.json`);
      if (!fs.existsSync(manifestPath)) {
        throw apiError(404, "NOT_FOUND", `No dataset found for ${date}`);
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      res.json(manifest);
    }),
  );

  router.get(
    "/:date/:filename",
    asyncHandler(async (req, res) => {
      const { date, filename } = req.params;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw apiError(400, "BAD_REQUEST", "date must be in YYYY-MM-DD format");
      }
      if (!filename || filename.includes("..") || filename.includes("/")) {
        throw apiError(400, "BAD_REQUEST", "Invalid filename");
      }

      const filePath = path.join(DATASETS_DIR, filename);
      if (!fs.existsSync(filePath)) {
        throw apiError(404, "NOT_FOUND", `File not found: ${filename}`);
      }

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      fs.createReadStream(filePath).pipe(res);
    }),
  );

  return router;
}
