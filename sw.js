// 制衣 CAD: the copy of the page that works without a network (v74).
// This service worker keeps every file of this version in the browser's cache, so after the first visit the page opens at once and
// also with no network at all. A new version is fetched in the background and waits until the page is reloaded (the page offers
// that). Nothing else is stored and nothing is sent anywhere: files are only ever read from the site this page came from.
'use strict';
const VERSION = 77;
const CACHE = 'zhiyi-cad-v' + VERSION;
const SHELL = 'index.html';
// Every file of the site except this one (a test checks the list against the folder).
const FILES = [
  // FILES-START
  "agent-task.mjs", "agent-ui.mjs", "agent.css", "agent.html", "angles.mjs", "annotation-text.mjs", "app.js", "assistant-core.mjs",
  "assistant-local.mjs", "assistant-panel.mjs", "assistant-remote.mjs", "assistant.css", "bezier-cut.mjs", "cad-command-build.mjs",
  "cad-command-construct-more.mjs", "cad-command-construct.mjs", "cad-command-curves.mjs", "cad-command-darts.mjs",
  "cad-command-extract.mjs", "cad-command-grading.mjs", "cad-command-kit.mjs", "cad-command-manage.mjs", "cad-command-marks.mjs",
  "cad-command-seam-tools.mjs", "cad-command-set.mjs", "cad-command-spread.mjs", "cad-command-trim.mjs", "cad-commands.mjs",
  "constraint-snapping.mjs", "construct-edit.mjs", "construct-trim.mjs", "construct-ui.mjs", "construct.css", "construct.mjs",
  "construction-ui.mjs", "construction.mjs", "contour-heal.mjs", "contour-inspection.mjs", "curve-tools.mjs", "curves.mjs",
  "cut-spread.mjs", "dart-tools.mjs", "dart-transfer.mjs", "dart-ui.mjs", "dart.css", "dxf-aama.mjs", "dxf-splines.mjs", "dxf-ui.mjs",
  "dxf.css", "dxf.mjs", "endpoint-extend-ui.mjs", "endpoint-extend.css", "endpoint-extend.mjs", "extension-math.mjs", "fit-spline.mjs",
  "geometry.mjs", "grading-align.mjs", "grading-locks.mjs", "grading-schema.mjs", "grading-table.mjs", "grading-ui.mjs", "grading.mjs",
  "help.mjs", "hpgl-export.mjs", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "icon.svg", "index.html",
  "intersection-trim-ui.mjs", "intersection-trim.css", "intersection-trim.mjs", "intersections.mjs", "line-edit-ui.mjs", "line-edit.css",
  "line-edit.mjs", "manifest.webmanifest", "marker-pack.mjs", "marker-polygons.mjs", "marker-schema.mjs", "marker-ui.mjs",
  "marker-worker.mjs", "marker.mjs", "measure-sizes.mjs", "measure.mjs", "mirror-links.mjs", "model-service.html", "native-contact.mjs",
  "native-location.mjs", "notches.mjs", "offline.mjs", "pants-command.mjs", "pants-draft-ui.mjs", "pants-draft.css", "pants-draft.mjs",
  "pants-grading.mjs", "pants-prj-export.mjs", "pants-rule-ui.mjs", "pants-rules.mjs", "pants-set.mjs", "pants-template.mjs",
  "pants-ui.mjs", "pants.css", "path-metrics.mjs", "piece-attributes.mjs", "piece-extract.mjs", "piece-info.mjs", "piece-join.mjs",
  "piece-list-ui.mjs", "piece-merge-ui.mjs", "piece-merge.css", "piece-merge.mjs", "piece-split-ui.mjs", "piece-split.css",
  "piece-split.mjs", "plot-schema.mjs", "plot-ui.mjs", "plot.mjs", "polygon.mjs", "polynomial-roots.mjs", "position-ui.mjs",
  "position.css", "position.mjs", "precision.mjs", "prj-annotations.mjs", "prj-curves.mjs", "prj-editable-ui.mjs", "prj-editable.css",
  "prj-editable.mjs", "prj-endpoint-export.mjs", "prj-endpoint-ui.mjs", "prj-endpoint.css", "prj-grading.mjs", "prj-groups.mjs",
  "prj-import.mjs", "prj-legacy.mjs", "prj-line-export.mjs", "prj-line-ui.mjs", "prj-line.css", "prj-marks.mjs", "prj-new-export.mjs",
  "prj-new-ui.mjs", "prj-new.css", "prj-parser.mjs", "prj-references.mjs", "prj-save-ui.mjs", "prj-save.css", "prj-sizes.mjs",
  "prj-storage.mjs", "prj-text-export.mjs", "prj-v5-curves.mjs", "prj-v5-layout.mjs", "prj-v5-line-insert.mjs", "prj-v5-tail.mjs",
  "prj-v5.mjs", "prj-writeback-ui.mjs", "prj-writeback.css", "prj-writeback.mjs", "recovery-ui.mjs", "recovery.css", "recovery.mjs",
  "rule-library.mjs", "seam-check-ui.mjs", "seam-checks.mjs", "seam-corners.mjs", "seam-joints.mjs", "seam-section-ui.mjs",
  "seam-sections.mjs", "seam-widths.mjs", "seams.mjs", "selection.mjs", "shrink.mjs", "size-formula.mjs", "size-input.mjs",
  "size-series.mjs", "smart-pen-ui.mjs", "smart-pen.css", "smart-pen.mjs", "snapping.mjs", "spline.mjs", "spread-ui.mjs", "spread.css",
  "spread.mjs", "style.css", "table-text.mjs", "table-ui.mjs", "table.css", "topology.mjs", "transform-links.mjs", "unfold-ui.mjs",
  "unfold.css", "unfold.mjs", "variable-offset.mjs", "vendor/NOTICE.txt", "vendor/clipper.mjs", "view-keys.mjs", "view-options.mjs"
  // FILES-END
];
const KNOWN = new Set(FILES);

/** Where an answer comes from: null leaves the request to the browser as if there were no service worker. */
function route(href, scope, mode, method) {
  if (method && method !== 'GET') return null;
  const url = new URL(href), base = new URL(scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname.slice(base.pathname.length)); } catch { return null; }
  if (mode === 'navigate' && (path === '' || path === SHELL)) {
    // The page itself. Asked plainly (or with ?v=), the copy answers; asked with other words, as test pages ask it, the site answers
    // first and the copy only when there is no network.
    const plain = [...url.searchParams.keys()].every(key => key === 'v');
    return { key: SHELL, network: !plain };
  }
  return KNOWN.has(path) ? { key: path, network: false } : null;
}
self.ZHIYI_OFFLINE = Object.freeze({ VERSION, CACHE, FILES, route });

self.addEventListener('install', event => {
  // Fresh copies from the site, never from the browser's own cache, so that the files of one version are never mixed with another's.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(file => new Request(file, { cache: 'reload' })))));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('zhiyi-cad-v') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  else if (event.data === 'version' && event.source) event.source.postMessage({ type: 'zhiyi-offline', version: VERSION, files: FILES.length });
});
self.addEventListener('fetch', event => {
  const way = route(event.request.url, self.registration.scope, event.request.mode, event.request.method);
  if (way) event.respondWith(answer(event.request, way));
});
async function answer(request, way) {
  const cache = await caches.open(CACHE);
  if (way.network) {
    // the site first; its copy when there is no network or the site answers with an error (GitHub Pages answers 503 now and then)
    let response;
    try { response = await fetch(request); } catch (error) { const kept = await cache.match(way.key); if (kept) return kept; throw error; }
    return response.ok ? response : (await cache.match(way.key)) || response;
  }
  return (await cache.match(way.key)) || fetch(request);
}
