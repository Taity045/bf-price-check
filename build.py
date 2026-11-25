#!/usr/bin/env python3
"""Build dist/worker.js (HTML inlined) and deploy_exec.js (Cloudflare MCP 'execute' payload)."""
import json, pathlib
root = pathlib.Path(__file__).parent
html = (root / "public/index.html").read_text()
examples = json.loads((root / "examples.json").read_text()) if (root / "examples.json").exists() else []
html = html.replace("/*EXAMPLES*/[]", json.dumps(examples))
import base64, hashlib, re, subprocess
TARGETS = "--target=chrome70,safari12,firefox68,edge79"
def esbuild(code, loader):
    """Minify and lower modern syntax for older browsers. Falls back to the source if esbuild is not available."""
    try:
        r = subprocess.run(["npx", "--yes", "esbuild@0.24.0", f"--loader={loader}", "--minify", TARGETS, "--log-level=error"], input=code, capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
        print("esbuild failed:", r.stderr[:300])
    except Exception as e:
        print("esbuild not available:", e)
    return code
m = re.search(r"<script>([\s\S]*)</script>", html)
APP_JS = esbuild(m.group(1), "js")
app_name = "app." + hashlib.sha1(APP_JS.encode()).hexdigest()[:10] + ".js"
html = html[:m.start()] + f'<script src="/{app_name}" defer></script>' + html[m.end():]
m = re.search(r"<style>([\s\S]*?)</style>", html)
html = html[:m.start(1)] + esbuild(m.group(1), "css") + html[m.end(1):]
fonts = {}
for f in sorted((root / "public/fonts").glob("*.woff2")):
    data = f.read_bytes(); h = hashlib.sha1(data).hexdigest()[:10]
    hashed = f"{f.stem}.{h}.woff2"
    fonts[hashed] = base64.b64encode(data).decode()
    html = html.replace(f"/fonts/{f.name}", f"/fonts/{hashed}")
font = (root / "src/og_font.js").read_text().replace("export const OG_FONT", "const OG_FONT")
static = {n: base64.b64encode((root / "public" / n).read_bytes()).decode() for n in ["og-home.png", "og-home.jpg", "og-square.jpg"]}
worker = "const STATIC_IMG = " + json.dumps(static) + ";\nconst FONTS = " + json.dumps(fonts) + ";\nconst APP = " + json.dumps({"name": app_name, "js": APP_JS}) + ";\n" + (root / "src/shops.js").read_text() + "\n" + (root / "src/worker.js").read_text() + "\n" + (root / "src/readers.js").read_text() + "\n" + (root / "src/features.js").read_text() + "\n" + (root / "src/daily.js").read_text() + "\n" + (root / "src/compare.js").read_text() + "\n" + (root / "src/og.js").read_text() + "\n" + (root / "src/stats.js").read_text() + "\n" + font + "\nconst HTML = " + json.dumps(html) + ";\n"
(root / "dist").mkdir(exist_ok=True)
(root / "dist/worker.js").write_text(worker)
schema = (root / "schema.sql").read_text()
DB_ID = "65e86f16-42db-4c07-bbd7-20ba0308d47e"
NAME = "bf-price-check"
exec_js = f"""async () => {{
  const name = {json.dumps(NAME)};
  const dbId = {json.dumps(DB_ID)};
  const migration = await cloudflare.request({{ method: "POST", path: `/accounts/${{accountId}}/d1/database/${{dbId}}/query`, body: {{ sql: {json.dumps(schema)} }} }});
  if (!migration.success || migration.result?.some(statement => statement.success === false)) throw new Error("D1 schema update failed");
  const code = {json.dumps(worker)};
  const metadata = {{ main_module: "worker.js", compatibility_date: "2026-11-01", bindings: [{{ type: "d1", name: "DB", id: dbId }}] }};
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], {{ type: "application/json" }}));
  form.append("worker.js", new Blob([code], {{ type: "application/javascript+module" }}), "worker.js");
  const put = await cloudflare.request({{ method: "PUT", path: `/accounts/${{accountId}}/workers/scripts/${{name}}`, body: form }});
  if (!put.success) throw new Error("Worker upload failed");
  const sub = await cloudflare.request({{ method: "POST", path: `/accounts/${{accountId}}/workers/scripts/${{name}}/subdomain`, body: {{ enabled: true, previews_enabled: false }} }});
  const cron = await cloudflare.request({{ method: "PUT", path: `/accounts/${{accountId}}/workers/scripts/${{name}}/schedules`, body: [{{ cron: "* * * * *" }}] }});
  return {{ ok: sub.success && cron.success, size: code.length, subdomain: sub.result, schedules: cron.result }};
}}
"""
(root / "deploy_exec.js").write_text(exec_js)
print("html bytes", len(html)); print("worker bytes", len(worker))
