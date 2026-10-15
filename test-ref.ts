import type { FunctionReference, FunctionReference_future } from "convex/server";
import type { FunctionReturnType } from "convex/server";

type QueryRef = FunctionReference<"query", any, any, any>;

declare function useQuery<Query extends FunctionReference<"query"> | FunctionReference_future<"query">>(
  query: Query,
): FunctionReturnType<Query> | undefined;

type T1 = FunctionReturnType<QueryRef>;
const a: T1 = 1 as any;

const api = { get: {} as QueryRef };
const playlist = useQuery(api.get);
const snap = playlist?.title;

type T2 = typeof playlist;
