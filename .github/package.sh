#!/bin/sh
# Package interface/ as a release, in the files the recorder and the
# registry look for:
#
#   <id>-<version>.zip           one folder, <id>-<version>/, holding
#                                interface/'s files (hidden ones left out)
#   <id>-<version>-<file name>   each screenshot interface.json lists, again on
#                                its own, so the store can show it
#   SHA256SUMS                   every file's checksum
#
# The release workflow runs it; you can too, to see what a release will hold:
#
#   .github/package.sh               # into dist/
#   .github/package.sh v0.1.0        # and check the tag is v<version>
#   OUT=/tmp/x .github/package.sh    # somewhere else (a new or empty folder)
#
# It checks interface.json first, as the recorder and the registry will. The
# zip is the same every time for the same files: sorted, with fixed times and
# permissions. Needs only sh and python3.
set -eu
cd "$(dirname "$0")/.."
exec python3 - "${OUT:-dist}" "${1:-}" <<'PY'
import hashlib, json, os, re, shutil, sys, zipfile
from pathlib import Path

SRC = Path("interface")
out, tag = Path(sys.argv[1]), sys.argv[2]
# The recorder's limits (docs/interfaces/publishing.md).
MAX_SCREENSHOTS, MAX_SCREENSHOT = 6, 2 << 20
IMAGES = {"png", "jpg", "jpeg", "webp"}
# The time of every file in the zip: fixed, so the same files make the same zip.
WHEN = (2020, 1, 1, 0, 0, 0)


def fail(msg):
    # ::error:: shows on the workflow run's page; it's harmless in a terminal.
    sys.exit(f"::error::{msg}")


def warn(msg):
    print(f"::warning::{msg}", file=sys.stderr)


try:
    m = json.loads((SRC / "interface.json").read_text())
except OSError:
    fail(f"{SRC}/interface.json is missing")
except ValueError as e:
    fail(f"{SRC}/interface.json isn't readable JSON ({e})")
if not isinstance(m, dict):
    fail(f"{SRC}/interface.json should be a JSON object")
if not (SRC / "index.html").is_file():
    fail(f"{SRC}/index.html is missing: it's the page the interface opens on")

id, version = m.get("id"), m.get("version")
if not isinstance(id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", id):
    fail(f"interface.json: id {id!r}: lowercase letters, digits and -, not starting with -, up to 64")
if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", version):
    fail(f"interface.json: version {version!r}: semver, like 1.0.0")
if tag and tag != f"v{version}":
    fail(f"the tag is {tag}, but interface.json's version is {version}: tag v{version}, or change the version")
if not isinstance(m.get("name"), str) or not m["name"].strip():
    fail("interface.json: name is empty")
if m.get("api") != 1:
    fail(f"interface.json: api {m.get('api')!r}: the interface API is 1")
if m.get("access", "listen") not in ("listen", "control"):
    fail("interface.json: access is listen or control")
for k in ("description", "license"):
    if not m.get(k):
        warn(f"interface.json has no {k}: the registry needs one to list it")

# Screenshots: files in the folder, of a type the store shows, small enough,
# each with a file name of its own (it's released under that name).
shots = m.get("screenshots") or []
if not isinstance(shots, list) or not all(isinstance(s, dict) for s in shots):
    fail('interface.json: screenshots is a list of { "path", "caption" }')
if len(shots) > MAX_SCREENSHOTS:
    fail(f"interface.json: at most {MAX_SCREENSHOTS} screenshots")
names = {}
for s in shots:
    path = s.get("path")
    parts = path.split("/") if isinstance(path, str) else [""]
    if not path or path.startswith("/") or "\\" in path or any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        fail(f"interface.json: screenshot {path!r}: a path in {SRC}/ like screenshots/main.png (no leading /, no .., nothing hidden)")
    if "." not in parts[-1] or parts[-1].rsplit(".", 1)[1].lower() not in IMAGES:
        fail(f"interface.json: screenshot {path}: a .png, .jpg or .webp")
    if not isinstance(s.get("caption", ""), str):
        fail(f"interface.json: screenshot {path}: its caption should be text")
    f = SRC / path
    if f.is_symlink() or not f.is_file():
        fail(f"interface.json: screenshot {path} isn't a file in {SRC}/")
    if f.stat().st_size > MAX_SCREENSHOT:
        fail(f"{SRC}/{path}: over {MAX_SCREENSHOT >> 20} MB; the store won't show it")
    if parts[-1] in names:
        fail(f"interface.json: screenshots {names[parts[-1]]} and {path} have the same file name; each is released under its own")
    names[parts[-1]] = path

# The files: everything but hidden ones (.DS_Store, .git…), which aren't served.
files = []
for dir, dirs, found in os.walk(SRC):
    dirs[:] = sorted(d for d in dirs if not d.startswith("."))
    for n in dirs + found:
        f = Path(dir) / n
        if f.is_symlink() and not n.startswith("."):
            fail(f"{f} is a symbolic link; the recorder refuses them")
    files += [(Path(dir) / n).relative_to(SRC).as_posix() for n in found if not n.startswith(".")]
files.sort()
for reserved in ("api", "calls"):
    if any(f.split("/")[0] == reserved for f in files):
        fail(f"{SRC}/{reserved}/: /{reserved}/ is the recorder's, so nothing there would be served")

# dist/ is this script's to empty; anywhere else must be new or empty.
if out.is_dir() and any(out.iterdir()):
    if out != Path("dist"):
        fail(f"{out} isn't empty: package into a new or empty folder")
    for old in out.iterdir():
        shutil.rmtree(old) if old.is_dir() else old.unlink()
out.mkdir(parents=True, exist_ok=True)

top = f"{id}-{version}"
zip_name = f"{top}.zip"
with zipfile.ZipFile(out / zip_name, "w") as z:
    for f in files:
        info = zipfile.ZipInfo(f"{top}/{f}", WHEN)
        info.create_system = 3  # Unix, so the permissions are read
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, (SRC / f).read_bytes(), compresslevel=9)
made = [zip_name]
for s in shots:
    name = f"{top}-{s['path'].rsplit('/', 1)[-1]}"
    (out / name).write_bytes((SRC / s["path"]).read_bytes())
    made.append(name)

sums = "".join(f"{hashlib.sha256((out / n).read_bytes()).hexdigest()}  {n}\n" for n in sorted(made))
(out / "SHA256SUMS").write_text(sums)
print(f"{out}/{zip_name}: {len(files)} files, {len(shots)} screenshot{'' if len(shots) == 1 else 's'}")
print(sums, end="")
PY
