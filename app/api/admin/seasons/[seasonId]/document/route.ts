import { NextRequest, NextResponse } from "next/server";
import { authorizeAdmin, errorResponse } from "@/lib/admin-api";
import { createServiceClient } from "@/lib/admin";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bucketName = "season-docs";
const storagePathMarker = `/storage/v1/object/public/${bucketName}/`;

function getSeasonStoragePath(url: string | null, seasonId: string) {
  if (!url) return null;
  try {
    const path = new URL(url).pathname;
    const markerIndex = path.indexOf(storagePathMarker);
    if (markerIndex < 0) return null;
    const storagePath = decodeURIComponent(
      path.slice(markerIndex + storagePathMarker.length),
    );
    return storagePath.startsWith(`${seasonId}/`) ? storagePath : null;
  } catch {
    return null;
  }
}

async function loadSeason(
  serviceClient: ReturnType<typeof createServiceClient>,
  seasonId: string,
) {
  const { data: season, error } = await serviceClient
    .from("seasons")
    .select("id, rules_pdf_url")
    .eq("id", seasonId)
    .maybeSingle();
  if (error) throw new Error(`Could not load season document: ${error.message}`);
  if (!season) return null;
  return season;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  try {
    const { response } = await authorizeAdmin();
    if (response) return response;

    const { seasonId } = await params;
    if (!uuidPattern.test(seasonId)) {
      return NextResponse.json({ error: "Invalid season." }, { status: 400 });
    }

    const body: unknown = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("storage_path" in body) ||
      !("file_name" in body) ||
      typeof body.storage_path !== "string" ||
      typeof body.file_name !== "string"
    ) {
      return NextResponse.json(
        { error: "The uploaded PDF details are invalid." },
        { status: 400 },
      );
    }
    const { storage_path: storagePath, file_name: fileName } = body;
    const pathPattern = new RegExp(
      `^${seasonId}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.pdf$`,
      "i",
    );
    if (
      !pathPattern.test(storagePath) ||
      fileName.length === 0 ||
      fileName.length > 255 ||
      !fileName.toLowerCase().endsWith(".pdf")
    ) {
      return NextResponse.json({ error: "The uploaded PDF details are invalid." }, { status: 400 });
    }

    const serviceClient = createServiceClient();
    const season = await loadSeason(serviceClient, seasonId);
    if (!season) {
      return NextResponse.json({ error: "Season not found." }, { status: 404 });
    }

    const directory = storagePath.slice(0, storagePath.lastIndexOf("/"));
    const fileNameInStorage = storagePath.slice(storagePath.lastIndexOf("/") + 1);
    const { data: uploadedFiles, error: listError } = await serviceClient.storage
      .from(bucketName)
      .list(directory, { search: fileNameInStorage });
    if (listError) {
      throw new Error(`Could not verify the uploaded season PDF: ${listError.message}`);
    }
    const uploadedFile = uploadedFiles.find((item) => item.name === fileNameInStorage);
    if (!uploadedFile) {
      return NextResponse.json(
        { error: "Upload the PDF to this season before saving it." },
        { status: 400 },
      );
    }
    const metadata = uploadedFile.metadata;
    if (
      Number(metadata?.size) > 10 * 1024 * 1024 ||
      (metadata?.mimetype !== undefined && metadata.mimetype !== "application/pdf")
    ) {
      return NextResponse.json(
        { error: "Choose a PDF file no larger than 10 MB." },
        { status: 400 },
      );
    }
    const { data: uploadedBlob, error: downloadError } = await serviceClient.storage
      .from(bucketName)
      .download(storagePath);
    if (downloadError) {
      throw new Error(`Could not verify the uploaded season PDF: ${downloadError.message}`);
    }
    const signature = new Uint8Array(
      await uploadedBlob.slice(0, 5).arrayBuffer(),
    );
    if (new TextDecoder().decode(signature) !== "%PDF-") {
      return NextResponse.json({ error: "The selected file is not a valid PDF." }, { status: 400 });
    }

    const { data: publicUrl } = serviceClient.storage
      .from(bucketName)
      .getPublicUrl(storagePath);
    const { error: updateError } = await serviceClient
      .from("seasons")
      .update({ rules_pdf_url: publicUrl.publicUrl, rules_pdf_name: fileName.trim() })
      .eq("id", seasonId);
    if (updateError) {
      throw new Error(`Could not save the season PDF: ${updateError.message}`);
    }

    const oldStoragePath = getSeasonStoragePath(season.rules_pdf_url, seasonId);
    let cleanupWarning: string | undefined;
    if (oldStoragePath && oldStoragePath !== storagePath) {
      const { error: removeError } = await serviceClient.storage
        .from(bucketName)
        .remove([oldStoragePath]);
      if (removeError) {
        cleanupWarning = `The new PDF is saved, but the previous file could not be removed: ${removeError.message}`;
        console.error(cleanupWarning);
      }
    }

    return NextResponse.json({
      rules_pdf_url: publicUrl.publicUrl,
      rules_pdf_name: fileName.trim(),
      cleanup_warning: cleanupWarning,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  try {
    const { response } = await authorizeAdmin();
    if (response) return response;

    const { seasonId } = await params;
    if (!uuidPattern.test(seasonId)) {
      return NextResponse.json({ error: "Invalid season." }, { status: 400 });
    }

    const serviceClient = createServiceClient();
    const season = await loadSeason(serviceClient, seasonId);
    if (!season) {
      return NextResponse.json({ error: "Season not found." }, { status: 404 });
    }
    const { error: updateError } = await serviceClient
      .from("seasons")
      .update({ rules_pdf_url: null, rules_pdf_name: null })
      .eq("id", seasonId);
    if (updateError) {
      throw new Error(`Could not remove the season PDF: ${updateError.message}`);
    }

    const storagePath = getSeasonStoragePath(season.rules_pdf_url, seasonId);
    let cleanupWarning: string | undefined;
    if (storagePath) {
      const { error: removeError } = await serviceClient.storage
        .from(bucketName)
        .remove([storagePath]);
      if (removeError) {
        cleanupWarning = `The season link was removed, but the stored PDF could not be deleted: ${removeError.message}`;
        console.error(cleanupWarning);
      }
    }

    return NextResponse.json({ ok: true, cleanup_warning: cleanupWarning });
  } catch (error) {
    return errorResponse(error);
  }
}
