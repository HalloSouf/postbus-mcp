import { describe, expect, it } from "vitest";
import {
  allDone,
  assertNotSystemLabel,
  labelChangeFor,
  resolveLabelIds,
  toFolderInfo,
} from "../../../src/providers/gmail/actions.js";
import { PostbusError } from "../../../src/types.js";

const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "Label_12", name: "Invoices", type: "user" },
  { id: "Label_13", name: "Projects/2026", type: "user" },
];

describe("labelChangeFor", () => {
  it("maps read state onto the UNREAD label, which Gmail inverts", () => {
    expect(labelChangeFor("read")).toEqual({ add: [], remove: ["UNREAD"] });
    expect(labelChangeFor("unread")).toEqual({ add: ["UNREAD"], remove: [] });
  });

  it("maps starring onto STARRED", () => {
    expect(labelChangeFor("star")).toEqual({ add: ["STARRED"], remove: [] });
    expect(labelChangeFor("unstar")).toEqual({ add: [], remove: ["STARRED"] });
  });
});

describe("resolveLabelIds", () => {
  it("turns names into the ids the API wants", () => {
    expect(resolveLabelIds(["Invoices", "Projects/2026"], LABELS)).toEqual([
      "Label_12",
      "Label_13",
    ]);
  });

  it("matches system labels regardless of case", () => {
    expect(resolveLabelIds(["inbox"], LABELS)).toEqual(["INBOX"]);
  });

  it("accepts an id that was passed straight back in", () => {
    expect(resolveLabelIds(["Label_12"], LABELS)).toEqual(["Label_12"]);
  });

  it("names what does exist when a label does not", () => {
    try {
      resolveLabelIds(["Nonexistent"], LABELS);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PostbusError);
      expect((error as PostbusError).kind).toBe("not_found");
      expect((error as PostbusError).hint).toContain("Invoices");
    }
  });
});

describe("assertNotSystemLabel", () => {
  it("refuses to touch Gmail's own labels", () => {
    expect(() => assertNotSystemLabel(LABELS[0]!)).toThrow(/system label/i);
  });

  it("allows labels the user made themselves", () => {
    expect(() => assertNotSystemLabel(LABELS[2]!)).not.toThrow();
  });
});

describe("toFolderInfo", () => {
  it("marks the labels that stand in for special folders", () => {
    expect(toFolderInfo(LABELS[0]!).specialUse).toBe("\\Inbox");
    expect(toFolderInfo(LABELS[1]!).specialUse).toBe("\\Trash");
    expect(toFolderInfo(LABELS[2]!).specialUse).toBeUndefined();
  });

  it("keeps the full path but shows the last segment as the name", () => {
    const folder = toFolderInfo(LABELS[3]!);

    expect(folder.path).toBe("Projects/2026");
    expect(folder.name).toBe("2026");
  });
});

describe("allDone", () => {
  it("reports a whole-batch success without inventing failures", () => {
    expect(allDone(["a", "b"], ["note"])).toEqual({
      done: ["a", "b"],
      failed: [],
      notes: ["note"],
    });
  });
});
