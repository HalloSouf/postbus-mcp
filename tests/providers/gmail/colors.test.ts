import { describe, expect, it } from "vitest";
import { colorNames, resolveLabelColor } from "../../../src/providers/gmail/colors.js";
import { PostbusError } from "../../../src/types.js";

describe("resolveLabelColor", () => {
  it("turns a colour name into the pair Gmail wants", () => {
    expect(resolveLabelColor({ color: "red" })).toEqual({
      backgroundColor: "#fb4c2f",
      textColor: "#ffffff",
    });
  });

  it("shrugs off casing, spaces and dashes in the name", () => {
    const expected = resolveLabelColor({ color: "lightgreen" });

    expect(resolveLabelColor({ color: "LightGreen" })).toEqual(expected);
    expect(resolveLabelColor({ color: "light green" })).toEqual(expected);
    expect(resolveLabelColor({ color: "light-green" })).toEqual(expected);
  });

  it("pairs light backgrounds with dark text so the label stays readable", () => {
    expect(resolveLabelColor({ color: "yellow" }).textColor).toBe("#000000");
    expect(resolveLabelColor({ color: "white" }).textColor).toBe("#000000");
    expect(resolveLabelColor({ color: "black" }).textColor).toBe("#ffffff");
  });

  it("offers every known name when given one it does not know", () => {
    try {
      resolveLabelColor({ color: "chartreuse" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PostbusError);
      expect((error as PostbusError).hint).toContain("purple");
    }
  });

  it("says something useful when no colour is given at all", () => {
    expect(() => resolveLabelColor({})).toThrow(/No colour given/);
  });

  it("accepts an explicit pair from the palette", () => {
    expect(resolveLabelColor({ backgroundColor: "#16a766", textColor: "#ffffff" })).toEqual({
      backgroundColor: "#16a766",
      textColor: "#ffffff",
    });
  });

  it("adds the missing # so a bare hex still works", () => {
    expect(resolveLabelColor({ backgroundColor: "16a766", textColor: "ffffff" })).toEqual({
      backgroundColor: "#16a766",
      textColor: "#ffffff",
    });
  });

  // Gmail answers an unlisted colour with a bare 400, which tells the user
  // nothing about why their perfectly ordinary hex was refused.
  it("refuses a hex outside Gmail's palette before the API does", () => {
    try {
      resolveLabelColor({ backgroundColor: "#ff0000", textColor: "#ffffff" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PostbusError).message).toContain("#ff0000");
      expect((error as PostbusError).hint).toContain("palette");
    }
  });

  it("needs both halves of an explicit pair", () => {
    expect(() => resolveLabelColor({ backgroundColor: "#16a766" })).toThrow(/text_color/);
    expect(() => resolveLabelColor({ textColor: "#ffffff" })).toThrow(/background_color/);
  });

  it("lets an explicit pair win over a name", () => {
    const result = resolveLabelColor({
      color: "red",
      backgroundColor: "#16a766",
      textColor: "#ffffff",
    });

    expect(result.backgroundColor).toBe("#16a766");
  });
});

describe("colorNames", () => {
  it("lists names the tool description can show", () => {
    expect(colorNames()).toContain("red");
    expect(colorNames()).toContain("blue");
    expect(colorNames().length).toBeGreaterThan(10);
  });

  it("only offers names that resolve", () => {
    for (const name of colorNames()) {
      expect(() => resolveLabelColor({ color: name }), name).not.toThrow();
    }
  });
});
