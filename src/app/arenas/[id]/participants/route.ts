import { NextRequest, NextResponse } from "next/server";

import { listParticipantsByArenaId } from "@/server/data/mockListData";
import {
  PaginationQueryError,
  paginateByCursor,
  parsePageSize,
} from "@/server/pagination/cursorPagination";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const cursor = request.nextUrl.searchParams.get("cursor");

  try {
    const limit = parsePageSize(request.nextUrl.searchParams.get("limit"));
    const participants = listParticipantsByArenaId(id);
    const result = paginateByCursor({ items: participants, limit, cursor });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PaginationQueryError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json({ error: "Unexpected server error." }, { status: 500 });
  }
}
