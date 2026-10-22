# Shared helpers for the Cloud Shell scripts in infra/. Source it; needs ENV_NAME and cwd = infra/terraform.

set_tfvar() { # set_tfvar <key> <value> inside the ${ENV_NAME} block of terraform.tfvars
  python3 - "$ENV_NAME" "$1" "$2" <<'PY'
import re, sys
env, key, val = sys.argv[1:]
s = open("terraform.tfvars").read()
m = re.search(r'(^\s*' + re.escape(env) + r'\s*=\s*\{)(.*?)(^\s*\})', s, re.S | re.M)
if not m:
    sys.exit(f"!! No '{env}' block in terraform.tfvars")
body = m.group(2)
line = re.compile(r'^(\s*)' + re.escape(key) + r'\s*=.*$', re.M)
if line.search(body):
    body = line.sub(lambda x: f'{x.group(1)}{key} = {val}', body, count=1)
else:
    body = body.rstrip("\n") + f"\n    {key} = {val}\n"
open("terraform.tfvars", "w").write(s[:m.start(2)] + body + s[m.end(2):])
PY
}
