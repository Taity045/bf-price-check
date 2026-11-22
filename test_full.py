#!/usr/bin/env python3
"""End-to-end API test: /api/check then every pending /api/snap. Usage: test_full.py URL [URL...]"""
import sys, json, urllib.parse, urllib.request, concurrent.futures as cf
B = "https://bf-price-check.tm-deal-lab.workers.dev"
def get(path):
    req = urllib.request.Request(B + path, headers={"user-agent": "bf-test"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)
    except urllib.error.HTTPError as e: return json.load(e)
out = []
for u in sys.argv[1:]:
    d = get("/api/check?url=" + urllib.parse.quote(u, safe="") + ("&fresh=1" if __import__("os").environ.get("FRESH") else ""))
    if "error" in d: print(u, "ERROR", d["error"]); out.append({"url": u, "error": d["error"]}); continue
    c = d["current"]
    a = get("/api/archive?url=" + urllib.parse.quote(d["canonical"], safe="") + "&orig=" + urllib.parse.quote(d["url"], safe=""))
    if "error" in a: a = {"status": "error", "message": a["error"], "captures_6mo": 0, "sampled": 0, "pending": []}
    def snap(s): return get(f"/api/snap?url={urllib.parse.quote(d['canonical'],safe='')}&ts={s['ts']}&orig={urllib.parse.quote(s['orig'],safe='')}")
    with cf.ThreadPoolExecutor(3) as ex: res = list(ex.map(snap, a["pending"]))
    pts = [(h["ts"], h["price"], h.get("was"), h.get("currency")) for h in d["history"]["archive"]] + [(r["ts"], r.get("price"), r.get("was"), r.get("currency")) for r in res if r.get("status") == "ok"]
    st = {}
    for r in res: st[r.get("status")] = st.get(r.get("status"), 0) + 1
    rec = {"url": u, "live_status": c["status"], "price": c.get("price"), "was": c.get("was"), "currency": c.get("currency"), "source": c.get("source"), "message": c.get("message"),
           "title": (c.get("title") or "")[:60], "archive_status": a["status"], "archive_msg": a.get("message"), "captures_6mo": a["captures_6mo"], "sampled": a["sampled"], "snap_results": st, "archive_points": sorted(pts)}
    out.append(rec)
    print(json.dumps(rec, ensure_ascii=False))
json.dump(out, open("test_results_latest.json", "w"), indent=1, ensure_ascii=False)
