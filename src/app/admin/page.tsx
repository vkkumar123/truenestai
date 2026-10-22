import { redirect } from "next/navigation";

// This route only redirects, so there is no UI to validate for instant navigation.
export const instant = false;

export default function AdminIndex() {
  redirect("/admin/leads");
}
