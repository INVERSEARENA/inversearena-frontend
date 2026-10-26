import type { Command } from "commander";
import type { Context } from "../context.js";
import { print } from "../output.js";
import { readAll } from "../reads.js";

export async function oracleSchedule(ctx: Context) {
  const oracle = ctx.contract("oracle");
  const read = (method: string) => ctx.ops.read(oracle, "oracle", method);
  return {
    oracle,
    ...(await readAll({
      current_yield_bps: () => read("get_current_yield_bps"),
      reading: () => read("get_oracle_reading"),
      schedule: () => read("get_rate_schedule"),
      activation_delay_secs: () => read("get_activation_delay"),
      max_yield_bps: () => read("get_max_yield_bps"),
      max_delta_bps: () => read("get_max_delta_bps"),
    })),
  };
}

export function registerOracle(program: Command, context: () => Context) {
  program
    .command("oracle")
    .description("Yield oracle views")
    .command("schedule")
    .description("Current and scheduled yield rate, last reading and rate limits")
    .action(async () => {
      const ctx = context();
      print(await oracleSchedule(ctx), ctx.json);
    });
}
