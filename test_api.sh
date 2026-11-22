#!/bin/bash
# usage: ./test_api.sh URL  -> prints summary of /api/check
B=https://bf-price-check.lala-board.workers.dev
curl -s --max-time 90 "$B/api/check?url=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1")$2" | python3 -c '
import sys,json
d=json.load(sys.stdin)
if "error" in d: print("ERROR",d); sys.exit()
c=d["current"]; a=d["archive"]
print(d["host"],"| status:",c["status"],"| price:",c.get("price"),"was:",c.get("was"),c.get("currency"),"| src:",c.get("source"),"| msg:",c.get("message"))
print("   title:",(c.get("title") or "")[:70])
print("   archive:",a["status"],a.get("message"),"captures:",a["captures_6mo"],"sampled:",a["sampled"],"pending:",len(a["pending"]),"| stored archive pts:",len(d["history"]["archive"]),"checks:",len(d["history"]["checks"]))
'
