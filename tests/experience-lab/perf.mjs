// Phone-like performance of the lab's public pages, in the conditions of
// the independent audit: a PRODUCTION build (LAB_PUBLIC=1), Chromium,
// 390 × 844 at DPR 1, cache disabled in a fresh context, 1.6 Mbit/s down /
// 750 kbit/s up, 150 ms latency, CPU ×4, no interaction before collecting
// LCP. Several runs per page, median reported. CDP measures, not a
// Lighthouse score and not a physical phone.
//
//   LAB_URL=http://127.0.0.1:3009 CHROMIUM=… [PLAYWRIGHT=…] [RUNS=3] \
//     node tests/experience-lab/perf.mjs

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");

const APP = process.env.LAB_URL ?? "http://127.0.0.1:3009";
const RUNS = Number(process.env.RUNS ?? 3);
const PAGES = ["/labo/mila", "/labo/alma", "/labo/nail-lab"];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });

async function measure(path) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const bytes = { Script: 0, Font: 0, Image: 0, total: 0 };
  const types = new Map();
  cdp.on("Network.responseReceived", (event) =>
    types.set(event.requestId, event.type),
  );
  cdp.on("Network.loadingFinished", (event) => {
    const type = types.get(event.requestId);
    bytes.total += event.encodedDataLength;
    if (type in bytes) bytes[type] += event.encodedDataLength;
  });
  await page.addInitScript(() => {
    const w = window;
    w.__lcp = { time: 0, element: "" };
    w.__fcp = 0;
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__lcp = {
          time: entry.startTime,
          element: `${entry.element?.tagName ?? ""}${entry.url ? " (image)" : ""}`,
        };
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (entry.name === "first-contentful-paint") w.__fcp = entry.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        if (!entry.hadRecentInput) w.__cls += entry.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(`${APP}${path}`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(5000);
  const result = await page.evaluate(() => ({
    lcp: Math.round(window.__lcp.time),
    element: window.__lcp.element,
    fcp: Math.round(window.__fcp),
    cls: Number(window.__cls.toFixed(3)),
  }));
  await context.close();
  return { ...result, bytes };
}

const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const path of PAGES) {
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) runs.push(await measure(path));
  const kb = (value) => Math.round(value / 1024);
  console.log(
    `${path.padEnd(16)} LCP ${runs.map((run) => run.lcp).join(" / ")} ms → median ${median(runs.map((run) => run.lcp))} ms` +
      `  [${runs.at(-1).element}]  FCP ${median(runs.map((run) => run.fcp))} ms  CLS ${Math.max(...runs.map((run) => run.cls))}` +
      `  JS ${kb(runs.at(-1).bytes.Script)} KB  fonts ${kb(runs.at(-1).bytes.Font)} KB  images ${kb(runs.at(-1).bytes.Image)} KB  total ${kb(runs.at(-1).bytes.total)} KB`,
  );
}
await browser.close();
