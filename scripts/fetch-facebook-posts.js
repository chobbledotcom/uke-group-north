#!/usr/bin/env bun

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, fs, loadEnv, path, readJson, write } from "./utils.js";

await loadEnv();

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const forceAll = process.argv.includes("--all");
const apifyToken = process.env.APIFY_API_TOKEN;

const CONFIG = {
  postsDir: path("facebook-posts"),
  imagesDir: path("images", "facebook-posts"),
  siteConfig: path("_data", "site.json"),
  actorId: "KoJrdxJCTtpon81KY",
  resultsLimit: limitArg ? Number(limitArg.split("=")[1]) : 100,
};

const isMsTimestamp = (n) => n > 1e12;

const normalizeDate = (date) => {
  if (typeof date === "number") {
    return new Date(isMsTimestamp(date) ? date : date * 1000).toISOString();
  }
  return new Date(date).toISOString();
};

const formatSlug = (iso, id) => {
  const safeDate = iso.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const safeId = String(id)
    .replace(/[^a-z0-9]/gi, "-")
    .slice(0, 20);
  return `${safeDate}-${safeId}`;
};

const getMediaImageUrl = (mediaItem) =>
  mediaItem?.image?.uri ||
  mediaItem?.photo_image?.uri ||
  mediaItem?.thumbnail ||
  null;

const getImageUrls = (p) => [
  ...new Set(
    [
      p.fullPicture,
      p.image,
      p.displayUrl,
      ...(p.media?.map(getMediaImageUrl) || []),
    ].filter((url) => typeof url === "string" && url),
  ),
];

const readExistingDates = (dir) => {
  if (!exists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return readJsonSync(join(dir, f));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((p) => p.date)
    .filter(Boolean);
};

const readJsonSync = (p) => JSON.parse(Bun.file(p).textSync());

const toMs = (date) => {
  if (typeof date === "number") {
    return isMsTimestamp(date) ? date : date * 1000;
  }
  const ms = new Date(date).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

const findLastScrapeDate = (dir) => {
  const dates = readExistingDates(dir).map(toMs);
  return dates.length ? Math.max(...dates) : null;
};

const fetchPosts = async (profileUrl) => {
  if (!profileUrl) throw new Error("Facebook URL missing from site.json");
  const url = `https://api.apify.com/v2/acts/${CONFIG.actorId}/run-sync-get-dataset-items?token=${apifyToken}`;
  console.log(`Fetching Facebook posts for ${profileUrl}...`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startUrls: [{ url: profileUrl }],
      resultsLimit: CONFIG.resultsLimit,
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const results = await res.json();
  if (!Array.isArray(results)) throw new Error("Invalid API response format");

  return results
    .filter(
      (p) =>
        !p.sharedPost &&
        (p.topLevelUrl || p.url) &&
        (p.createdTime || p.timestamp),
    )
    .map((p) => ({
      id: p.postId || p.id || p.url,
      date: normalizeDate(p.createdTime || p.timestamp),
      name: p.message || p.text || p.caption || "",
      url: p.topLevelUrl || p.url,
      imageUrls: getImageUrls(p),
    }));
};

const downloadImage = async (imageUrl, filepath) => {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image HTTP ${res.status} for ${imageUrl}`);
  await write(filepath, await res.arrayBuffer());
};

const getImageFilename = (slug, index, imageUrl) => {
  const ext = imageUrl.includes(".png") ? "png" : "jpg";
  const suffix = index === 0 ? "" : `-${index + 1}`;
  return `${slug}${suffix}.${ext}`;
};

const downloadPostImage = async (slug, index, imageUrl, existingThumbnail) => {
  if (index === 0 && existingThumbnail) return existingThumbnail;

  const filename = getImageFilename(slug, index, imageUrl);
  const imagePath = join(CONFIG.imagesDir, filename);
  const publicPath = `/images/facebook-posts/${filename}`;
  if (await exists(imagePath)) return publicPath;

  try {
    await downloadImage(imageUrl, imagePath);
    return publicPath;
  } catch (err) {
    console.warn(
      `  Could not download image ${index + 1} for ${slug}: ${err.message}`,
    );
    return null;
  }
};

const downloadPostImages = async (post, slug, existingThumbnail) =>
  (
    await Promise.all(
      post.imageUrls.map((imageUrl, index) =>
        downloadPostImage(slug, index, imageUrl, existingThumbnail),
      ),
    )
  ).filter(Boolean);

const isNewerThan = (cutoffMs) => (post) =>
  !cutoffMs || new Date(post.date).getTime() > cutoffMs;

const savePost = async (post) => {
  const slug = formatSlug(post.date, post.id);
  const jsonPath = join(CONFIG.postsDir, `${slug}.json`);
  const existingRecord = (await exists(jsonPath))
    ? await readJson(jsonPath)
    : null;

  const existingImages =
    existingRecord?.images ||
    (existingRecord?.thumbnail ? [existingRecord.thumbnail] : []);
  const downloadedImages = await downloadPostImages(
    post,
    slug,
    existingRecord?.thumbnail,
  );
  const images = post.imageUrls.length ? downloadedImages : existingImages;
  const thumbnail = images[0] || existingRecord?.thumbnail || null;

  const record = {
    thumbnail,
    ...(images.length ? { images } : {}),
    title: post.name,
    date: post.date,
    url: post.url,
  };

  if (
    existingRecord &&
    JSON.stringify(record) === JSON.stringify(existingRecord)
  ) {
    return false;
  }

  await write(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${slug}.json`);
  return true;
};

const main = async () => {
  if (!apifyToken) {
    console.error("Error: APIFY_API_TOKEN required in .env file");
    console.error("Get token: https://console.apify.com/account/integrations");
    process.exit(1);
  }

  if (!(await exists(CONFIG.siteConfig))) {
    console.error(`Error: ${CONFIG.siteConfig} not found`);
    process.exit(1);
  }

  const siteConfig = await readJson(CONFIG.siteConfig);
  const profileUrl =
    siteConfig.socials?.Facebook || siteConfig.facebook_page_url;
  if (!profileUrl) {
    console.error("Error: Facebook URL missing from site.json");
    process.exit(1);
  }

  fs.mkdir(CONFIG.postsDir);
  fs.mkdir(CONFIG.imagesDir);

  const cutoffMs = forceAll ? null : findLastScrapeDate(CONFIG.postsDir);
  if (cutoffMs) {
    console.log(`Last scrape: ${new Date(cutoffMs).toISOString()}`);
  } else {
    console.log("No previous scrape found, fetching all available posts");
  }

  const posts = await fetchPosts(profileUrl);
  console.log(`Found ${posts.length} posts from Apify`);

  const selectedPosts = posts.filter(isNewerThan(cutoffMs));
  console.log(`${selectedPosts.length} posts selected`);

  const saved = (await Promise.all(selectedPosts.map(savePost))).filter(
    Boolean,
  ).length;

  console.log(
    `\nSaved or repaired ${saved} posts (${selectedPosts.length - saved} unchanged)`,
  );
};

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
