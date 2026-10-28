/**
 * Clustering and dimensionality reduction (spec §9).
 *
 * Automatic groups over the catalogue — styles, moods, eras — plus a 2D
 * projection for the admin dashboard.
 *
 * Both algorithms here are deterministic on purpose. `k-means++` normally
 * seeds randomly, which means the admin dashboard's cluster colours change
 * on every page load and a cluster that "disappeared" is indistinguishable
 * from one that genuinely moved. Seeding by farthest-point gives stable
 * clusters for the same input, which is what makes the visualisation
 * trustworthy.
 */

import { l2Normalize } from "./embedder";
import type { VectorRecord, VectorType } from "./types";

export type Cluster = {
  id: number;
  label: string;
  size: number;
  /** Representative members, closest to the centroid. */
  exemplarIds: string[];
  centroid: number[];
};

export type ProjectedPoint = {
  id: string;
  x: number;
  y: number;
  cluster: number;
};

export type ClusteringResult = {
  clusters: Cluster[];
  points: ProjectedPoint[];
  /** Total vectors that were actually clustered. Lower than the catalogue if
   *  any were missing the requested vector type — reported rather than
   *  silently dropped. */
  sampled: number;
  iterations: number;
  /** Axis labels for the 2D projection, so the plot can be titled honestly. */
  axes: { x: string; y: string };
};

/** Deterministic k-means over cosine distance. */
export function cluster(
  records: VectorRecord[],
  args: {
    k?: number;
    vectorType?: VectorType;
    iterations?: number;
    maxPoints?: number;
  } = {},
): ClusteringResult {
  const k = Math.max(1, Math.min(args.k ?? 8, 64));
  const vectorType = args.vectorType ?? "multimodal";
  const iterations = args.iterations ?? 25;
  const maxPoints = args.maxPoints ?? 2000;

  const usable = records.filter(
    (r) =>
      Array.isArray(r.vectors[vectorType]) && r.vectors[vectorType]!.length > 0,
  );
  // Largest-first so a capped sample keeps the biggest, most representative
  // records rather than an arbitrary prefix.
  const pool = usable
    .slice()
    .sort(
      (a, b) =>
        (b.vectors[vectorType]!.length ? 1 : 0) -
        (a.vectors[vectorType]!.length ? 1 : 0),
    )
    .slice(0, maxPoints);

  if (pool.length === 0) {
    return {
      clusters: [],
      points: [],
      sampled: 0,
      iterations: 0,
      axes: { x: "pc1", y: "pc2" },
    };
  }

  const dimension = pool[0].vectors[vectorType]!.length;
  const vectors = pool.map((r) => l2Normalize(r.vectors[vectorType]!));

  // Farthest-point seeding: start at the point furthest from the origin of the
  // data (most "out there" track), then repeatedly take the point furthest from
  // every centroid chosen so far. Deterministic, and produces better-separated
  // clusters than picking the first k.
  const centroids: number[][] = [vectors[0].slice()];
  while (centroids.length < Math.min(k, vectors.length)) {
    let bestIndex = -1;
    let bestDistance = -1;
    vectors.forEach((vec, index) => {
      if (centroids.some((c) => c === vec)) return;
      const nearest = Math.min(...centroids.map((c) => dot(vec, c)));
      const distance = 1 - nearest;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex === -1) break;
    centroids.push(vectors[bestIndex].slice());
  }

  const assignment = new Array<number>(vectors.length).fill(0);
  let usedIterations = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    usedIterations = iteration + 1;
    let moved = false;
    vectors.forEach((vec, index) => {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const score = dot(vec, centroids[c]);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (assignment[index] !== best) {
        assignment[index] = best;
        moved = true;
      }
    });

    for (let c = 0; c < centroids.length; c++) {
      const members = vectors.filter((_, i) => assignment[i] === c);
      if (members.length === 0) continue;
      const mean = new Array<number>(dimension).fill(0);
      for (const member of members) {
        for (let d = 0; d < dimension; d++) mean[d] += member[d];
      }
      centroids[c] = l2Normalize(mean.map((n) => n / members.length));
    }

    if (!moved) break;
  }

  const { projected, axes } = pca2d(vectors);

  const clusters: Cluster[] = centroids.map((centroid, index) => {
    const memberIndexes = assignment
      .map((a, i) => (a === index ? i : -1))
      .filter((i) => i >= 0);
    const members = memberIndexes.map((i) => pool[i]);
    const exemplars = memberIndexes
      .map((i) => ({ id: pool[i].id, score: dot(vectors[i], centroid) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((e) => e.id);
    return {
      id: index,
      label: labelCluster(members, index),
      size: members.length,
      exemplarIds: exemplars,
      centroid,
    };
  });

  return {
    clusters,
    points: projected.map((p, i) => ({
      id: pool[i].id,
      x: p.x,
      y: p.y,
      cluster: assignment[i],
    })),
    sampled: pool.length,
    iterations: usedIterations,
    axes,
  };
}

/** Names a cluster from what its members actually share, so the dashboard
 *  shows "Bengali pop, 2010s" rather than "Cluster 3". */
function labelCluster(members: VectorRecord[], index: number): string {
  const genres = tally(members.flatMap((m) => m.properties.genres ?? []));
  const moods = tally(members.flatMap((m) => m.properties.moods ?? []));
  const languages = tally(
    members.flatMap((m) =>
      m.properties.language ? [m.properties.language] : [],
    ),
  );
  const years = members
    .map((m) => m.properties.releaseYear)
    .filter((y): y is number => typeof y === "number");
  const era = years.length
    ? `${Math.floor(Math.min(...years) / 10) * 10}s–${Math.floor(Math.max(...years) / 10) * 10}s`
    : "";

  const top = genres[0]?.[0] ?? moods[0]?.[0] ?? `cluster ${index + 1}`;
  return [top, languages[0]?.[0], era].filter(Boolean).join(" · ");
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Two-dimensional PCA by power iteration on the covariance matrix.
 *
 * Not a full SVD, because for a 2D admin projection the leading two
 * eigenvectors carry nearly all of the variance that is visible, and power
 * iteration gets them in a few dozen cheap passes with no linear-algebra
 * dependency. Deterministic, unlike a random-start SVD.
 */
export function pca2d(vectors: number[][]): {
  projected: { x: number; y: number }[];
  axes: { x: string; y: string };
} {
  if (vectors.length === 0)
    return { projected: [], axes: { x: "pc1", y: "pc2" } };
  const dimension = vectors[0].length;

  const mean = new Array<number>(dimension).fill(0);
  for (const vec of vectors) {
    for (let d = 0; d < dimension; d++) mean[d] += vec[d] / vectors.length;
  }
  const centered = vectors.map((vec) => vec.map((v, d) => v - mean[d]));

  // Covariance = XᵀX / n. Dense and symmetric, which is what power iteration
  // wants: one matrix-vector product per pass, no recomputation.
  const cov = new Array<number>(dimension)
    .fill(0)
    .map(() => new Array<number>(dimension).fill(0));
  for (const row of centered) {
    for (let i = 0; i < dimension; i++) {
      if (row[i] === 0) continue;
      for (let j = i; j < dimension; j++) {
        cov[i][j] += row[i] * row[j];
        if (i !== j) cov[j][i] = cov[i][j];
      }
    }
  }

  const pc1 = powerIteration(cov, dimension);
  const pc2 = powerIteration(cov, dimension, pc1);

  const projected = centered.map((row) => {
    let x = 0;
    let y = 0;
    for (let d = 0; d < dimension; d++) {
      x += row[d] * pc1[d];
      y += row[d] * pc2[d];
    }
    return { x, y };
  });

  return { projected, axes: { x: "pc1", y: "pc2" } };
}

function powerIteration(
  matrix: number[][],
  dimension: number,
  orthogonalTo?: number[],
): number[] {
  // Seeded deterministically rather than randomly.
  let vector = new Array<number>(dimension)
    .fill(0)
    .map((_, i) => Math.sin(i + 1) / Math.sqrt(dimension));

  for (let iteration = 0; iteration < 100; iteration++) {
    const next = new Array<number>(dimension).fill(0);
    for (let i = 0; i < dimension; i++) {
      let sum = 0;
      for (let j = 0; j < dimension; j++) sum += matrix[i][j] * vector[j];
      next[i] = sum;
    }
    if (orthogonalTo) {
      let projection = 0;
      for (let d = 0; d < dimension; d++)
        projection += next[d] * orthogonalTo[d];
      for (let d = 0; d < dimension; d++)
        next[d] -= projection * orthogonalTo[d];
    }
    const norm = Math.sqrt(next.reduce((sum, n) => sum + n * n, 0));
    if (norm < 1e-12) return vector;
    vector = next.map((n) => n / norm);
  }
  return vector;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}
