import { describe, expect, it } from "vitest";
import {
  getFreightCents,
  getFreightClass,
} from "@/lib/freight";

const method = {
  smallCents: 1500,
  mediumCents: 2500,
  largeCents: 4500,
  tubeCents: 2200,
};

describe("freight classification", () => {
  it("uses seller thresholds against the largest saved dimension", () => {
    expect(
      getFreightClass(
        {
          dimensionsW: 700,
          dimensionsH: 900,
          dimensionsD: 30,
          shippingFormat: "STANDARD",
        },
        { smallMaxMm: 800, mediumMaxMm: 1500 },
      ),
    ).toBe("MEDIUM");
    expect(
      getFreightClass(
        {
          dimensionsW: 1200,
          dimensionsH: 1650,
          dimensionsD: null,
          shippingFormat: "STANDARD",
        },
        { smallMaxMm: 800, mediumMaxMm: 1500 },
      ),
    ).toBe("LARGE");
  });

  it("uses tube pricing when a seller marks artwork as rolled", () => {
    const freightClass = getFreightClass(
      {
        dimensionsW: null,
        dimensionsH: null,
        dimensionsD: null,
        shippingFormat: "TUBE",
      },
      null,
    );
    expect(freightClass).toBe("TUBE");
    expect(getFreightCents(method, freightClass!)).toBe(2200);
  });

  it("does not quote standard freight when required dimensions are missing", () => {
    expect(
      getFreightClass(
        {
          dimensionsW: 500,
          dimensionsH: null,
          dimensionsD: null,
          shippingFormat: "STANDARD",
        },
        null,
      ),
    ).toBeNull();
  });

  it("uses the charge belonging to the selected freight class", () => {
    expect(getFreightCents(method, "SMALL")).toBe(1500);
    expect(getFreightCents(method, "MEDIUM")).toBe(2500);
    expect(getFreightCents(method, "LARGE")).toBe(4500);
  });
});