import * as mongoose from "mongoose";
import { logger } from "../utils/logger";
import { recordQueryExecution } from "./queryBudget";

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI environment variable is required");
}

// #1525: Attach query budgeting instrumentation to Mongoose operations
mongoose.plugin((schema) => {
  schema.pre(
    [
      "find",
      "findOne",
      "findOneAndUpdate",
      "countDocuments",
      "deleteMany",
      "deleteOne",
      "updateOne",
      "updateMany",
    ],
    function () {
      (this as any)._queryStartTime = process.hrtime.bigint();
    },
  );

  schema.post(
    [
      "find",
      "findOne",
      "findOneAndUpdate",
      "countDocuments",
      "deleteMany",
      "deleteOne",
      "updateOne",
      "updateMany",
    ],
    function (res: any) {
      const startTime = (this as any)._queryStartTime;
      if (startTime) {
        const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        const modelName = (this as any).model?.modelName ?? "UnknownModel";
        const op = (this as any).op ?? "query";
        recordQueryExecution({
          datastore: "mongoose",
          rawQueryOrModel: modelName,
          actionOrOp: op,
          durationMs: elapsedMs,
          rowCount: Array.isArray(res) ? res.length : res ? 1 : 0,
        });
      }
    },
  );
});

export async function connectDB(): Promise<void> {
  await mongoose.connect(MONGODB_URI!, { dbName: "inversearena" });
  logger.info({ dbName: "inversearena" }, "Connected to MongoDB");
}

export { mongoose };
