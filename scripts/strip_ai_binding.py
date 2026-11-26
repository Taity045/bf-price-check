#!/usr/bin/env python3
"""Removes the [ai] table from wrangler.toml (CI fallback deploy without Workers AI). Nothing else changes."""
import re, sys
p = sys.argv[1] if len(sys.argv) > 1 else "wrangler.toml"
s = open(p).read()
s2 = re.sub(r"(?m)^\[ai\]\n(?:[^\[\n].*\n|\n)*?(?=^\[|\Z)", "", s)
if s2 == s: print("no [ai] binding found"); sys.exit(0)
open(p, "w").write(s2)
print("removed the [ai] binding")
