#!/usr/bin/env python3
"""Probe: run the same flow as the web UI for a product URL. Usage: probe.py URL [BASE]"""
import sys, json, urllib.request, urllib.parse, time
BASE = sys.argv[2] if len(sys.argv) > 2 else "https://bf-price-check.tm-deal-lab.workers.dev"
def get(path):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE + path, headers={"user-agent": "probe"}), timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            try: return json.load(e)
            except Exception: pass
        except Exception as e: time.sleep(2)
    return {"error": "fail"}
u = sys.argv[1]
c = get("/api/check?url=" + urllib.parse.quote(u, safe=""))
cur = c.get("current", {})
canon = c.get("canonical")
out = {"url": u, "status": cur.get("status"), "price": cur.get("price"), "was": cur.get("was"), "ccy": cur.get("currency"), "checks": len((c.get("history") or {}).get("checks", []))}
if canon:
    q = urllib.parse.quote
    a = get("/api/archive?url=" + q(canon, safe="") + "&orig=" + q(u, safe=""))
    out["captures_6mo"] = a.get("captures_6mo"); out["sampled"] = a.get("sampled"); out["arch_status"] = a.get("status") or a.get("error")
    for s_ in a.get("pending", []):
        r_=get(f"/api/snap?url={q(canon, safe='')}&ts={s_['ts']}&orig={q(s_['orig'], safe='')}")
        out.setdefault("snapmsgs", []).append((s_["ts"][:8], r_.get("status"), r_.get("message"), r_.get("price")))
    c2 = get("/api/check?url=" + q(u, safe=""))
    h = c2.get("history") or {}
    ccy = (c2.get("current") or {}).get("currency")
    sn = [(x["ts"][:8], x["price"], x.get("was")) for x in h.get("archive", []) if x.get("price") and (ccy is None or x.get("currency") == ccy)]
    ck = [(x.get("t") or x.get("ts"), x["price"], x.get("was")) for x in h.get("checks", []) if (ccy is None or x.get("currency") == ccy)]
    out["archive_failed"] = h.get("archive_failed"); out["snap_pts"] = len(sn); out["check_pts"] = len(ck); out["series"] = sn
print(json.dumps(out))
