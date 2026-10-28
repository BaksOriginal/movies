"""
tools/build.py — сборка сайта для выгрузки на GitHub Pages.

Что делает:
  1. Копирует сайт в папку _site/ (без movie_bot — он живёт на Vercel,
     и без служебных .github/ и tools/).
  2. Сжимает все .js и .css: убирает комментарии и лишние пробелы
     (rjsmin/rcssmin — только безопасное удаление, имена не меняются).
     В исходниках комментариев много, так что файлы худеют почти вдвое.
  3. Дописывает к ссылкам на свои .js/.css в HTML версию по содержимому
     файла (?v=abc123). Браузер и кэш GitHub Pages сразу берут новый файл
     после выгрузки, а не держат старый ещё ~10 минут.

Исходники в репозитории не меняются — сжатое лежит только в _site/.
Запуск локально: pip install rjsmin rcssmin && python tools/build.py
На GitHub это делает .github/workflows/deploy.yml при каждом push.
"""

import hashlib
import os
import re
import shutil
import sys

import rcssmin
import rjsmin

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "_site")
SKIP_DIRS = {"movie_bot", ".github", "tools", "_site", ".git", "node_modules", "__pycache__"}


def copy_site():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel = os.path.relpath(dirpath, ROOT)
        dirnames[:] = [d for d in dirnames if not (rel == "." and d in SKIP_DIRS) and not d.startswith(".")]
        target_dir = os.path.join(OUT, rel)
        os.makedirs(target_dir, exist_ok=True)
        for name in filenames:
            if name.startswith("."):
                continue
            shutil.copy2(os.path.join(dirpath, name), os.path.join(target_dir, name))


def minify_assets():
    saved = 0
    for dirpath, _, filenames in os.walk(OUT):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if name.endswith(".js"):
                minify = rjsmin.jsmin
            elif name.endswith(".css"):
                minify = rcssmin.cssmin
            else:
                continue
            with open(path, encoding="utf-8") as f:
                source = f.read()
            result = minify(source)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(result)
            saved += len(source.encode()) - len(result.encode())
            print(f"  {os.path.relpath(path, OUT)}: {len(source.encode()) // 1024} КБ -> {len(result.encode()) // 1024} КБ")
    print(f"Сэкономлено: {saved // 1024} КБ")


def add_versions():
    ref_re = re.compile(r'(<(?:script|link)\b[^>]*?\b(?:src|href)=")([^":?#]+\.(?:js|css))(")')
    for dirpath, _, filenames in os.walk(OUT):
        for name in filenames:
            if not name.endswith(".html"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as f:
                html = f.read()

            def versioned(m):
                asset = os.path.normpath(os.path.join(dirpath, m.group(2)))
                if not os.path.isfile(asset):
                    return m.group(0)
                with open(asset, "rb") as f:
                    digest = hashlib.sha1(f.read()).hexdigest()[:8]
                return f"{m.group(1)}{m.group(2)}?v={digest}{m.group(3)}"

            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(ref_re.sub(versioned, html))


if __name__ == "__main__":
    copy_site()
    minify_assets()
    add_versions()
    print(f"Готово: {OUT}")
    sys.exit(0)
