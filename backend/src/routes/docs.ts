import { Router, type NextFunction, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "../openapi/registerPaths";

let cachedSpec: ReturnType<typeof generateOpenApiDocument> | null = null;

function getSpec() {
  if (!cachedSpec) {
    cachedSpec = generateOpenApiDocument();
  }
  return cachedSpec;
}

export function createDocsRouter(): Router {
  const router = Router();

  router.get("/docs.json", (_req, res) => {
    res.json(getSpec());
  });

  router.use(
    "/docs",
    swaggerUi.serve,
    (req: Request, res: Response, next: NextFunction) => {
      swaggerUi.setup(getSpec())(req, res, next);
    },
  );

  return router;
}

/** Reset cached spec (tests). */
export function clearOpenApiCache(): void {
  cachedSpec = null;
}
