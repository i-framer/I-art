import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  artworksTable,
  representedArtistsTable,
  tenantsTable,
} from "../src/schema/index.js";

describe("artwork keyword search indexes", () => {
  it("declares every index checked by schema drift validation", () => {
    const indexNames = [
      ...getTableConfig(artworksTable).indexes,
      ...getTableConfig(representedArtistsTable).indexes,
      ...getTableConfig(tenantsTable).indexes,
    ].map((index) => index.config.name);

    expect(indexNames).toEqual(
      expect.arrayContaining([
        "artwork_title_trgm_idx",
        "artwork_sku_trgm_idx",
        "artwork_represented_artist_idx",
        "represented_artist_name_trgm_idx",
        "tenant_business_name_trgm_idx",
      ]),
    );
  });
});