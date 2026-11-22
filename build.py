#!/usr/bin/env python3
"""Build dist/worker.js (HTML inlined) and deploy_exec.js (Cloudflare MCP 'execute' payload)."""
import json, pathlib
root = pathlib.Path(__file__).parent
html = (root / "public/index.html").read_text()
examples = json.loads((root / "examples.json").read_text()) if (root / "examples.json").exists() else []
html = html.replace("/*EXAMPLES*/[]", json.dumps(examples))
worker = (root / "src/worker.js").read_text() + "\nconst HTML = " + json.dumps(html) + ";\n"
(root / "dist").mkdir(exist_ok=True)
(root / "dist/worker.js").write_text(worker)
schema = (root / "schema.sql").read_text().replace("DROP TABLE IF EXISTS tracked;\n", "")
DB_ID = "65e86f16-42db-4c07-bbd7-20ba0308d47e"
NAME = "bf-price-check"
exec_js = f"""async () => {{
  const name = {json.dumps(NAME)};
  const dbId = {json.dumps(DB_ID)};
  await cloudflare.request({{ method: "POST", path: `/accounts/${{accountId}}/d1/database/${{dbId}}/query`, body: {{ sql: {json.dumps(schema)} }} }});
  const code = {json.dumps(worker)};
  const metadata = {{ main_module: "worker.js", compatibility_date: "2026-11-01", bindings: [{{ type: "d1", name: "DB", id: dbId }}] }};
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], {{ type: "application/json" }}));
  form.append("worker.js", new Blob([code], {{ type: "application/javascript+module" }}), "worker.js");
  const put = await cloudflare.request({{ method: "PUT", path: `/accounts/${{accountId}}/workers/scripts/${{name}}`, body: form }});
  const sub = await cloudflare.request({{ method: "POST", path: `/accounts/${{accountId}}/workers/scripts/${{name}}/subdomain`, body: {{ enabled: true, previews_enabled: false }} }});
  const cron = await cloudflare.request({{ method: "PUT", path: `/accounts/${{accountId}}/workers/scripts/${{name}}/schedules`, body: [{{ cron: "15 * * * *" }}] }});
  return {{ ok: put.success, size: code.length, subdomain: sub.result, schedules: cron.result }};
}}
"""
(root / "deploy_exec.js").write_text(exec_js)
print("worker bytes", len(worker))
