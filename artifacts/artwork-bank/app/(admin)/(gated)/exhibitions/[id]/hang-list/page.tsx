/**
 * Exhibition — printable hang list  (Task #81)
 */
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@workspace/db";
import {
  exhibitionShowsTable,
  exhibitionRoomsTable,
  exhibitionWallsTable,
  exhibitionPlacementsTable,
  artworksTable,
  tenantsTable,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

export default async function HangListPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session.userId) redirect("/login");

  const [show, tenant] = await Promise.all([
    db.query.exhibitionShowsTable.findFirst({
      where: and(
        eq(exhibitionShowsTable.id, id),
        eq(exhibitionShowsTable.tenantId, session.tenantId),
      ),
    }),
    db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, session.tenantId) }),
  ]);

  if (!show || !tenant) notFound();

  // Build the hang list: rooms → walls → placements
  const rooms = await db
    .select()
    .from(exhibitionRoomsTable)
    .where(eq(exhibitionRoomsTable.showId, id))
    .orderBy(asc(exhibitionRoomsTable.createdAt));

  const roomsWithData = await Promise.all(
    rooms.map(async (room) => {
      const walls = await db
        .select()
        .from(exhibitionWallsTable)
        .where(eq(exhibitionWallsTable.roomId, room.id))
        .orderBy(asc(exhibitionWallsTable.createdAt));

      const wallsWithPlacements = await Promise.all(
        walls.map(async (wall) => {
          const placements = await db
            .select({
              placement: exhibitionPlacementsTable,
              title: artworksTable.title,
              sku: artworksTable.sku,
              medium: artworksTable.medium,
              heightCm: artworksTable.dimensionsH,
              widthCm: artworksTable.dimensionsW,
              price: artworksTable.price,
            })
            .from(exhibitionPlacementsTable)
            .innerJoin(artworksTable, eq(exhibitionPlacementsTable.artworkId, artworksTable.id))
            .where(eq(exhibitionPlacementsTable.wallId, wall.id))
            .orderBy(asc(exhibitionPlacementsTable.xCm));
          return { wall, placements };
        }),
      );
      return { room, walls: wallsWithPlacements };
    }),
  );

  const allPlacements = roomsWithData.flatMap((r) => r.walls.flatMap((w) => w.placements));
  const themeColor = tenant.themeColor ?? "#1c1917";
  const printDate = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

  let counter = 0;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`Hang List — ${show.title}`}</title>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Inter', sans-serif; background: #f5f5f0; color: #1c1917; padding: 32px; }
          .page { background: white; width: 210mm; margin: 0 auto; padding: 16mm 20mm; }
          .header { border-bottom: 2px solid ${themeColor}; padding-bottom: 5mm; margin-bottom: 6mm; display: flex; justify-content: space-between; align-items: flex-end; }
          .gallery-name { font-size: 13pt; font-weight: 700; color: ${themeColor}; }
          .show-title { font-size: 16pt; font-weight: 700; margin-bottom: 1mm; }
          .show-meta { font-size: 8.5pt; color: #78716c; margin-bottom: 5mm; }
          .section-head { font-size: 8pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: ${themeColor}; margin-top: 5mm; margin-bottom: 2mm; border-bottom: 1px solid ${themeColor}22; padding-bottom: 1mm; }
          .wall-head { font-size: 8pt; font-weight: 600; color: #57534e; margin-top: 3mm; margin-bottom: 1mm; }
          table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
          th { text-align: left; padding: 1.5mm 2mm; background: #fafaf9; border-bottom: 1px solid #e7e5e4; font-size: 7pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: #a8a29e; }
          td { padding: 2mm 2mm; border-bottom: 1px solid #f5f5f4; vertical-align: top; }
          .num { color: #a8a29e; font-size: 7pt; }
          .print-btn { display: block; text-align: center; margin-bottom: 16px; }
          .print-btn button { background: ${themeColor}; color: white; border: none; border-radius: 8px; padding: 10px 24px; font-size: 14px; cursor: pointer; }
          .foot { border-top: 1px solid #e7e5e4; padding-top: 3mm; margin-top: 5mm; font-size: 7pt; color: #a8a29e; }
          @media print {
            body { background: white; padding: 0; }
            .page { width: 100%; margin: 0; padding: 12mm 14mm; }
            .print-btn { display: none; }
          }
        `}</style>
      </head>
      <body>
        <div className="print-btn">
          <button id="print-btn">🖨 Print / Save as PDF</button>
        </div>
        <div className="page">
          <div className="header">
            <div className="gallery-name">{tenant.businessName}</div>
            <div style={{ fontSize: "7.5pt", color: "#78716c", textAlign: "right" }}>
              Hang List<br />Printed {printDate}
            </div>
          </div>
          <h1 className="show-title">{show.title}</h1>
          <p className="show-meta">
            {show.venue && <span>{show.venue} · </span>}
            {show.openingDate ? `${show.openingDate}${show.closingDate ? ` → ${show.closingDate}` : ""}` : "Dates TBA"}
            {" · "}{allPlacements.length} work{allPlacements.length !== 1 ? "s" : ""}
          </p>

          {roomsWithData.map(({ room, walls }) => {
            const wallsWithArt = walls.filter((w) => w.placements.length > 0);
            if (wallsWithArt.length === 0) return null;
            return (
              <div key={room.id}>
                <div className="section-head">{room.name}</div>
                {wallsWithArt.map(({ wall, placements }) => (
                  <div key={wall.id}>
                    <div className="wall-head">{wall.name}</div>
                    <table>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Artwork</th>
                          <th>Medium / Dimensions</th>
                          <th>Hang height</th>
                          <th>Position</th>
                        </tr>
                      </thead>
                      <tbody>
                        {placements.map(({ placement, title, sku, medium, heightCm, widthCm }) => {
                          counter++;
                          const dims = widthCm && heightCm ? `${widthCm} × ${heightCm} cm` : "";
                          return (
                            <tr key={placement.id}>
                              <td className="num">{counter}</td>
                              <td>
                                <div style={{ fontWeight: 500 }}>{title}</div>
                                <div className="num">{sku}</div>
                              </td>
                              <td style={{ color: "#57534e" }}>
                                {medium && <div>{medium}</div>}
                                {dims && <div>{dims}</div>}
                              </td>
                              <td style={{ fontWeight: 600 }}>{placement.hangHeightCm} cm</td>
                              <td style={{ color: "#78716c" }}>{placement.xCm != null ? `${placement.xCm} cm` : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            );
          })}

          <div className="foot">
            {tenant.businessName}{tenant.contactEmail ? ` · ${tenant.contactEmail}` : ""}
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `document.getElementById('print-btn')?.addEventListener('click', () => window.print());` }} />
      </body>
    </html>
  );
}
