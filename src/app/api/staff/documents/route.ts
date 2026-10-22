// Staff-only document upload (multipart). See src/server/http/document-upload.ts for the contract.
import { revalidatePath } from "next/cache";
import { handleDocumentUpload } from "@/server/http/document-upload";

export async function POST(request: Request) {
  return handleDocumentUpload(request, {
    onUploaded: (projectId) => revalidatePath(`/admin/projects/${projectId}`),
  });
}
