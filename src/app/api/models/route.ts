import { NextResponse } from "next/server";
import { defaultModel, listModelOptions } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    default: defaultModel,
    models: listModelOptions(),
  });
}
