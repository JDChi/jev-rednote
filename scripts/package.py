import argparse
import json
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
EXTENSION_FILES = (
    "manifest.json",
    "background.js",
    "comment-responses.js",
    "jev.js",
    "score-cache.js",
    "comments.js",
    "content.js",
    "content.css",
    "options.html",
    "options.js",
    "options.css",
    "icons/icon-16.png",
    "icons/icon-24.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
)


def main():
    parser = argparse.ArgumentParser(description="Build the unpacked Chrome extension ZIP.")
    parser.add_argument("--tag", help="Require the Git tag to match the manifest version.")
    args = parser.parse_args()

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", version):
        parser.error("manifest.json must contain a numeric Chrome extension version")

    tag = f"v{version}"
    if args.tag is not None and args.tag != tag:
        parser.error(f"tag {args.tag} does not match manifest version {tag}")

    output = ROOT / "dist" / f"jev-rednote-{tag}.zip"
    output.parent.mkdir(exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as temp_dir:
        archive = Path(temp_dir) / output.name
        with ZipFile(archive, "w", compression=ZIP_DEFLATED) as package:
            for name in EXTENSION_FILES:
                package.write(ROOT / name, arcname=name)
        archive.replace(output)

    print(output.relative_to(ROOT))


if __name__ == "__main__":
    main()
