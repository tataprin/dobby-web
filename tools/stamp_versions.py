"""Give every website script and stylesheet an address that changes with its content.

GitHub Pages lets browsers keep each file for 10 minutes. Without this, a browser can load a new page file next to an
old cached copy of a file it imports, and the page breaks ("does not provide an export named ...").

This rewrites the block between the stamp markers in docs/index.html:
  - the stylesheet link gets ?v=<content hash>
  - an import map sends every module under docs/js to ./js/<file>.js?v=<content hash>
  - the app starts from an inline module, so app.js itself also goes through the import map (one instance of app.js
    even in browsers without import maps: there every address is simply unversioned, as before)

Run it after changing anything in docs/, before committing:
    python tools/stamp_versions.py           rewrite docs/index.html
    python tools/stamp_versions.py --check   exit 1 if docs/index.html is out of date
"""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
INDEX = DOCS / "index.html"
BEGIN = "<!-- stamp:begin"
END = "<!-- stamp:end -->"


def file_hash(path):
    # hash the text with LF line endings, so a Windows checkout and the committed file give the same value
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()[:10]


def rel(path):
    return "./" + path.relative_to(DOCS).as_posix()


def build_block(indent="  "):
    modules = sorted(p for p in (DOCS / "js").rglob("*.js") if p.is_file())
    css = DOCS / "css" / "app.css"
    imports = {rel(p): "%s?v=%s" % (rel(p), file_hash(p)) for p in modules}
    body = ",\n".join('%s  %s: %s' % (indent, json.dumps(k), json.dumps(v)) for k, v in imports.items())
    lines = [
        indent + BEGIN + " (written by tools/stamp_versions.py: do not edit by hand) -->",
        indent + '<link rel="stylesheet" href="css/app.css?v=%s">' % file_hash(css),
        indent + '<script type="importmap">',
        indent + '{ "imports": {',
        body,
        indent + "} }",
        indent + "</script>",
        indent + '<script type="module">import \'./js/app.js\';</script>',
        indent + END,
    ]
    return "\n".join(lines)


def stamped(text):
    pattern = re.compile(r"[ \t]*" + re.escape(BEGIN) + r".*?" + re.escape(END), re.S)
    if not pattern.search(text):
        raise SystemExit("docs/index.html has no stamp markers")
    return pattern.sub(lambda m: build_block(), text, count=1)


def main(argv):
    raw = INDEX.read_bytes().decode("utf-8")
    crlf = "\r\n" in raw
    text = raw.replace("\r\n", "\n")
    new = stamped(text)
    if "--check" in argv:
        if new != text:
            print("docs/index.html is out of date: run python tools/stamp_versions.py")
            return 1
        print("docs/index.html is up to date")
        return 0
    if new != text:
        INDEX.write_bytes((new.replace("\n", "\r\n") if crlf else new).encode("utf-8"))
        print("docs/index.html updated")
    else:
        print("docs/index.html already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
