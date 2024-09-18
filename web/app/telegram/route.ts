import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const { page } = await req.json();

  try {
    const result =
      await sql`INSERT INTO telegram_pages (title, content) VALUES (${page.title}, ${page.content}) RETURNING id`;

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(error);
  }
}
