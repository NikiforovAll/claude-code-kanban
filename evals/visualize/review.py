import importlib.util
import json
import os
import sys
from pathlib import Path


def find_viewer():
    if os.environ.get("SKILL_CREATOR_VIEWER"):
        return Path(os.environ["SKILL_CREATOR_VIEWER"])
    found = sorted(Path.home().glob(".claude/**/skill-creator/eval-viewer/generate_review.py"))
    if not found:
        sys.exit("skill-creator's generate_review.py not found: install the skill-creator skill or set SKILL_CREATOR_VIEWER")
    return found[0]


VIEWER = find_viewer()

# The review is about the look of each page, so the viewer shows the prompt, the screenshots, the previous
# iteration's screenshots (with --previous-workspace) and the feedback box only.
HIDE = "<style>#grades-section,#view-tabs,#panel-benchmark{display:none!important}</style>"

# generate_review.py embeds run data with json.dumps inside a <script>; a page that contains
# </script> ends that script early. Escaping "</" keeps the JSON valid and the script intact.
_dumps = json.dumps


def safe_dumps(obj, *args, **kwargs):
    out = _dumps(obj, *args, **kwargs)
    return out.replace("</", "<\\/") if not args and not kwargs else out


json.dumps = safe_dumps

spec = importlib.util.spec_from_file_location("generate_review", VIEWER)
viewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewer)

_build_run = viewer.build_run
_generate_html = viewer.generate_html


def build_run(root, run_dir):
    run = _build_run(root, run_dir)
    if run:
        run["outputs"] = [o for o in run["outputs"] if o["name"].endswith((".png", ".jpg"))]
        run["grading"] = None
    return run


def generate_html(*args, **kwargs):
    return _generate_html(*args, **kwargs).replace("</head>", f"{HIDE}</head>", 1)


viewer.build_run = build_run
viewer.generate_html = generate_html
sys.argv = [str(VIEWER), *sys.argv[1:]]
viewer.main()
