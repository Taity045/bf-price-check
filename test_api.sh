#!/bin/bash
# usage: ./test_api.sh URL  -> prints summary of /api/check
set -eo pipefail
B=${BASE_URL:-https://bf-price-check.lala-board.workers.dev}
product_url=${1:?Pass a product URL}
encoded=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$product_url")
curl -sS --fail-with-body --max-time 90 "$B/api/check?url=$encoded${2:-}" | python3 -c '
import sys,json
d=json.load(sys.stdin)
if "error" in d: sys.exit(d["error"])
c=d["current"]; history=d["history"]
print(d["host"],"| status:",c["status"],"| price:",c.get("price"),"was:",c.get("was"),c.get("currency"),"| src:",c.get("source"),"| msg:",c.get("message"))
print("   title:",(c.get("title") or "")[:70])
print("   stored archive pts:",len(history["archive"]),"checks:",len(history["checks"]))
'
