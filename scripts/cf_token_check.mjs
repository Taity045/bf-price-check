// Shows what the Cloudflare API token can do, without printing the token.
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Writes d1_edit=true|false to $GITHUB_OUTPUT
// and a table to $GITHUB_STEP_SUMMARY when run in GitHub Actions. Every call is read-only.
import { appendFileSync } from "node:fs";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN, ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const ZONE = process.env.CF_ZONE || "veldwire.com";
const DB_ID = process.env.CF_D1_ID || "65e86f16-42db-4c07-bbd7-20ba0308d47e";
if (!TOKEN || !ACCOUNT) { console.log("CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set; skipping the token check."); process.exit(0); }

async function cf(path, init = {}) {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4" + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d.success !== false, status: r.status, d };
  } catch (e) { return { ok: false, status: String(e), d: {} }; }
}

const rows = [];
const row = (permission, ok, needed) => rows.push({ permission, ok, needed });

let v = await cf(`/accounts/${ACCOUNT}/tokens/verify`);
if (!v.ok) v = await cf("/user/tokens/verify");
row("Token is active", v.ok && v.d.result?.status === "active", "everything");
const expires = v.d.result?.expires_on || null;

row("Account > Workers Scripts (read/edit)", (await cf(`/accounts/${ACCOUNT}/workers/scripts`)).ok, "wrangler deploy");
const d1Read = (await cf(`/accounts/${ACCOUNT}/d1/database/${DB_ID}`)).ok;
row("Account > D1 (read)", d1Read, "wrangler d1 info / list");
// A read-only SELECT through the query endpoint needs D1 Edit.
const d1Edit = (await cf(`/accounts/${ACCOUNT}/d1/database/${DB_ID}/query`, { method: "POST", body: JSON.stringify({ sql: "SELECT 1 AS ok" }) })).ok;
row("Account > D1 Edit", d1Edit, "wrangler d1 execute / migrations apply --remote");
row("Account > Workers custom domains (read)", (await cf(`/accounts/${ACCOUNT}/workers/domains`)).ok, "custom domain on deploy");

const z = await cf(`/zones?name=${encodeURIComponent(ZONE)}`);
const zone = z.ok && z.d.result?.[0];
row(`Zone > Zone Read (${ZONE})`, !!zone, "custom domain / routes");
if (zone) {
  row(`Zone > Workers Routes (${ZONE})`, (await cf(`/zones/${zone.id}/workers/routes`)).ok, "custom domain / routes");
  row(`Zone > DNS Read (${ZONE})`, (await cf(`/zones/${zone.id}/dns_records?per_page=1`)).ok, "optional: check DNS records");
  row(`Zone > Email Routing Read (${ZONE})`, (await cf(`/zones/${zone.id}/email/routing`)).ok, "optional: check email sending setup");
}

const lines = [`Cloudflare token check (account ${ACCOUNT.slice(0, 6)}…, zone ${ZONE})${expires ? `, token expires ${expires}` : ""}`, ""];
lines.push("| Permission | Granted | Needed for |", "|---|---|---|");
for (const r of rows) lines.push(`| ${r.permission} | ${r.ok ? "yes" : "**no**"} | ${r.needed} |`);
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### " + lines.join("\n") + "\n");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `d1_edit=${d1Edit}\n`);
