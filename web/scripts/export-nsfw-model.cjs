// Exports nsfwjs's bundled MobileNetV2 (browserify shards) to static files under public/models
// so the browser can load it by URL (webpack can't parse the shard bundles).
const fs = require("fs"), path = require("path");
const d = path.join(__dirname, "../node_modules/nsfwjs/dist/models/mobilenet_v2/");
const out = path.join(__dirname, "../public/models/nsfw/mobilenet_v2");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "model.json"), JSON.stringify(require(d + "model.min.js")));
fs.writeFileSync(path.join(out, "group1-shard1of1"), Buffer.from(require(d + "group1-shard1of1.min.js"), "base64"));
console.log("exported to", out);
