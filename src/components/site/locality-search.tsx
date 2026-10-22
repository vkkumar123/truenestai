import { Search } from "lucide-react";
import { BHK_OPTIONS, CONSTRUCTION_STATUS_LABELS, CONSTRUCTION_STATUS_OPTIONS, type SearchLane } from "@/domain/search-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export interface SearchDefaults {
  locality?: string;
  q?: string;
  bhk?: string;
  status?: string;
  lane?: SearchLane;
  /** Current compare selection (comma-separated ids), kept across searches. */
  compare?: string;
}

const LANE_LABELS: Record<SearchLane, string> = {
  all: "Researched first (external only if few results)",
  researched: "Researched by TrueNest only",
  external: "Externally discovered only (unverified)",
};

/** Plain GET form to /projects — works without JavaScript. */
export function LocalitySearch({
  localities,
  defaults = {},
  showFilters = true,
}: {
  localities: { id: string; name: string }[];
  defaults?: SearchDefaults;
  showFilters?: boolean;
}) {
  return (
    <form action="/projects" method="get" role="search" className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="search-locality">Locality</Label>
          <Select id="search-locality" name="locality" defaultValue={defaults.locality ?? ""}>
            <option value="">All North Bengaluru localities</option>
            {localities.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="search-q">Project or developer name</Label>
          <Input id="search-q" name="q" type="search" maxLength={100} defaultValue={defaults.q ?? ""} placeholder="e.g. Lakeview" />
        </div>
      </div>
      {showFilters ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="search-bhk">Configuration</Label>
            <Select id="search-bhk" name="bhk" defaultValue={defaults.bhk ?? ""}>
              <option value="">Any BHK</option>
              {BHK_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  {b} BHK
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="search-status">Construction status</Label>
            <Select id="search-status" name="status" defaultValue={defaults.status ?? ""}>
              <option value="">Any status</option>
              {CONSTRUCTION_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {CONSTRUCTION_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="search-lane">Results</Label>
            <Select id="search-lane" name="lane" defaultValue={defaults.lane ?? "all"}>
              {(Object.keys(LANE_LABELS) as SearchLane[]).map((l) => (
                <option key={l} value={l}>
                  {LANE_LABELS[l]}
                </option>
              ))}
            </Select>
          </div>
        </div>
      ) : null}
      {defaults.compare ? <input type="hidden" name="compare" value={defaults.compare} /> : null}
      <Button type="submit" className="w-full sm:w-auto">
        <Search aria-hidden="true" /> Search
      </Button>
    </form>
  );
}
