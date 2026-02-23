import { v4 as uuidv4 } from "uuid";
// @ts-ignore
import pinoHttp from "pino-http";
import { logger } from "../utils/logger";

export const requestLogger = pinoHttp({
    logger,
    genReqId: function (req, res) {
        const existingID = req.id ?? req.headers["x-request-id"];
        if (existingID) return existingID;
        const id = uuidv4();
        res.setHeader("X-Request-Id", id);
        return id;
    },
    customProps: (req, res) => {
        return {
            ctx: {
                method: req.method,
                url: req.url,
            },
        };
    },
});
