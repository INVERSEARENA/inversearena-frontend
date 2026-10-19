/**
 * Production bridge from legacy asset shapes to the canonical descriptor
 * (#1521).
 *
 * Keeps {@link adaptLegacyAsset} pure and lets every production call site emit
 * a single, consistent migration metric, so a legacy asset field that should
 * have been retired is observable rather than silently accepted.
 *
 * @module
 */

import {
  adaptLegacyAsset,
  type AssetDescriptor,
  type LegacyAssetInput,
} from "../types/assetDescriptor";
import { legacyAssetMigrationTotal } from "../utils/metrics";

export function migrateLegacyAsset(input: LegacyAssetInput): AssetDescriptor {
  return adaptLegacyAsset(input, (info) => {
    legacyAssetMigrationTotal.inc({ legacy_form: info.legacyForm });
  });
}
