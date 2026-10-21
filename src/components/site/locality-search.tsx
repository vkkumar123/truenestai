import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/** Plain GET form to /projects — works without JavaScript. */
export function LocalitySearch({
  localities,
  defaultLocality = "",
  defaultQuery = "",
}: {
  localities: { id: string; name: string }[];
  defaultLocality?: string;
  defaultQuery?: string;
}) {
  return (
    <form action="/projects" method="get" role="search" className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="search-locality">Locality</Label>
        <Select id="search-locality" name="locality" defaultValue={defaultLocality}>
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
        <Input id="search-q" name="q" type="search" maxLength={100} defaultValue={defaultQuery} placeholder="e.g. Lakeview" />
      </div>
      <Button type="submit" className="w-full sm:w-auto">
        <Search aria-hidden="true" /> Search
      </Button>
    </form>
  );
}
