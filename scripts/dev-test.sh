#!/usr/bin/env bash
# Local test server without the Workers AI binding (it needs a Cloudflare login).
# Printout reading uses canned answers instead (CONFIG_READ_MOCK, see worker/configread.js).
set -e
cd "$(dirname "$0")/.."
node -e '
const fs = require("fs");
const s = fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*"ai":.*$/m, "");
fs.writeFileSync(".wrangler-test.jsonc", s);
'
MOCK='{"cfg.jpg":"{\"is_config\": true, \"model\": \"TE310\", \"firmware\": \"A2.15.125 EZD\", \"serial\": \"NEWSN-CFG\", \"date\": \"2026/11/21\", \"non_reset_m\": 10304, \"reset_m\": 512, \"bad_dot\": 43}","other.jpg":"{\"is_config\": true, \"serial\": \"OTHER123\", \"non_reset_m\": 99, \"reset_m\": 99}","default":"{\"is_config\": false}"}'
exec npx wrangler dev -c .wrangler-test.jsonc --port "${PORT:-8787}" --var "CONFIG_READ_MOCK:$MOCK" "$@"
