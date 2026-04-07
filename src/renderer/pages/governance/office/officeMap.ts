/**
 * @license Apache-2.0
 * Office tilemap layout — defines zones: work area, breakout/cafeteria, hallways.
 * 0=wall, 1=floor(work), 2=floor(breakout), 3=floor(hallway), 9=void
 */

// 32 cols × 24 rows office
// W = work zone, B = breakout/cafeteria, H = hallway, X = wall
export const OFFICE_COLS = 32;
export const OFFICE_ROWS = 24;

// prettier-ignore
export const OFFICE_TILES: number[] = [
  // Row 0-1: Top wall
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  // Row 2-3: Work area top
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  // Row 4-5: Work desks
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  // Row 6-7: Work desks
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  // Row 8-9: Work desks
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  // Row 10-11: Work area bottom + hallway
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,2,2,2,2,2,2,2,2,2,2,2,0,0,
  // Row 12-13: Hallway connecting both zones
  0,0,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,0,0,
  0,0,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,0,0,
  // Row 14-19: Lower work area
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  // Row 20-21: Bottom work area
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,0,0,
  // Row 22-23: Bottom wall
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
];

/** Desk positions in work zones: {col, row} of top-left of desk area */
export const DESK_POSITIONS = [
  // Left work area (rows 2-11)
  { col: 3, row: 3 },
  { col: 7, row: 3 },
  { col: 11, row: 3 },
  { col: 3, row: 6 },
  { col: 7, row: 6 },
  { col: 11, row: 6 },
  { col: 3, row: 9 },
  { col: 7, row: 9 },
  { col: 11, row: 9 },
  // Left lower area (rows 14-21)
  { col: 3, row: 15 },
  { col: 7, row: 15 },
  { col: 11, row: 15 },
  { col: 3, row: 18 },
  { col: 7, row: 18 },
  { col: 11, row: 18 },
  // Right lower area
  { col: 20, row: 15 },
  { col: 24, row: 15 },
  { col: 28, row: 15 },
  { col: 20, row: 18 },
  { col: 24, row: 18 },
  { col: 28, row: 18 },
];

/** Breakout zone areas — where idle agents can wander */
export const BREAKOUT_TILES: Array<{ col: number; row: number }> = [];
for (let r = 2; r < 12; r++) {
  for (let c = 19; c < 30; c++) {
    BREAKOUT_TILES.push({ col: c, row: r });
  }
}

/** Coffee machine positions in breakout area */
export const COFFEE_MACHINES = [
  { col: 20, row: 3 },
  { col: 28, row: 3 },
];

/** Plant decoration positions */
export const PLANT_POSITIONS = [
  { col: 2, row: 2 },
  { col: 13, row: 2 },
  { col: 2, row: 11 },
  { col: 13, row: 11 },
  { col: 19, row: 2 },
  { col: 29, row: 2 },
  { col: 19, row: 11 },
  { col: 29, row: 11 },
  { col: 2, row: 14 },
  { col: 13, row: 14 },
  { col: 18, row: 14 },
  { col: 29, row: 14 },
];

/** Sofa/seating in breakout cafeteria */
export const SOFA_POSITIONS = [
  { col: 22, row: 6 },
  { col: 26, row: 6 },
  { col: 22, row: 9 },
  { col: 26, row: 9 },
];

/** Small tables in cafeteria */
export const CAFE_TABLE_POSITIONS = [
  { col: 24, row: 5 },
  { col: 24, row: 8 },
];

/** Bookshelf positions (against walls) */
export const BOOKSHELF_POSITIONS = [
  { col: 2, row: 13 },
  { col: 13, row: 13 },
  { col: 19, row: 13 },
  { col: 29, row: 13 },
];

/** Whiteboard positions (meeting areas) */
export const WHITEBOARD_POSITIONS = [
  { col: 14, row: 4 },
  { col: 14, row: 8 },
];

/** Cactus / pot positions (decorative) */
export const CACTUS_POSITIONS = [
  { col: 21, row: 5 },
  { col: 27, row: 5 },
  { col: 21, row: 8 },
  { col: 27, row: 8 },
];

/**
 * Generate a unique office seed from team ID for slight layout variations.
 * Returns a deterministic number 0-99 for each team.
 */
export function teamSeed(teamId: string): number {
  let hash = 0;
  for (let i = 0; i < teamId.length; i++) {
    hash = teamId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 100;
}

export function isWalkable(col: number, row: number, blockedTiles: Set<string>): boolean {
  if (col < 0 || col >= OFFICE_COLS || row < 0 || row >= OFFICE_ROWS) return false;
  const tile = OFFICE_TILES[row * OFFICE_COLS + col];
  if (tile === 0 || tile === 9) return false;
  return !blockedTiles.has(`${col},${row}`);
}

/** BFS pathfinding on 4-connected grid. Returns path excluding start, including end. */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  blockedTiles: Set<string>
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) return [];
  if (!isWalkable(endCol, endRow, blockedTiles)) return [];

  const key = (c: number, r: number) => `${c},${r}`;
  const visited = new Set<string>([key(startCol, startRow)]);
  const parent = new Map<string, string>();
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];
  const endKey = key(endCol, endRow);
  const dirs = [
    { dc: 0, dr: -1 },
    { dc: 0, dr: 1 },
    { dc: -1, dr: 0 },
    { dc: 1, dr: 0 },
  ];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currKey = key(curr.col, curr.row);

    if (currKey === endKey) {
      const path: Array<{ col: number; row: number }> = [];
      let k = endKey;
      while (k !== key(startCol, startRow)) {
        const [c, r] = k.split(',').map(Number);
        path.unshift({ col: c, row: r });
        k = parent.get(k)!;
      }
      return path;
    }

    for (const { dc, dr } of dirs) {
      const nc = curr.col + dc;
      const nr = curr.row + dr;
      const nk = key(nc, nr);
      if (!visited.has(nk) && isWalkable(nc, nr, blockedTiles)) {
        visited.add(nk);
        parent.set(nk, currKey);
        queue.push({ col: nc, row: nr });
      }
    }
  }
  return [];
}
