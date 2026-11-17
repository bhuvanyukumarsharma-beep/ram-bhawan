#!/usr/bin/env python3
"""Builds the download package for the owner.

    python3 package/build.py                 build everything (database file, app, helper, guide) and zip it
    python3 package/build.py --no-build      reuse the app and database file that are already built
    python3 package/build.py --shots DIR     also put screenshots from DIR into the guide

Result: package/out/ram-bhawan/ (the folder) and package/out/ram-bhawan-app.zip
"""
import argparse, base64, io, json, re, shutil, subprocess, sys, zipfile
from pathlib import Path
import markdown

ROOT = Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / 'package'
OUT = PKG_DIR / 'out'
FOLDER = OUT / 'ram-bhawan'

def run(cmd, cwd):
    print('>', ' '.join(cmd)); subprocess.run(cmd, cwd=cwd, check=True)

def js_embed(text):
    """Text -> a JavaScript string literal that is safe inside a <script> tag."""
    return json.dumps(text).replace('</', '<\\/').replace('<!--', '<\\!--')

def site_files(dist: Path):
    files = {}
    for f in sorted(dist.rglob('*')):
        if f.is_file() and f.suffix != '.map':
            files[f.relative_to(dist).as_posix()] = f.read_bytes()
    assert 'index.html' in files and 'config.js' in files, 'the app has not been built'
    return files

# --------------------------------------------------------------------- guide
SHOTS = [('owner-02-rooms.png', 'Your rooms. Green is paid, amber is due soon, red is overdue.'),
         ('owner-03-room102.png', 'One room: what is unpaid, with the late interest.'),
         ('owner-10-inbox.png', 'Your inbox: payments to confirm, readings, requests.'),
         ('tenant-01-home.png', 'What a tenant sees: only their own account.'),
         ('owner-06-receipt.png', 'A receipt, made automatically.')]

def screenshots_html(shots_dir: Path | None):
    if not shots_dir:
        return ''
    from PIL import Image
    figs = []
    for name, caption in SHOTS:
        p = shots_dir / name
        if not p.exists():
            continue
        im = Image.open(p).convert('RGB')
        im = im.resize((int(im.width * 0.8), int(im.height * 0.8)), Image.LANCZOS)
        buf = io.BytesIO(); im.save(buf, 'JPEG', quality=82, optimize=True)
        figs.append(f'<figure><img alt="{caption}" src="data:image/jpeg;base64,{base64.b64encode(buf.getvalue()).decode()}"><figcaption>{caption}</figcaption></figure>')
    if not figs:
        return ''
    return '<h3>A quick look (with made-up example tenants)</h3><div class="shots">' + ''.join(figs) + '</div>'

def build_guide(shots_dir):
    text = (ROOT / 'GUIDE.md').read_text(encoding='utf-8')
    # "superfences" (instead of the plain fenced_code in "extra") lets a code block sit inside a numbered step or a note
    md = markdown.Markdown(extensions=['tables', 'attr_list', 'md_in_html', 'def_list', 'abbr', 'footnotes', 'pymdownx.superfences', 'toc', 'sane_lists', 'admonition', 'pymdownx.details'],
                           extension_configs={'toc': {'toc_depth': '2'}})
    body = md.convert(text)
    body = body.replace('<!-- SCREENSHOTS -->', screenshots_html(shots_dir))
    steps = [t for t in md.toc_tokens[0]['children']] if md.toc_tokens and md.toc_tokens[0].get('children') else []
    # contents list: every "Step N." heading, in order
    lis = ''.join(f'<li><a href="#{t["id"]}">{t["name"]}</a></li>' for t in steps if t['name'].startswith('Step '))
    toc = f'<nav class="toc"><p><b>The steps</b></p><ol>{lis}</ol></nav>' if lis else ''
    # put the contents list right after the "Before you start" table of steps: simplest is after the first table
    html = (PKG_DIR / 'guide.template.html').read_text(encoding='utf-8')
    return html.replace('__TOC__', '').replace('__BODY__', body.replace('<h2 id="before-you-start">', toc + '<h2 id="before-you-start">', 1) if toc else body)

# --------------------------------------------------------------------- helper
def build_helper(files):
    tpl = (PKG_DIR / 'helper.template.html').read_text(encoding='utf-8')
    schedule = helper_schedule((ROOT / 'supabase' / 'schedule.sql').read_text(encoding='utf-8'))
    site = {k: base64.b64encode(v).decode() for k, v in files.items()}
    assert '__SCHEDULE_SQL__' in tpl and '__SITE_FILES__' in tpl
    return tpl.replace('__SCHEDULE_SQL__', js_embed(schedule)).replace('__SITE_FILES__', json.dumps(site))

def helper_schedule(schedule):
    """The long comment at the top of schedule.sql explains how to fill it in by hand. The helper fills it in
    for the owner, so what he copies gets a one-line heading instead (and no placeholder words are left in it)."""
    body = re.sub(r'\A(?:--[^\n]*\n)+', '', schedule)
    assert 'YOUR-PROJECT-REF' in body and body.count('YOUR-CRON-SECRET') == 1 and body.count('YOUR-PUBLIC-KEY') == 2, 'schedule.sql changed shape'
    return '-- Ram Bhawan: the daily clock for your project, filled in by the setup helper. Paste ALL of it and press Run (guide, Step 7).\n' + body

DEV_README = """# For developers

This folder is the full source of the Ram Bhawan app. You do not need it to use the app.

- `app/` is the website (React + TypeScript + Vite). `npm install && npm run build` makes `app/dist`.
- `supabase/sql/` holds the database in numbered parts. `./build.sh` joins them into `supabase/setup.sql`.
- `supabase/functions/notify/index.ts` is the delivery function (Web Push and Gmail).
- `supabase/schedule.sql` is the daily clock (pg_cron and pg_net).
- `package/` builds the download: `python3 package/build.py`.
- `tests/` has the test suites. They need Node 22 and a local PostgreSQL (see `tests/db.mjs`).
  `node ledger.test.mjs`, `node api.test.mjs`, `node webpush.test.mjs`, `node grants.test.mjs`, `node keys.test.mjs`,
  and the phone-size browser walk-throughs in `tests/ui/`.
- `GUIDE.md` is the owner's step-by-step guide.
"""

COPY_IGNORE = shutil.ignore_patterns('node_modules', 'dist', '__pycache__', 'out', '.DS_Store', '*.log')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-build', action='store_true'); ap.add_argument('--shots', type=Path)
    a = ap.parse_args()
    if not a.no_build:
        run(['./build.sh'], ROOT)
        run(['npm', 'run', 'build'], ROOT / 'app')
    shutil.rmtree(OUT, ignore_errors=True); FOLDER.mkdir(parents=True)

    files = site_files(ROOT / 'app' / 'dist')
    (FOLDER / 'setup-helper.html').write_text(build_helper(files), encoding='utf-8')
    (FOLDER / 'START-HERE.html').write_text(build_guide(a.shots), encoding='utf-8')
    shutil.copy(ROOT / 'supabase' / 'setup.sql', FOLDER / 'database.txt')
    shutil.copy(ROOT / 'supabase' / 'functions' / 'notify' / 'index.ts', FOLDER / 'notify-function.txt')
    (FOLDER / 'READ-ME-FIRST.txt').write_text('Open the file START-HERE.html (double-click it). It is the step-by-step guide.\r\n\r\nKeep this whole folder together until you have finished the guide.\r\n', encoding='utf-8')

    dev = FOLDER / 'for-developers'
    shutil.copytree(ROOT / 'app', dev / 'app', ignore=COPY_IGNORE)
    shutil.copytree(ROOT / 'supabase', dev / 'supabase', ignore=COPY_IGNORE)
    shutil.copytree(ROOT / 'tests', dev / 'tests', ignore=COPY_IGNORE)
    shutil.copytree(PKG_DIR, dev / 'package', ignore=COPY_IGNORE)
    for n in ('build.sh', 'GUIDE.md'):
        shutil.copy(ROOT / n, dev / n)
    (dev / 'README.md').write_text(DEV_README, encoding='utf-8')

    z = OUT / 'ram-bhawan-app.zip'
    with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for f in sorted(FOLDER.rglob('*')):
            if f.is_file():
                zf.write(f, 'ram-bhawan/' + f.relative_to(FOLDER).as_posix())
    print(f'built {FOLDER} ({sum(1 for _ in FOLDER.rglob("*") if _.is_file())} files) and {z} ({z.stat().st_size // 1024} KB)')

if __name__ == '__main__':
    main()
