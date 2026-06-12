#!/usr/bin/env bun

import { join } from "node:path";
import { exists, fs, loadEnv, path, readJson, write } from "./utils.js";

await loadEnv();

const CONFIG = {
  siteConfig: path("_data", "site.json"),
  postsDir: path("instagram-posts"),
  imagesDir: path("images", "instagram-posts"),
  actorId: "shu8hvrXbJbY3Eb9W",
  resultsLimit: 100,
};

const formatTimestamp = (iso) =>
  iso.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");

const extractUsername = (instagramUrl) => {
  const match = instagramUrl.match(/instagram\.com\/([^/?#]+)/);
  return match ? match[1] : null;
};

const fetchPosts = async (profileUrl) => {
  const url = `https://api.apify.com/v2/acts/${CONFIG.actorId}/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`;

  console.log(`Fetching posts for ${profileUrl}...`);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      directUrls: [profileUrl],
      resultsType: "posts",
      resultsLimit: CONFIG.resultsLimit,
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const results = await res.json();
  if (!Array.isArray(results)) throw new Error("Invalid API response format");

  return results
    .filter((p) => p.timestamp && p.displayUrl && p.url)
    .map((p) => ({
      date: p.timestamp,
      title: p.caption || "",
      url: p.url,
      thumbnail: p.displayUrl,
    }));
};

const downloadImage = async (imageUrl, filepath) => {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image HTTP ${res.status} for ${imageUrl}`);
  await write(filepath, await res.arrayBuffer());
};

const savePost = async (post) => {
  const slug = formatTimestamp(post.date);
  const jsonPath = join(CONFIG.postsDir, `${slug}.json`);
  const imagePath = join(CONFIG.imagesDir, `${slug}.jpg`);

  if (await exists(jsonPath)) return false;

  await downloadImage(post.thumbnail, imagePath);

  const record = {
    thumbnail: `/images/instagram-posts/${slug}.jpg`,
    title: post.title,
    date: post.date,
    url: post.url,
  };

  await write(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${slug}.json`);
  return true;
};

const main = async () => {
  if (!process.env.APIFY_API_TOKEN) {
    console.error("Error: APIFY_API_TOKEN required in .env file");
    console.error("Get token: https://console.apify.com/account/integrations");
    process.exit(1);
  }

  if (!(await exists(CONFIG.siteConfig))) {
    console.error(`Error: ${CONFIG.siteConfig} not found`);
    process.exit(1);
  }

  const siteConfig = await readJson(CONFIG.siteConfig);
  const instagramUrl = siteConfig.socials?.Instagram;
  if (!instagramUrl || !extractUsername(instagramUrl)) {
    console.error("Error: socials.Instagram missing or invalid in site.json");
    process.exit(1);
  }

  fs.mkdir(CONFIG.postsDir);
  fs.mkdir(CONFIG.imagesDir);

  const posts = await fetchPosts(instagramUrl);
  console.log(`Found ${posts.length} posts`);

  const saved = (await Promise.all(posts.map(savePost))).filter(Boolean).length;

  console.log(
    `\nSaved ${saved} new posts (${posts.length - saved} already existed)`,
  );
};

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
