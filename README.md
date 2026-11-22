# sokoban-push-optimal-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ocha-works/sokoban-push-optimal-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ocha-works/sokoban-push-optimal-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver: one program answers all 5 instances of a set in a single run. The levels this competition draws are a hallway with one to four small rooms off it, and a box pushed through a door into the hallway can never be pushed back, so every box stays in its room and a level's push optimum is the sum of its rooms' optima. `main.ts` splits each level into its rooms (cutting the dead squares of the hallway row), solves every room on its own with a push-optimal A* search — a state is the boxes plus the player's reachable region, the heuristic is the summed walk distance of each box to its nearest goal, and dead squares plus frozen 2×2 blocks are pruned — then joins the per-room move strings with the walks between rooms. The search is bounded by work (state counts), never by the wall clock, so two runs write byte-identical answers.

Local verification on the kit's practice set: **1,000,000 points** — every instance solved in exactly P* pushes (i001: 13, i002: 16, i003: 29, i004: 47, i005: 60), in about 1 second for the whole set. Three further sets drawn from the public generator with fresh seeds also scored 1,000,000 each. The house baseline (plain-astar 1.0.0) scores 200,000 on the same practice set.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no dependencies. Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`), one LURD move string per instance.

---
<sub>Entered on [make.fun](https://make.fun/?ref=yhjp53pb&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
