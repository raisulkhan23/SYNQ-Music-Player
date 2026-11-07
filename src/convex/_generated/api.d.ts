/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as amplitude from "../amplitude.js";
import type * as analytics from "../analytics.js";
import type * as appleMusic from "../appleMusic.js";
import type * as artistCatalog from "../artistCatalog.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as convexVectorStore from "../convexVectorStore.js";
import type * as crons from "../crons.js";
import type * as downloads from "../downloads.js";
import type * as gravity from "../gravity.js";
import type * as history from "../history.js";
import type * as http from "../http.js";
import type * as jamendo from "../jamendo.js";
import type * as libraryVectors from "../libraryVectors.js";
import type * as likes from "../likes.js";
import type * as lyrics from "../lyrics.js";
import type * as lyricsProviders from "../lyricsProviders.js";
import type * as me from "../me.js";
import type * as musicVectorDb from "../musicVectorDb.js";
import type * as notInterested from "../notInterested.js";
import type * as playlists from "../playlists.js";
import type * as providerCache from "../providerCache.js";
import type * as recommend from "../recommend.js";
import type * as recommendVectors from "../recommendVectors.js";
import type * as sharing from "../sharing.js";
import type * as smartPlaylists from "../smartPlaylists.js";
import type * as social from "../social.js";
import type * as soundcloud from "../soundcloud.js";
import type * as spotify from "../spotify.js";
import type * as tidal from "../tidal.js";
import type * as userPreferences from "../userPreferences.js";
import type * as users from "../users.js";
import type * as wordLyrics from "../wordLyrics.js";
import type * as youtube from "../youtube.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  amplitude: typeof amplitude;
  analytics: typeof analytics;
  appleMusic: typeof appleMusic;
  artistCatalog: typeof artistCatalog;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  convexVectorStore: typeof convexVectorStore;
  crons: typeof crons;
  downloads: typeof downloads;
  gravity: typeof gravity;
  history: typeof history;
  http: typeof http;
  jamendo: typeof jamendo;
  libraryVectors: typeof libraryVectors;
  likes: typeof likes;
  lyrics: typeof lyrics;
  lyricsProviders: typeof lyricsProviders;
  me: typeof me;
  musicVectorDb: typeof musicVectorDb;
  notInterested: typeof notInterested;
  playlists: typeof playlists;
  providerCache: typeof providerCache;
  recommend: typeof recommend;
  recommendVectors: typeof recommendVectors;
  sharing: typeof sharing;
  smartPlaylists: typeof smartPlaylists;
  social: typeof social;
  soundcloud: typeof soundcloud;
  spotify: typeof spotify;
  tidal: typeof tidal;
  userPreferences: typeof userPreferences;
  users: typeof users;
  wordLyrics: typeof wordLyrics;
  youtube: typeof youtube;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
