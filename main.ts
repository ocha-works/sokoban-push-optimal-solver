// Sokoban push-optimal solver (built for make.fun's sokoban-solver-01-run-20261121).
//
// Idea: the levels this competition draws are a hallway with one to four small
// rooms off it, and a box can never leave its room (a push through a door into
// the hallway cannot be undone). So a level's push optimum is the sum of its
// rooms' optima, and each room is solved on its own with a push-optimal A*
// search, then the per-room move strings are joined with the walks between
// rooms. Every step of the search is bounded by work (state counts), never by
// the wall clock, so two runs write identical bytes.
//
// Search details, per room (or per whole level as a fallback):
//   - a state is the sorted box squares plus the player's reachable region
//     (named by its lowest square); the cost is pushes made.
//   - A* with the heuristic "sum over boxes of the shortest walk distance to
//     the nearest goal" (distances ignore boxes). Each push moves one box one
//     square, so the heuristic drops by at most one per push: it is
//     consistent, and the first goal state popped is push-optimal.
//   - two sound prunings: a box on a dead square (no push chain, other boxes
//     ignored, can ever bring it to a goal) is discarded, and a box pushed
//     into a frozen 2x2 block of walls and boxes holding a box off its goal
//     is discarded. Neither prunes a solvable state, so optimality stands.
//
// Node 22, standard library only, erasable TypeScript.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search may generate before it gives up (work, not time). */
const MAX_STATES_PER_ROOM = 1_000_000;
/** The most states the whole-level fallback may generate. */
const MAX_STATES_WHOLE = 2_000_000;

interface Dir { dx: number; dy: number; ch: string }
const DIRS: Dir[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text. Short rows and the outer frame count as wall. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Dead-square test, by pulling boxes back from the goals: a square is live
 * when a box standing on it can be pushed, ignoring the other boxes, onto
 * some goal. A box on a non-live square can never be solved, so such states
 * are pruned. This is an over-approximation (it ignores whether the player
 * can reach the pushing square), so it never prunes a solvable state.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of DIRS) {
      const step = d.dy * w + d.dx;
      const y = x - step; // a box here could be pushed onto x
      if (wall[y] || wall[y - step] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/** Walk distance from every square to its nearest goal, over open floor, boxes ignored. */
function goalDistances(level: Level): Int32Array {
  const { w, wall, goals } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = goals.slice();
  for (const g of goals) dist[g] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] || dist[q] >= 0) continue;
      dist[q] = dist[p] + 1;
      queue.push(q);
    }
  }
  return dist;
}

/**
 * Flood-fill the player's reachable region from `from` around walls and the
 * squares in `occupied`; returns the region's lowest square. `seen`/`stack`
 * are scratch, stamped so no clearing pass is needed.
 */
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` is stuck in a frozen 2x2 block: four
 * squares of walls and boxes, one of them a box off its goal. Such a block
 * can never be undone, so the state is pruned.
 */
function isFrozenBlock(
  level: Level,
  occupied: Uint8Array,
  isGoal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !isGoal[a]) || (occupied[b] && !isGoal[b])) return true;
    if ((occupied[c] && !isGoal[c]) || (occupied[d] && !isGoal[d])) return true;
  }
  return false;
}

/** A tiny binary heap ordered by (f asc, g desc, insertion seq asc). Deterministic. */
class Heap {
  private a: number[][] = [];
  private static less(x: number[], y: number[]): boolean {
    return (
      x[0] < y[0] ||
      (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])))
    );
  }
  get size(): number {
    return this.a.length;
  }
  push(e: number[]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): number[] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.less(a[c + 1]!, a[c]!)) c++;
        if (!Heap.less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}

interface SearchResult {
  pushes: number;
  moves: string;
  states: number;
}

/**
 * Push-optimal A* for one level (a room's sub-level, or a whole level).
 * Returns the optimal move string (lower-case steps, upper-case pushes) or
 * null when the state budget runs out or the level is unsolvable.
 * `numericKey` uses a base-`size` number key (fast, exact while the board
 * holds few boxes); otherwise a string key is used.
 */
function solvePushOptimal(
  level: Level,
  maxStates: number,
  numericKey: boolean,
): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const nBoxes = level.boxes.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const startBoxes = level.boxes.slice();
  if (startBoxes.some((b) => !live[b])) return null;

  const keyOf = (boxes: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return `${low}|${boxes.join(',')}`;
  };

  // Per-state storage: boxes, the player's square after the push that made
  // the state, the parent state, the push (box-from square, direction), and
  // the state's key (region low + boxes) as computed when it was made.
  const stateBoxes: number[][] = [startBoxes];
  const statePlayer: number[] = [level.player];
  const stateKey: (number | string)[] = [];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const stateG: number[] = [0];

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const heuristic = (boxes: number[]): number => {
    let h = 0;
    for (const b of boxes) h += dist[b];
    return h;
  };

  const best = new Map<number | string, number>();
  const heap = new Heap();
  let seq = 0;
  for (const b of startBoxes) occupied[b] = 1;
  const startLow = reachLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  const startKey = keyOf(startBoxes, startLow);
  stateKey.push(startKey);
  best.set(startKey, 0);
  heap.push([heuristic(startBoxes), 0, seq++, 0]);

  const solved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b]);
  let found = solved(startBoxes) ? 0 : -1;

  while (heap.size > 0 && found < 0) {
    const [, g, , s] = heap.pop();
    const boxes = stateBoxes[s]!;
    // Skip entries superseded by a better path to the same state.
    if (best.get(stateKey[s]!) !== s || stateG[s] !== g) continue;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(level, occupied, statePlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < DIRS.length; di++) {
        const d = DIRS[di]!;
        const step = d.dy * w + d.dx;
        const t = b + step;
        // The player must be able to stand behind the box to push it.
        if (seen[b - step] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (isFrozenBlock(level, occupied, isGoal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        // The child's region is flood-filled into `mark`, never `seen`: the
        // expanded state's region marks must survive the whole expansion.
        const low = reachLow(level, occupied, b, mark, ++stamp, stack);
        const k = keyOf(next, low);
        const prev = best.get(k);
        if (prev === undefined || stateG[prev]! > g + 1) {
          if (stateBoxes.length >= maxStates) {
            for (const x of boxes) occupied[x] = 0;
            return null;
          }
          const ns = stateBoxes.length;
          stateBoxes.push(next);
          statePlayer.push(b);
          stateKey.push(k);
          parent.push(s);
          pushFrom.push(b);
          pushDir.push(di);
          stateG.push(g + 1);
          best.set(k, ns);
          heap.push([g + 1 + heuristic(next), g + 1, seq++, ns]);
          if (solved(next)) {
            found = ns;
            break;
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The search leaves one stale mark in `occupied` (the last push's landing
  // square, left set when the goal was found and the expansion broke out);
  // clear it before rebuilding the walks, or it could block a walk's only
  // entrance.
  occupied.fill(0);

  // Rebuild the move string: for each push on the path, walk to the pushing
  // square (boxes as obstacles), then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = stateBoxes[s]!;
    const from = pushFrom[s]!;
    const di = pushDir[s]!;
    const d = DIRS[di]!;
    const step = d.dy * w + d.dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - step);
    for (const b of boxes) occupied[b] = 0;
    moves += d.ch.toUpperCase();
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, states: stateBoxes.length };
}

/** Shortest walk from `from` to `to` around walls and boxes, lower-case LURD. */
function walkTo(
  level: Level,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const d of DIRS) {
      const q = p + d.dy * w + d.dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: pushing square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * Split a level into rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal), and each remaining floor component
 * holding boxes is a room. Null when the level is not such a set of rooms
 * (a box in the hallway, a goal outside any room, or a room whose boxes and
 * goals do not match).
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of DIRS) {
        const q = squares[i]! + d.dy * w + d.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve a level room by room: each room is solved push-optimally with the
 * other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. Falls back
 * to a whole-level search when the level is no set of rooms.
 */
function solveLevel(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) {
    return solvePushOptimal(level, MAX_STATES_WHOLE, false);
  }
  let player = level.player;
  let pushes = 0;
  let moves = '';
  let states = 0;
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, MAX_STATES_PER_ROOM, true);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    states += solved.states;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves, states };
}

/** Solve one level's text; '' when it cannot be solved within budget. */
function solve(text: string): string {
  try {
    const level = parseLevel(text);
    const solved = solveLevel(level);
    return solved === null ? '' : solved.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
