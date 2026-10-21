import { describe, expect, it } from "vitest";
import { parseFactEdit, toSourceRefs } from "./fact-edit";

const src0 = {
  "sources[0].sourceId": "SAMPLE_rera",
  "sources[0].url": "https://example.org/sample",
  "sources[0].observedAt": "2026-10-01T10:00:00Z",
};

function form(pairs: [string, string][]) {
  const fd = new FormData();
  for (const [k, v] of pairs) fd.append(k, v);
  return fd;
}

describe("parseFactEdit", () => {
  it("parses a known address from flat fields", () => {
    const r = parseFactEdit({ projectId: "p1", field: "address", status: "known", value: " SAMPLE 1 Example Road ", ...src0 });
    expect(r).toMatchObject({ ok: true, value: { field: "address", value: "SAMPLE 1 Example Road" } });
    if (r.ok) expect(toSourceRefs(r.value)[0]).toEqual({ ...{ sourceId: "SAMPLE_rera", url: "https://example.org/sample", observedAt: "2026-10-01T10:00:00Z" }, documentDate: null });
  });

  it("parses FormData with repeated rera values and multiple sources", () => {
    const r = parseFactEdit(
      form([
        ["projectId", "p1"], ["field", "reraNumbers"], ["status", "known"],
        ["value", "SAMPLE/REF/0001"], ["value", "SAMPLE/REF/0002"],
        ...Object.entries(src0),
        ["sources[1].sourceId", "SAMPLE_dev"], ["sources[1].url", "https://example.com/x"],
        ["sources[1].observedAt", "2026-10-02T00:00:00+05:30"], ["sources[1].documentDate", "2026-09-30"],
        ["sources[1].note", ""],
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toEqual(["SAMPLE/REF/0001", "SAMPLE/REF/0002"]);
      expect(r.value.sources).toHaveLength(2);
    }
  });

  it("splits a comma/newline rera string and rejects bad shapes, duplicates, >5", () => {
    const ok = parseFactEdit({ projectId: "p1", field: "reraNumbers", status: "known", value: "SAMPLE/A/1,\nSAMPLE/B/2", ...src0 });
    expect(ok.ok && ok.value.value).toEqual(["SAMPLE/A/1", "SAMPLE/B/2"]);
    expect(parseFactEdit({ projectId: "p1", field: "reraNumbers", status: "known", value: "<x>", ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "reraNumbers", status: "known", value: "SAMPLE/A/1,SAMPLE/A/1", ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "reraNumbers", status: "known", value: "A/1/x,B/2/x,C/3/x,D/4/x,E/5/x,F/6/x", ...src0 }).ok).toBe(false);
  });

  it("validates per-field values", () => {
    expect(parseFactEdit({ projectId: "p1", field: "constructionStatus", status: "known", value: "ready_to_move", ...src0 }).ok).toBe(true);
    expect(parseFactEdit({ projectId: "p1", field: "constructionStatus", status: "known", value: "done", ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "address", status: "known", value: "abc", ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "declaredPossession", status: "known", value: "x".repeat(101), ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "price", status: "known", value: "1", ...src0 }).ok).toBe(false);
  });

  it("enforces status/value consistency and requires a source even when unknown", () => {
    expect(parseFactEdit({ projectId: "p1", field: "address", status: "unknown", value: "", ...src0 })).toMatchObject({ ok: true, value: { value: null } });
    expect(parseFactEdit({ projectId: "p1", field: "address", status: "unknown", value: "SAMPLE 1 Road", ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "address", status: "known", value: "", ...src0 }).ok).toBe(false);
    expect(parseFactEdit({ projectId: "p1", field: "address", status: "unknown", value: "" }).ok).toBe(false);
  });

  it("validates sources", () => {
    const base = { projectId: "p1", field: "address", status: "known", value: "SAMPLE 1 Road" };
    const bad = (o: Record<string, string>) => parseFactEdit({ ...base, ...src0, ...o }).ok;
    expect(bad({ "sources[0].url": "http://example.org/x" })).toBe(false);
    expect(bad({ "sources[0].url": "not a url" })).toBe(false);
    expect(bad({ "sources[0].sourceId": " " })).toBe(false);
    expect(bad({ "sources[0].observedAt": "2999-01-01T00:00:00Z" })).toBe(false);
    expect(bad({ "sources[0].observedAt": "yesterday" })).toBe(false);
    expect(bad({ "sources[0].documentDate": "2026-10-05" })).toBe(false);
    expect(bad({ "sources[0].note": "x".repeat(301) })).toBe(false);
    expect(bad({ "sources[3].sourceId": "extra" })).toBe(false);
  });

  it("accepts a plain object with a sources array", () => {
    const r = parseFactEdit({
      projectId: "p1", field: "declaredPossession", status: "known", value: "Dec 2027 (as declared)",
      sources: [{ sourceId: "SAMPLE_rera", url: "https://example.org/s", observedAt: "2026-10-01T10:00:00Z" }],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(parseFactEdit(null)).toEqual({ ok: false, errors: ["(root): expected an object or form data"] });
  });
});
