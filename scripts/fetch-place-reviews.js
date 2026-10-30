#!/usr/bin/env bun
// Fetch Google reviews for an arbitrary place (a venue we work at, say) via
// the Apify Google Maps Scraper (compass/crawler-google-places - the same
// actor the google-reviews-iframe repo uses for our own reviews) and save
// them as one JSON blob.
//
// The blob lives at venue-reviews/<slug>.json by default and feeds venue page
// work: reviews are a rich source of practical detail about a venue (parking,
// access, noise, what the spaces are actually like, recurring complaints).
//
// Usage:
//   bun run fetch-place-reviews "Goodwood Racecourse PO18 0PS"
//   bun run fetch-place-reviews "Goodwood Racecourse PO18 0PS" --expect Goodwood --slug goodwood-racecourse
//   bun run fetch-place-reviews --place-id ChIJ...
//   bun run fetch-place-reviews --url "https://www.google.com/maps/place/..."
//   bun run fetch-place-reviews "venue name postcode" --all   # full re-scrape
//
// Location resolution, in order: --url > --place-id > the positional location
// string (a Google Maps search string; the best-matching place is used).
// --expect guards against the search landing on a same-named place in the
// wrong town: when set and the matched place's title does not contain it, the
// script fails without writing anything.
//
// Re-fetches are incremental: when the output file already exists, only
// reviews newer than the newest saved review are fetched (the actor's
// reviewsStartDate input) and merged into the blob, so a refresh costs a few
// pence instead of a full re-scrape. --all forces a full re-scrape.
//
// Requires APIFY_API_TOKEN in the environment (or .env).

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fs, path } from "./utils.js";

const ACTOR_ID = "nwua9Gu5YrADL7ZDj"; // compass/crawler-google-places
const API_BASE = "https://api.apify.com/v2";
const SCHEMA = "monster-place-reviews/1";
const POLL_SECS = 5;
const OUTPUT_DIR = "venue-reviews";
const DATASET_PAGE = 500;
const TERMINAL_RUN_STATES = new Set([
  "SUCCEEDED",
  "FAILED",
  "ABORTED",
  "TIMED-OUT",
]);

const die = (message, code = 1) => {
  console.error(`ERROR: ${message}`);
  process.exit(code);
};

const apify = async (token, method, apiPath, { params = {}, json } = {}) => {
  const search = new URLSearchParams({ ...params, token });
  const response = await fetch(`${API_BASE}${apiPath}?${search}`, {
    method,
    headers: json ? { "content-type": "application/json" } : undefined,
    body: json ? JSON.stringify(json) : undefined,
  });
  if (!response.ok) {
    const detail = await response
      .json()
      .then((data) => data?.error?.message ?? "")
      .catch(() => "");
    die(
      `Apify API ${method} ${apiPath} failed: HTTP ${response.status}${detail ? ` - ${detail}` : ""}`,
    );
  }
  const body = await response.json();
  // Run and dataset endpoints wrap their payload in {"data": ...}; dataset
  // item listings come back as a bare array.
  return Array.isArray(body) ? body : (body.data ?? body);
};

const runActor = async (token, actorInput, timeoutSecs) => {
  // The run-sync endpoints cut the HTTP connection at 300s, which is too
  // tight for a venue with hundreds of reviews, so start the run and poll it.
  let run = await apify(token, "POST", `/acts/${ACTOR_ID}/runs`, {
    json: actorInput,
  });
  console.log(`Apify run ${run.id} started (${run.status})`);
  const started = Date.now();
  let last = null;
  while (!TERMINAL_RUN_STATES.has(run.status)) {
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed > timeoutSecs) {
      console.error(
        `Run ${run.id} still ${run.status} after ${timeoutSecs}s - giving up (the run continues on Apify: https://console.apify.com/actors/runs/${run.id})`,
      );
      process.exit(1);
    }
    await Bun.sleep(POLL_SECS * 1000);
    run = await apify(token, "GET", `/actor-runs/${run.id}`);
    if (run.status !== last) {
      console.log(
        `  ${run.status} (${Math.round((Date.now() - started) / 1000)}s)`,
      );
      last = run.status;
    }
  }
  if (run.status !== "SUCCEEDED")
    die(`Apify run ${run.id} finished ${run.status}`);
  return run;
};

const fetchDataset = async (token, datasetId) => {
  const items = [];
  let offset = 0;
  while (true) {
    const page = await apify(token, "GET", `/datasets/${datasetId}/items`, {
      params: {
        clean: "true",
        offset: String(offset),
        limit: String(DATASET_PAGE),
      },
    });
    for (const item of page) items.push(item);
    if (page.length < DATASET_PAGE) return items;
    offset += page.length;
  }
};

const normaliseReview = (raw) => {
  let published = (raw.publishedAtDate ?? "").trim();
  if (published.endsWith("Z")) published = `${published.slice(0, -1)}+00:00`;
  const parsed = Date.parse(published);
  const publishedAt = Number.isNaN(parsed)
    ? ""
    : `${new Date(parsed).toISOString().slice(0, 19)}Z`;
  const text = (raw.text ?? "").trim();
  const translated = (raw.textTranslated ?? "").trim();
  const review = {
    review_id: raw.reviewId ?? "",
    author: raw.name || "Anonymous",
    rating: raw.stars ?? raw.rating ?? 0,
    text,
    published_at: publishedAt,
    published_relative: raw.publishAt ?? "",
    owner_response: (raw.responseFromOwnerText ?? "").trim(),
    owner_response_date: raw.responseFromOwnerDate ?? "",
    review_origin: raw.reviewOrigin ?? "",
    review_url: raw.reviewUrl ?? "",
    visited_in: raw.visitedIn ?? "",
    image_count: (raw.reviewImageUrls ?? []).length,
    local_guide: Boolean(raw.isLocalGuide),
    likes: raw.likesCount ?? 0,
  };
  if (translated && translated !== text) review.text_translated = translated;
  return review;
};

const dedupeKey = (review) =>
  review.review_id ||
  `${review.author}|${review.published_at}|${review.text.slice(0, 200)}`;

// Old + new, new copies winning on review_id collisions (fresh owner
// responses, like counts), sorted newest first.
const mergeReviews = (oldReviews, newReviews) => {
  const merged = new Map();
  for (const review of [...oldReviews, ...newReviews]) {
    merged.set(dedupeKey(review), review);
  }
  return [...merged.values()]
    .filter((review) => review.published_at)
    .sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
};

const normalisePlace = (raw) => ({
  place_id: raw.placeId ?? "",
  cid: raw.cid ?? "",
  title: raw.title ?? "",
  address: raw.address ?? "",
  city: raw.city ?? "",
  postal_code: raw.postalCode ?? "",
  location: raw.location ?? {},
  website: raw.website ?? "",
  phone: raw.phone ?? "",
  categories: raw.categories ?? [],
  total_score: raw.totalScore ?? null,
  reviews_count: raw.reviewsCount ?? 0,
  opening_hours: raw.openingHours ?? [],
  permanently_closed: Boolean(raw.permanentlyClosed),
});

const slugify = (text) => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "place";
};

const buildActorInput = (options, startDate) => {
  const actorInput = {
    maxReviews: options.maxReviews,
    reviewsSort: options.sort,
    language: options.lang,
    scrapeReviewsPersonalData: true,
    proxyConfig: { useApifyProxy: true },
  };
  if (options.url) {
    actorInput.startUrls = [{ url: options.url }];
  } else if (options.placeId) {
    actorInput.placeIds = [options.placeId];
  } else {
    actorInput.searchStringsArray = [options.location];
    actorInput.maxCrawledPlacesPerSearch = 1;
  }
  const start = options.since || startDate;
  if (start) actorInput.reviewsStartDate = start;
  return actorInput;
};

const VALUE_FLAGS = new Map([
  ["--url", "url"],
  ["--place-id", "placeId"],
  ["--expect", "expect"],
  ["--slug", "slug"],
  ["-o", "output"],
  ["--output", "output"],
  ["--max-reviews", "maxReviews"],
  ["--sort", "sort"],
  ["--lang", "lang"],
  ["--since", "since"],
  ["--timeout", "timeout"],
]);
const NUMBER_FLAGS = new Set(["--max-reviews", "--timeout"]);
const BOOLEAN_FLAGS = new Map([["--all", "all"]]);

const parseArgs = (argv) => {
  const options = {
    url: null,
    placeId: null,
    expect: null,
    slug: null,
    output: null,
    maxReviews: 9999,
    sort: "newest",
    lang: "en",
    since: null,
    all: false,
    timeout: 1800,
    location: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) die(`${arg} needs a value`, 2);
      options[VALUE_FLAGS.get(arg)] = NUMBER_FLAGS.has(arg)
        ? Number(value)
        : value;
      index++;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      options[BOOLEAN_FLAGS.get(arg)] = true;
    } else if (arg.startsWith("-")) {
      die(`unknown flag: ${arg}`, 2);
    } else if (options.location === null) {
      options.location = arg;
    } else {
      die(`unexpected extra argument: ${arg}`, 2);
    }
  }
  return options;
};

const resolveOutputPath = (options) =>
  options.output ??
  path(
    OUTPUT_DIR,
    `${options.slug ?? slugify(options.location ?? "place")}.json`,
  );

const loadBase = (outPath, all) => {
  if (all || !existsSync(outPath)) return { base: null, startDate: null };
  try {
    const base = JSON.parse(readFileSync(outPath, "utf8"));
    const startDate = base.newest_review_date || null;
    return startDate ? { base, startDate } : { base: null, startDate: null };
  } catch (error) {
    console.log(
      `WARNING: saved blob unreadable (${error.message}) - re-scraping from scratch`,
    );
    return { base: null, startDate: null };
  }
};

const saveBlob = async (outPath, blob) => {
  const tmp = outPath.endsWith(".json")
    ? `${outPath.slice(0, -5)}.json.tmp`
    : `${outPath}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(blob, null, 2)}\n`);
  fs.mv(tmp, outPath);
};

const printSummary = (outPath, blob, fetchScope, fetchedCount) => {
  console.log(`\nPlace: ${blob.place.title}`);
  console.log(`  address: ${blob.place.address}`);
  console.log(
    `  rating:  ${blob.place.total_score} (${blob.place.reviews_count} reviews on Google)`,
  );
  console.log(
    `  saved:   ${blob.review_count} reviews (${fetchScope}, +${fetchedCount} fetched this run)`,
  );
  console.log(`  blob:    ${outPath}`);
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url && !options.placeId && !options.location) {
    die("give a location string, --url or --place-id", 2);
  }
  if (options.url && options.placeId) {
    die("--url and --place-id are mutually exclusive", 2);
  }
  const token = process.env.APIFY_API_TOKEN;
  if (!token) die("APIFY_API_TOKEN not set - add it to .env", 2);

  const outPath = resolveOutputPath(options);
  fs.mkdir(dirname(outPath));

  const { base, startDate } = loadBase(outPath, options.all);
  const fetchScope = base ? "incremental" : "full";

  try {
    const actorInput = buildActorInput(options, startDate);
    const run = await runActor(token, actorInput, options.timeout);
    const items = await fetchDataset(token, run.defaultDatasetId);
    const places = items.filter((item) => "reviews" in item);
    if (places.length === 0) {
      die(
        `no Google Maps place matched (${options.url ?? options.placeId ?? options.location})`,
      );
    }
    const place = places[0];
    if (places.length > 1) {
      console.log(
        `NOTE: ${places.length} places in the dataset, using the first: ${place.title}`,
      );
    }

    const title = place.title ?? "";
    if (
      options.expect &&
      !title.toLowerCase().includes(options.expect.toLowerCase())
    ) {
      die(
        `matched place '${title}' does not look like '${options.expect}' - not writing anything (check the search string, or pass --url/--place-id)`,
        2,
      );
    }

    const newReviews = (place.reviews ?? []).map(normaliseReview);
    const reviews = mergeReviews(base?.reviews ?? [], newReviews);
    const dates = reviews.map((review) => review.published_at);

    const blob = {
      schema: SCHEMA,
      query: options.location ?? "",
      expect: options.expect ?? "",
      mode: options.url ? "url" : options.placeId ? "place-id" : "search",
      fetch_scope: fetchScope,
      fetched_at: `${new Date().toISOString().slice(0, 19)}Z`,
      actor: "compass/crawler-google-places",
      place: normalisePlace(place),
      review_count: reviews.length,
      newest_review_date: dates.length
        ? dates.reduce((a, b) => (a > b ? a : b))
        : null,
      oldest_review_date: dates.length
        ? dates.reduce((a, b) => (a < b ? a : b))
        : null,
      reviews,
    };
    // Carry the original query forward on incremental runs (the re-fetch
    // command may repeat it, but never lose it).
    if (base && !blob.query) blob.query = base.query ?? "";

    await saveBlob(outPath, blob);
    printSummary(outPath, blob, fetchScope, newReviews.length);
  } catch (error) {
    die(`Apify request failed: ${error.message}`);
  }
};

if (import.meta.main) await main();
